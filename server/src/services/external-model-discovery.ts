import crypto from 'crypto';
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { timingSafeStringEqual } from '../lib/system-prompt.js';

// Model discovery outside the signed catalog feed.
//
// Distinct from `builtin-model-discovery.ts` (#1348), which queries a provider's
// OWN /models endpoint to fill missing catalog rows for that provider.
//
// This manages the external leads an operator or an AI agent brought from the
// wild: stealth launches, free-tier blog announcements, unlisted relay routes.
// Leads are candidate models to test; nothing here routes or enables a model.
//
// Two kinds of caller write here. The dashboard (a signed-in operator) may do
// anything. An agent, holding the dedicated discovery token, may add leads and
// change or remove only the leads it recorded: an unattended job must never be
// able to rewrite or delete what the operator wrote by hand.

export type LeadStatus = 'candidate' | 'testing' | 'verified' | 'rejected' | 'added';
export type LeadKind = 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'video';
export type LeadActor = 'user' | 'agent';

export interface ExternalLead {
  id: number;
  at: string;
  source: string;
  /** The provider the recorder named, or one derived from the source URL. */
  provider: string | null;
  modelId: string;
  displayName: string | null;
  kind: LeadKind | null;
  status: LeadStatus;
  notes: string | null;
  addedBy: LeadActor;
}

export interface ExternalLeadInput {
  source: string;
  modelId: string;
  provider?: string | null;
  displayName?: string | null;
  kind?: LeadKind | null;
  status?: LeadStatus;
  notes?: string | null;
}

export interface ExternalLeadPatch {
  provider?: string | null;
  displayName?: string | null;
  kind?: LeadKind | null;
  status?: LeadStatus;
  notes?: string | null;
}

export interface ExternalLeadQuery {
  status?: LeadStatus;
  provider?: string;
  limit?: number;
  offset?: number;
}

export type LeadWriteResult =
  | { ok: true; lead: ExternalLead }
  | { ok: false; reason: 'not_found' | 'not_yours' };

interface LeadDbRow {
  id: number;
  at: string;
  source: string;
  provider: string | null;
  model_id: string;
  display_name: string | null;
  kind: string | null;
  status: string;
  notes: string | null;
  added_by: string;
}

const LEAD_STATUSES: readonly LeadStatus[] = ['candidate', 'testing', 'verified', 'rejected', 'added'];
const LEAD_COLUMNS = 'id, at, source, provider, model_id, display_name, kind, status, notes, added_by';
const MAX_LIMIT = 200;

/**
 * A provider read off a source URL: `https://blog.anyrouter.dev/...` ->
 * `anyrouter`, `https://opencode.ai/docs/zen` -> `opencode`. A source that is
 * not a URL yields null rather than a guess from free text.
 */
