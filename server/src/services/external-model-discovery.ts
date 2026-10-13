import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';

// Model discovery outside the signed catalog feed.
//
// Distinct from `builtin-model-discovery.ts` (#1348), which queries a provider's
// OWN /models endpoint to fill missing catalog rows for that provider.
//
// This manages the external leads an operator or an AI agent brought from the
// wild: stealth launches, free-tier blog announcements, unlisted relay routes.
// Leads are candidate models to test; nothing here routes or enables a model.

export type LeadStatus = 'candidate' | 'testing' | 'verified' | 'rejected' | 'added';
export type LeadKind = 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'video';

export interface ExternalLead {
  id: number;
  at: string;
  source: string;
  modelId: string;
  displayName: string | null;
  kind: LeadKind | null;
  status: LeadStatus;
  notes: string | null;
  addedBy: 'user' | 'agent';
}

export interface ExternalLeadInput {
  source: string;
  modelId: string;
  displayName?: string | null;
  kind?: LeadKind | null;
  status?: LeadStatus;
  notes?: string | null;
  addedBy?: 'user' | 'agent';
}

export interface ExternalLeadPatch {
  displayName?: string | null;
  kind?: LeadKind | null;
  status?: LeadStatus;
  notes?: string | null;
}

export interface ExternalLeadQuery {
  status?: LeadStatus;
  source?: string;
  limit?: number;
  offset?: number;
}

interface LeadDbRow {
  id: number;
  at: string;
  source: string;
  model_id: string;
  display_name: string | null;
  kind: string | null;
  status: string;
  notes: string | null;
  added_by: string;
}

function toLead(r: LeadDbRow): ExternalLead {
  return {
    id: r.id,
    at: r.at,
    source: r.source,
    modelId: r.model_id,
    displayName: r.display_name,
    kind: (r.kind as LeadKind) ?? null,
    status: (r.status as LeadStatus) ?? 'candidate',
    notes: r.notes,
    addedBy: r.added_by === 'agent' ? 'agent' : 'user',
  };
}

const MAX_LIMIT = 200;

export function listExternalLeads(query: ExternalLeadQuery = {}, db: Db = getDb()): {
  leads: ExternalLead[];
  total: number;
  byStatus: Record<LeadStatus, number>;
} {
  const limit = Math.min(Math.max(1, query.limit ?? 50), MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.source) {
    clauses.push('source = ?');
    params.push(query.source);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT id, at, source, model_id, display_name, kind, status, notes, added_by
      FROM external_model_leads
      ${where}
     ORDER BY at DESC, id DESC
     LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as LeadDbRow[];

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM external_model_leads ${where}`).get(...params) as { n: number }).n;

  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n
      FROM external_model_leads
     GROUP BY status
  `).all() as Array<{ status: string; n: number }>;
  const byStatus: Record<LeadStatus, number> = {
    candidate: 0, testing: 0, verified: 0, rejected: 0, added: 0,
  };
  for (const c of counts) {
    if (c.status in byStatus) byStatus[c.status as LeadStatus] = c.n;
  }

  return { leads: rows.map(toLead), total, byStatus };
}

/**
 * Upsert one lead. (source, model_id) is unique, so re-recording the same
 * finding from the same source updates notes and status rather than piling up
 * duplicate rows on repeated agent runs.
 */
export function recordExternalLead(input: ExternalLeadInput, db: Db = getDb()): ExternalLead {
  const status = input.status ?? 'candidate';
  const addedBy = input.addedBy ?? 'user';
  db.prepare(`
    INSERT INTO external_model_leads (source, model_id, display_name, kind, status, notes, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source, model_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, external_model_leads.display_name),
      kind = COALESCE(excluded.kind, external_model_leads.kind),
      status = excluded.status,
      notes = COALESCE(excluded.notes, external_model_leads.notes),
      added_by = excluded.added_by,
      at = datetime('now')
  `).run(
    input.source.trim(),
    input.modelId.trim(),
    input.displayName?.trim() || null,
    input.kind ?? null,
    status,
    input.notes?.trim() || null,
    addedBy,
  );

  const row = db.prepare(`
    SELECT id, at, source, model_id, display_name, kind, status, notes, added_by
      FROM external_model_leads
     WHERE source = ? AND model_id = ?
  `).get(input.source.trim(), input.modelId.trim()) as LeadDbRow;
  return toLead(row);
}

export function updateExternalLead(id: number, patch: ExternalLeadPatch, db: Db = getDb()): ExternalLead | null {
  const existing = db.prepare('SELECT id FROM external_model_leads WHERE id = ?').get(id);
  if (!existing) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(patch.displayName?.trim() || null);
  }
  if (patch.kind !== undefined) {
    sets.push('kind = ?');
    params.push(patch.kind);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?');
    params.push(patch.notes?.trim() || null);
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE external_model_leads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  const row = db.prepare(`
    SELECT id, at, source, model_id, display_name, kind, status, notes, added_by
      FROM external_model_leads
     WHERE id = ?
  `).get(id) as LeadDbRow;
  return toLead(row);
}

export function deleteExternalLead(id: number, db: Db = getDb()): boolean {
  const info = db.prepare('DELETE FROM external_model_leads WHERE id = ?').run(id);
  return info.changes > 0;
}
