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
// anything. An agent, holding the dedicated discovery token, is constrained so
// an unattended job can never undo the operator's judgement:
//   - it changes or removes only the leads an agent recorded;
//   - once the operator has set a lead's status, the agent cannot change it,
//     only add notes;
//   - a model the operator ignored is skipped, wherever the agent found it.
//
// "Ignored" is a status the operator picks, next to "rejected": rejected means
// tested and it does not work; ignored means we will not use it whether or not
// it works. Setting it records an ignore on (provider, model id) so the next
// agent run skips the model from any source, and marks every lead of that
// model; picking any other status lifts the ignore for all of them.

export type LeadStatus = 'candidate' | 'testing' | 'verified' | 'rejected' | 'added' | 'ignored';
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
  /** Who last set the status. An operator-set status is locked to agents. */
  statusSetBy: LeadActor;
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
  | { ok: false; reason: 'not_found' | 'not_yours' | 'status_locked' | 'ignored' | 'operator_only' };

interface LeadDbRow {
  id: number;
  at: string;
  source: string;
  provider: string | null;
  model_id: string;
  display_name: string | null;
  kind: string | null;
  status: string;
  status_set_by: string;
  notes: string | null;
  added_by: string;
}

const LEAD_STATUSES: readonly LeadStatus[] = ['candidate', 'testing', 'verified', 'rejected', 'added', 'ignored'];
const LEAD_COLUMNS = 'id, at, source, provider, model_id, display_name, kind, status, status_set_by, notes, added_by';
const MAX_LIMIT = 200;
const MAX_NOTES = 4000;

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

const asActor = (value: string): LeadActor => (value === 'agent' ? 'agent' : 'user');

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
    statusSetBy: asActor(r.status_set_by),
    notes: r.notes,
    addedBy: asActor(r.added_by),
  };
}

/** The key an ignore is stored under: the effective provider, or ''. */
const ignoreKey = (provider: string | null, modelId: string) => `${provider ?? ''}\u0000${modelId}`;

function ignoredKeys(db: Db): Set<string> {
  const rows = db.prepare('SELECT provider, model_id FROM external_model_ignores').all() as Array<{ provider: string; model_id: string }>;
  return new Set(rows.map(r => ignoreKey(r.provider || null, r.model_id)));
}

function leadById(db: Db, id: number): LeadDbRow | undefined {
  return db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads WHERE id = ?`).get(id) as LeadDbRow | undefined;
}

/** Live leads first, then rejected (kept as evidence), then ignored. */
function byStatusThenRecency(a: ExternalLead, b: ExternalLead): number {
  const rank = (l: ExternalLead) => (l.status === 'ignored' ? 2 : l.status === 'rejected' ? 1 : 0);
  return rank(a) - rank(b) || (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id);
}

export function listExternalLeads(query: ExternalLeadQuery = {}, db: Db = getDb()): {
  leads: ExternalLead[];
  total: number;
  byStatus: Record<LeadStatus, number>;
} {
  const limit = Math.min(Math.max(1, query.limit ?? 200), MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);
  const all = (db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads`).all() as LeadDbRow[]).map(toLead);

  // Counted over every lead, so the status chips describe the list, not the
  // page or the current filter.
  const byStatus: Record<LeadStatus, number> = { candidate: 0, testing: 0, verified: 0, rejected: 0, added: 0, ignored: 0 };
  for (const lead of all) byStatus[lead.status]++;

  let leads = all;
  if (query.status) leads = leads.filter(l => l.status === query.status);
  if (query.provider) {
    const wanted = query.provider.toLowerCase();
    leads = leads.filter(l => l.provider === wanted);
  }
  leads.sort(byStatusThenRecency);
  return { leads: leads.slice(offset, offset + limit), total: leads.length, byStatus };
}