export function providerFromSource(source: string): string | null {
  let host: string;
  try {
    host = new URL(source).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.replace(/^(www|blog|docs|api|console|platform)\./, '').split('.');
  return (labels.length >= 2 ? labels[labels.length - 2] : labels[0]) || null;
}

function normaliseProvider(provider: string | null | undefined): string | null {
  const trimmed = provider?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function toLead(r: LeadDbRow): ExternalLead {
  return {
    id: r.id,
    at: r.at,
    source: r.source,
    provider: r.provider ?? providerFromSource(r.source),
    modelId: r.model_id,
    displayName: r.display_name,
    kind: (r.kind as LeadKind | null) ?? null,
    status: LEAD_STATUSES.includes(r.status as LeadStatus) ? (r.status as LeadStatus) : 'candidate',
    notes: r.notes,
    addedBy: r.added_by === 'agent' ? 'agent' : 'user',
  };
}

function leadById(db: Db, id: number): LeadDbRow | undefined {
  return db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads WHERE id = ?`).get(id) as LeadDbRow | undefined;
}

export function listExternalLeads(query: ExternalLeadQuery = {}, db: Db = getDb()): {
  leads: ExternalLead[];
  total: number;
  byStatus: Record<LeadStatus, number>;
} {
  const limit = Math.min(Math.max(1, query.limit ?? 200), MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);
  const where = query.status ? 'WHERE status = ?' : '';
  const params = query.status ? [query.status] : [];

  let leads = (db.prepare(`
    SELECT ${LEAD_COLUMNS}
      FROM external_model_leads
      ${where}
     ORDER BY at DESC, id DESC
  `).all(...params) as LeadDbRow[]).map(toLead);
  // Filtered after mapping because the effective provider may be derived from
  // the source URL rather than stored.
  if (query.provider) {
    const wanted = query.provider.toLowerCase();
    leads = leads.filter(l => l.provider === wanted);
  }

  const byStatus: Record<LeadStatus, number> = { candidate: 0, testing: 0, verified: 0, rejected: 0, added: 0 };
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM external_model_leads GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  for (const c of counts) {
    if (LEAD_STATUSES.includes(c.status as LeadStatus)) byStatus[c.status as LeadStatus] = c.n;
  }

  return { leads: leads.slice(offset, offset + limit), total: leads.length, byStatus };
}

/**
 * Upsert one lead on (source, model_id), so re-recording the same finding
 * updates it instead of piling up duplicates on repeated agent runs. The
 * first recorder owns the row: an agent re-posting a finding the operator
 * already wrote by hand gets `not_yours` and changes nothing.
 */
export function recordExternalLead(input: ExternalLeadInput, actor: LeadActor, db: Db = getDb()): LeadWriteResult {
  const source = input.source.trim();
  const modelId = input.modelId.trim();
  const existing = db.prepare('SELECT id, added_by FROM external_model_leads WHERE source = ? AND model_id = ?')
    .get(source, modelId) as { id: number; added_by: string } | undefined;
  if (existing && actor === 'agent' && existing.added_by !== 'agent') return { ok: false, reason: 'not_yours' };

  db.prepare(`
    INSERT INTO external_model_leads (source, provider, model_id, display_name, kind, status, notes, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, model_id) DO UPDATE SET
      provider = COALESCE(excluded.provider, external_model_leads.provider),
      display_name = COALESCE(excluded.display_name, external_model_leads.display_name),
      kind = COALESCE(excluded.kind, external_model_leads.kind),
      status = excluded.status,
      notes = COALESCE(excluded.notes, external_model_leads.notes),
      at = datetime('now')
  `).run(
    source,
    normaliseProvider(input.provider),
    modelId,
    input.displayName?.trim() || null,
    input.kind ?? null,
    input.status ?? 'candidate',
    input.notes?.trim() || null,
    actor,
  );

  const row = db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads WHERE source = ? AND model_id = ?`)
    .get(source, modelId) as LeadDbRow;
  return { ok: true, lead: toLead(row) };
}

export function updateExternalLead(id: number, patch: ExternalLeadPatch, actor: LeadActor, db: Db = getDb()): LeadWriteResult {
  const existing = leadById(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (actor === 'agent' && existing.added_by !== 'agent') return { ok: false, reason: 'not_yours' };

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.provider !== undefined) { sets.push('provider = ?'); params.push(normaliseProvider(patch.provider)); }
  if (patch.displayName !== undefined) { sets.push('display_name = ?'); params.push(patch.displayName?.trim() || null); }
  if (patch.kind !== undefined) { sets.push('kind = ?'); params.push(patch.kind); }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes?.trim() || null); }
  if (sets.length > 0) {
    db.prepare(`UPDATE external_model_leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
  return { ok: true, lead: toLead(leadById(db, id)!) };
}

export function deleteExternalLead(id: number, actor: LeadActor, db: Db = getDb()): LeadWriteResult {
  const existing = leadById(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (actor === 'agent' && existing.added_by !== 'agent') return { ok: false, reason: 'not_yours' };
  db.prepare('DELETE FROM external_model_leads WHERE id = ?').run(id);
  return { ok: true, lead: toLead(existing) };
}

// ── Agent token ─────────────────────────────────────────────────────────────
//
// One long-lived bearer an unattended agent can hold. It authorises the
// discovery routes only — never inference, never any other /api route — so a
// leaked token can at worst add junk leads, which `addedBy: agent` makes easy
// to find and clear. Only its SHA-256 is stored; the raw value is shown once.

const SETTING_AGENT_TOKEN_HASH = 'discovery_agent_token_hash';
const SETTING_AGENT_TOKEN_CREATED = 'discovery_agent_token_created_at';
export const AGENT_TOKEN_PREFIX = 'fld_';

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export interface AgentTokenStatus {
  active: boolean;
  createdAt: string | null;
}

export function agentTokenStatus(): AgentTokenStatus {
  const hash = getSetting(SETTING_AGENT_TOKEN_HASH);
  return { active: !!hash, createdAt: hash ? (getSetting(SETTING_AGENT_TOKEN_CREATED) ?? null) : null };
}

/** Mint a new token, replacing any previous one. Returns the raw value once. */
export function mintAgentToken(): { token: string; createdAt: string } {
  const token = AGENT_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const createdAt = new Date().toISOString();
  setSetting(SETTING_AGENT_TOKEN_HASH, sha256(token));
  setSetting(SETTING_AGENT_TOKEN_CREATED, createdAt);
  return { token, createdAt };
}

export function revokeAgentToken(db: Db = getDb()): void {
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(SETTING_AGENT_TOKEN_HASH, SETTING_AGENT_TOKEN_CREATED);
}

/** Constant-time check of a presented token against the stored hash. */
export function isAgentToken(presented: string | undefined | null): boolean {
  if (!presented || !presented.startsWith(AGENT_TOKEN_PREFIX)) return false;
  const stored = getSetting(SETTING_AGENT_TOKEN_HASH);
  if (!stored) return false;
  return timingSafeStringEqual(sha256(presented), stored);
}