/** Every lead of one model, matched on effective provider and model id. */
function sameModelLeadIds(db: Db, provider: string | null, modelId: string): number[] {
  const rows = db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads WHERE model_id = ?`).all(modelId) as LeadDbRow[];
  return rows.map(toLead).filter(l => l.provider === provider).map(l => l.id);
}

/**
 * Keep the ignore record and every lead of the model in step with a status
 * the operator just set: entering "ignored" records the ignore and marks all
 * the model's leads; leaving it lifts the ignore and moves them all to the
 * new status.
 */
function applyIgnoreTransition(db: Db, lead: ExternalLead, from: LeadStatus, to: LeadStatus): void {
  if (from !== 'ignored' && to !== 'ignored') return;
  const key = lead.provider ?? '';
  if (to === 'ignored') {
    db.prepare('INSERT OR IGNORE INTO external_model_ignores (provider, model_id) VALUES (?, ?)').run(key, lead.modelId);
  } else {
    db.prepare('DELETE FROM external_model_ignores WHERE provider = ? AND model_id = ?').run(key, lead.modelId);
  }
  const ids = sameModelLeadIds(db, lead.provider, lead.modelId);
  const mark = db.prepare("UPDATE external_model_leads SET status = ?, status_set_by = 'user' WHERE id = ?");
  for (const id of ids) mark.run(to, id);
}

/** Append an agent's note once; a re-run posting the same text adds nothing. */
function appendNote(existing: string | null, incoming: string | null | undefined): string | null {
  const note = incoming?.trim();
  if (!note || existing?.includes(note)) return existing;
  const stamped = `[agent ${new Date().toISOString().slice(0, 10)}] ${note}`;
  return (existing ? `${existing}\n${stamped}` : stamped).slice(0, MAX_NOTES);
}

/**
 * Upsert one lead on (source, model_id), so re-recording the same finding
 * updates it instead of piling up duplicates on repeated agent runs.
 *
 * Agent constraints: a model the operator ignored is skipped; a lead the
 * operator recorded is not the agent's to touch; a lead whose status the
 * operator set keeps that status, and the agent's notes are appended once.
 */
export function recordExternalLead(input: ExternalLeadInput, actor: LeadActor, db: Db = getDb()): LeadWriteResult {
  const source = input.source.trim();
  const modelId = input.modelId.trim();
  const provider = normaliseProvider(input.provider);
  const effectiveProvider = provider ?? providerFromSource(source);
  if (ignoredKeys(db).has(ignoreKey(effectiveProvider, modelId))) return { ok: false, reason: 'ignored' };
  if (actor === 'agent' && input.status === 'ignored') return { ok: false, reason: 'operator_only' };

  const existing = db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads WHERE source = ? AND model_id = ?`)
    .get(source, modelId) as LeadDbRow | undefined;
  if (existing && actor === 'agent' && existing.added_by !== 'agent') return { ok: false, reason: 'not_yours' };

  if (existing && actor === 'agent' && existing.status_set_by === 'user') {
    db.prepare("UPDATE external_model_leads SET notes = ?, at = datetime('now') WHERE id = ?")
      .run(appendNote(existing.notes, input.notes), existing.id);
    return { ok: true, lead: toLead(leadById(db, existing.id)!) };
  }

  db.prepare(`
    INSERT INTO external_model_leads (source, provider, model_id, display_name, kind, status, status_set_by, notes, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, model_id) DO UPDATE SET
      provider = COALESCE(excluded.provider, external_model_leads.provider),
      display_name = COALESCE(excluded.display_name, external_model_leads.display_name),
      kind = COALESCE(excluded.kind, external_model_leads.kind),
      status = excluded.status,
      status_set_by = excluded.status_set_by,
      notes = COALESCE(excluded.notes, external_model_leads.notes),
      at = datetime('now')
  `).run(
    source,
    provider,
    modelId,
    input.displayName?.trim() || null,
    input.kind ?? null,
    input.status ?? existing?.status ?? 'candidate',
    actor,
    input.notes?.trim() || null,
    actor,
  );

  const row = db.prepare(`SELECT ${LEAD_COLUMNS} FROM external_model_leads WHERE source = ? AND model_id = ?`)
    .get(source, modelId) as LeadDbRow;
  const lead = toLead(row);
  if (lead.status === 'ignored') applyIgnoreTransition(db, lead, existing ? toLead(existing).status : 'candidate', 'ignored');
  return { ok: true, lead: toLead(leadById(db, lead.id)!) };
}

export function updateExternalLead(id: number, patch: ExternalLeadPatch, actor: LeadActor, db: Db = getDb()): LeadWriteResult {
  const existing = leadById(db, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (actor === 'agent' && existing.added_by !== 'agent') return { ok: false, reason: 'not_yours' };
  const statusChanges = patch.status !== undefined && patch.status !== existing.status;
  if (actor === 'agent' && statusChanges && (patch.status === 'ignored' || existing.status === 'ignored')) {
    return { ok: false, reason: 'operator_only' };
  }
  if (actor === 'agent' && statusChanges && existing.status_set_by === 'user') return { ok: false, reason: 'status_locked' };

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.provider !== undefined) { sets.push('provider = ?'); params.push(normaliseProvider(patch.provider)); }
  if (patch.displayName !== undefined) { sets.push('display_name = ?'); params.push(patch.displayName?.trim() || null); }
  if (patch.kind !== undefined) { sets.push('kind = ?'); params.push(patch.kind); }
  if (patch.status !== undefined) {
    sets.push('status = ?', 'status_set_by = ?');
    params.push(patch.status, actor);
  }
  if (patch.notes !== undefined) { sets.push('notes = ?'); params.push(patch.notes?.trim() || null); }
  if (sets.length > 0) {
    db.prepare(`UPDATE external_model_leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
  const updated = toLead(leadById(db, id)!);
  if (statusChanges) applyIgnoreTransition(db, updated, toLead(existing).status, updated.status);
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
