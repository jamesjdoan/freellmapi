import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { initDb, getDb } from '../../db/index.js';
import type { Db } from '../../db/types.js';
import { diffCatalogs, syncCatalog, type Catalog } from '../../services/catalog-sync.js';
import {
  recordCatalogueSync,
  listCatalogueSyncs,
  getCatalogueSync,
  DETAILS_CAP,
  type CatalogueSyncInput,
} from '../../services/catalogue-sync-log.js';
import { up as syncLogUp } from '../../db/migrations/20261013_000001_catalogue_sync_log.js';
import { up as membersUp } from '../../db/migrations/20261014_000002_catalogue_sync_members.js';
import { up as switchesUp } from '../../db/migrations/20261014_000005_catalogue_sync_switches.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { modelsRouter } from '../../routes/models.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The sync log's contract: every APPLIED catalog document lands one row that
// says when it landed, from which tier, and what it changed against the
// document before it — quantities first, field-level detail capped. The diff
// is document-against-document (the feed's verdicts), kept strictly apart from
// applyCatalog's DB counts (what the database did).

type AnyModel = Catalog['models'][number];

function baseModel(over: Partial<AnyModel> = {}): AnyModel {
  return {
    platform: 'groq',
    modelId: 'test-model',
    displayName: 'Test Model',
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 8192,
    enabled: true,
    supportsVision: false,
    supportsTools: true,
    ...over,
  };
}

function catalogOf(models: AnyModel[], over: Partial<Catalog> = {}): Catalog {
  return {
    version: '2099.01.01',
    generatedAt: '2026-10-12T10:09:44.790Z',
    tier: 'live',
    models,
    quirks: [],
    ...over,
  };
}

function syncInput(over: Partial<CatalogueSyncInput> = {}): CatalogueSyncInput {
  return {
    version: '2099.01.01',
    previousVersion: '2099.01.00',
    tier: 'live',
    generatedAt: '2026-10-12T10:09:44.790Z',
    counts: { updated: 0, inserted: 0, removed: 0, skippedUnknownPlatform: 0, quirks: 0 },
    doc: { added: 0, removed: 0, changed: 0, switchedOff: 0, switchedOn: 0 },
    byPlatform: {},
    details: [],
    members: { added: [], removed: [] },
    ...over,
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

describe('diffCatalogs', () => {
  it('reports every row as added when no previous document exists', () => {
    const next = catalogOf([baseModel({ modelId: 'a' }), baseModel({ modelId: 'b' })], {
      embeddings: [{
        family: 'embed', platform: 'cohere', modelId: 'e1', displayName: 'E1',
        dimensions: 1024, maxInputTokens: 512, priority: 1, enabled: true, quotaLabel: '',
      }],
    });
    const diff = diffCatalogs(null, next);
    expect(diff.added).toBe(3);
    expect(diff.removed).toBe(0);
    expect(diff.changed).toBe(0);
    expect(diff.byPlatform).toEqual({ groq: { a: 2, r: 0, c: 0, off: 0, on: 0 }, cohere: { a: 1, r: 0, c: 0, off: 0, on: 0 } });
  });

  it('counts a no-op resync as nothing', () => {
    const doc = catalogOf([baseModel({ modelId: 'a' })]);
    expect(diffCatalogs(doc, doc)).toEqual({
      added: 0, removed: 0, changed: 0, switchedOff: 0, switchedOn: 0,
      byPlatform: {}, details: [], members: { added: [], removed: [] },
    });
  });

  it('captures field-level changes on an existing model, including a quiet quota cut', () => {
    const prev = catalogOf([baseModel({ modelId: 'a' }), baseModel({ modelId: 'b' })]);
    const next = catalogOf([
      baseModel({ modelId: 'a', limits: { rpm: 30, rpd: 500, tpm: 6000, tpd: null }, displayName: 'Test Model v2' }),
      baseModel({ modelId: 'b' }),
    ]);
    const diff = diffCatalogs(prev, next);
    expect(diff.changed).toBe(1);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.byPlatform.groq).toEqual({ a: 0, r: 0, c: 1, off: 0, on: 0 });
    expect(diff.details).toEqual([
      { r: 'chat', p: 'groq', m: 'a', f: 'displayName', o: 'Test Model', n: 'Test Model v2' },
      { r: 'chat', p: 'groq', m: 'a', f: 'rpd', o: 1000, n: 500 },
    ]);
  });

  it('counts a dropped model as removed', () => {
    const prev = catalogOf([baseModel({ modelId: 'a' }), baseModel({ modelId: 'b' })]);
    const next = catalogOf([baseModel({ modelId: 'a' })]);
    const diff = diffCatalogs(prev, next);
    expect(diff.removed).toBe(1);
    expect(diff.byPlatform.groq.r).toBe(1);
  });

  it('counts a model the feed switched off apart from field edits', () => {
    const prev = catalogOf([baseModel({ modelId: 'a' }), baseModel({ modelId: 'b' }), baseModel({ modelId: 'c', enabled: false })]);
    const next = catalogOf([
      baseModel({ modelId: 'a', enabled: false }),
      baseModel({ modelId: 'b', enabled: false, limits: { rpm: 30, rpd: 10, tpm: 6000, tpd: null } }),
      baseModel({ modelId: 'c' }),
    ]);
    const diff = diffCatalogs(prev, next);
    expect(diff).toMatchObject({ switchedOff: 2, switchedOn: 1, changed: 1 });
    expect(diff.byPlatform.groq).toEqual({ a: 0, r: 0, c: 1, off: 2, on: 1 });
    expect(diff.details.filter(d => d.f === 'enabled')).toHaveLength(3);
  });

  it('names the models that arrived and departed, with their provider and display name', () => {
    const prev = catalogOf([baseModel({ modelId: 'a' }), baseModel({ modelId: 'b', displayName: 'Model B' })]);
    const next = catalogOf([baseModel({ modelId: 'a' }), baseModel({ platform: 'mistral', modelId: 'c', displayName: 'Model C' })]);
    expect(diffCatalogs(prev, next).members).toEqual({
      added: [{ r: 'chat', p: 'mistral', m: 'c', n: 'Model C' }],
      removed: [{ r: 'chat', p: 'groq', m: 'b', n: 'Model B' }],
    });
  });

  it('splits a modality change into a media departure and a chat arrival', () => {
    const prev = catalogOf([baseModel({ modelId: 'a' })]);
    const next = catalogOf([baseModel({ modelId: 'a', modality: 'image' })]);
    const diff = diffCatalogs(prev, next);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.byPlatform.groq).toEqual({ a: 1, r: 1, c: 0, off: 0, on: 0 });
  });

  it('diffs the optional registries the same way, arrays included', () => {
    const prev = catalogOf([], {
      transcriptionModels: [{
        platform: 'groq', modelId: 'whisper', displayName: 'Whisper', priority: 1,
        enabled: true, subtitleFormats: ['vtt'],
      }],
    });
    const next = catalogOf([], {
      transcriptionModels: [{
        platform: 'groq', modelId: 'whisper', displayName: 'Whisper', priority: 1,
        enabled: true, subtitleFormats: ['vtt', 'srt'],
      }],
    });
    const diff = diffCatalogs(prev, next);
    expect(diff.changed).toBe(1);
    expect(diff.details).toEqual([
      { r: 'stt', p: 'groq', m: 'whisper', f: 'subtitleFormats', o: '["vtt"]', n: '["vtt","srt"]' },
    ]);
  });
});

describe('catalogue_sync_log storage', () => {
  it('caps stored field details but keeps the row', () => {
    const details = Array.from({ length: DETAILS_CAP + 100 }, (_, i) => ({
      r: 'chat', p: 'groq', m: `m${i}`, f: 'rpd', o: 1, n: 2,
    })) as CatalogueSyncInput['details'];
    recordCatalogueSync(getDb(), syncInput({
      version: '2099.02.01',
      doc: { added: 0, removed: 0, changed: DETAILS_CAP + 100, switchedOff: 0, switchedOn: 0 },
      details,
    }));
    const row = getDb().prepare("SELECT details_json, doc_changed FROM catalogue_sync WHERE version = '2099.02.01'").get() as {
      details_json: string;
      doc_changed: number;
    };
    expect(JSON.parse(row.details_json)).toHaveLength(DETAILS_CAP);
    expect(row.doc_changed).toBe(DETAILS_CAP + 100);
  });

  it('lists newest first with a total, and resolves detail by id', () => {
    const first = listCatalogueSyncs({}).total;
    recordCatalogueSync(getDb(), syncInput({ version: '2099.02.02', doc: { added: 2, removed: 1, changed: 3, switchedOff: 0, switchedOn: 0 } }));
    recordCatalogueSync(getDb(), syncInput({ version: '2099.02.03', doc: { added: 1, removed: 0, changed: 0, switchedOff: 0, switchedOn: 0 } }));
    const page = listCatalogueSyncs({ limit: 2 });
    expect(page.total).toBe(first + 2);
    expect(page.syncs.map(s => s.version)).toEqual(['2099.02.03', '2099.02.02']);
    const detail = getCatalogueSync(page.syncs[1].id);
    expect(detail).not.toBeNull();
    expect(detail!.docAdded).toBe(2);
    expect(detail!.docRemoved).toBe(1);
  });
});

describe('baseline migration', () => {
  // The migration module is exercised directly against a bare DatabaseSync:
  // structurally the handle the migration's prepare/exec calls need, and the
  // one way to set settings BEFORE the migration runs.
  function rawDb(): Db {
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    return raw as unknown as Db;
  }

  it('backfills one baseline row when an applied catalog already exists', () => {
    const raw = rawDb();
    raw.prepare("INSERT INTO settings (key, value) VALUES ('catalog_applied_version', '2026.10.12.daddd7e6')").run();
    raw.prepare("INSERT INTO settings (key, value) VALUES ('catalog_applied_tier', 'live')").run();
    raw.prepare("INSERT INTO settings (key, value) VALUES ('catalog_applied_json', ?)").run(
      JSON.stringify({ version: '2026.10.12.daddd7e6', generatedAt: '2026-10-12T10:09:44.790Z' }),
    );
    syncLogUp(raw);
    const row = raw.prepare('SELECT version, previous_version, tier, generated_at FROM catalogue_sync').get() as Record<string, unknown>;
    expect(row).toEqual({
      version: '2026.10.12.daddd7e6',
      previous_version: null,
      tier: 'live',
      generated_at: '2026-10-12T10:09:44.790Z',
    });
  });

  it('records nothing for an install that has never applied a catalog', () => {
    const db = rawDb();
    syncLogUp(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalogue_sync').get()).toEqual({ n: 0 });
  });
});

describe('model-name backfill migration', () => {
  // Rows written before members_json existed are filled from catalogue_event
  // only when the events in their window match their counts exactly.
  function rawDbWithLog(): Db {
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    raw.exec(`CREATE TABLE catalogue_event (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
      kind TEXT NOT NULL, platform TEXT NOT NULL, model_id TEXT NOT NULL, display_name TEXT,
      source TEXT, reason TEXT, chains_json TEXT)`);
    const db = raw as unknown as Db;
    syncLogUp(db);
    return db;
  }
  const addSync = (db: Db, at: string, added: number, removed: number) =>
    db.prepare('INSERT INTO catalogue_sync (at, version, tier, doc_added, doc_removed) VALUES (?, ?, ?, ?, ?)')
      .run(at, `v-${at}`, 'live', added, removed);
  const addEvent = (db: Db, at: string, kind: string, model: string, source = 'catalog') =>
    db.prepare('INSERT INTO catalogue_event (at, kind, platform, model_id, display_name, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, kind, 'inferbase', model, model.toUpperCase(), source);
  const membersOf = (db: Db, at: string) => {
    const row = db.prepare('SELECT members_json FROM catalogue_sync WHERE at = ?').get(at) as { members_json: string | null };
    return row.members_json === null ? null : JSON.parse(row.members_json);
  };

  it('fills a row whose window of events matches its counts exactly', () => {
    const db = rawDbWithLog();
    addSync(db, '2026-10-13 06:00:00', 0, 0);
    addEvent(db, '2026-10-13 09:39:59', 'arrived', 'm1');
    addEvent(db, '2026-10-13 09:39:59', 'arrived', 'm2');
    addEvent(db, '2026-10-13 09:39:59', 'removed', 'gone');
    addEvent(db, '2026-10-13 09:39:59', 'arrived', 'hand-added', 'user');
    addSync(db, '2026-10-13 09:40:00', 2, 1);
    membersUp(db);
    expect(membersOf(db, '2026-10-13 06:00:00')).toEqual({ added: [], removed: [] });
    expect(membersOf(db, '2026-10-13 09:40:00')).toEqual({
      added: [{ r: 'chat', p: 'inferbase', m: 'm1', n: 'M1' }, { r: 'chat', p: 'inferbase', m: 'm2', n: 'M2' }],
      removed: [{ r: 'chat', p: 'inferbase', m: 'gone', n: 'GONE' }],
    });
  });

  it('leaves the names unknown when the events do not account for the counts', () => {
    const db = rawDbWithLog();
    addEvent(db, '2026-10-13 09:39:59', 'arrived', 'm1');
    addSync(db, '2026-10-13 09:40:00', 3, 0);
    membersUp(db);
    expect(membersOf(db, '2026-10-13 09:40:00')).toBeNull();
  });
});

describe('switched-off recount migration', () => {
  it('moves enabled flips out of "changed" for existing rows', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    const db = raw as unknown as Db;
    syncLogUp(db);
    const details = [
      { r: 'chat', p: 'sail', m: 'x', f: 'enabled', o: true, n: false },
      { r: 'chat', p: 'sail', m: 'y', f: 'enabled', o: true, n: false },
      { r: 'chat', p: 'xkiro', m: 'z', f: 'enabled', o: false, n: true },
      { r: 'chat', p: 'xkiro', m: 'z', f: 'rpd', o: 10, n: 5 },
    ];
    db.prepare('INSERT INTO catalogue_sync (version, tier, doc_added, doc_changed, by_platform_json, details_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run('v1', 'live', 1, 3, JSON.stringify({ sail: { a: 1, r: 0, c: 2 }, xkiro: { a: 0, r: 0, c: 1 } }), JSON.stringify(details));
    switchesUp(db);
    const row = db.prepare('SELECT doc_changed, doc_switched_off, doc_switched_on, by_platform_json FROM catalogue_sync').get() as Record<string, unknown>;
    expect(row).toMatchObject({ doc_changed: 1, doc_switched_off: 2, doc_switched_on: 1 });
    expect(JSON.parse(String(row.by_platform_json))).toEqual({
      sail: { a: 1, r: 0, c: 0, off: 2, on: 0 },
      xkiro: { a: 0, r: 0, c: 1, off: 0, on: 1 },
    });
  });
});

describe('syncCatalog writes the log through the signed-feed path', () => {
  let server: Server;
  let url: string;
  let token: string;
  let privateKey: crypto.KeyObject;
  const realFetch = globalThis.fetch;

  function signedResponse(doc: Catalog): Response {
    const body = Buffer.from(JSON.stringify(doc));
    const signature = crypto.sign(null, body, privateKey);
    return new Response(body, {
      status: 200,
      headers: { 'x-catalog-signature': signature.toString('base64'), 'content-type': 'application/json' },
    });
  }

  /** Mock ONLY the catalog endpoint; the express app under test is reached
   *  through real loopback HTTP. */
  function mockCatalog(doc: Catalog | null) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      // Pathname, not suffix: the second sync appends ?since=<version>, and a
      // missed matcher would send this test at the real catalog host.
      if (new URL(target).pathname === '/v1/latest') {
        return doc ? signedResponse(doc) : new Response(null, { status: 304 });
      }
      return realFetch(input, init);
    });
  }

  beforeAll(async () => {
    const { publicKey, privateKey: generated } = crypto.generateKeyPairSync('ed25519');
    privateKey = generated;
    process.env.CATALOG_PUBKEY = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    token = mintDashboardToken();
    const app = express();
    app.use(express.json());
    app.use('/api/models', requireAuth, modelsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
    delete process.env.CATALOG_PUBKEY;
  });

  const api = async (path: string) => realFetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  it('records a baseline row for the first sync, a diff row for the second, and nothing for a 304', async () => {
    // The storage describe above wrote into the same in-memory DB; this file's
    // assertions are relative to that, so the shared table's history cannot
    // leak into them.
    const before = listCatalogueSyncs({}).total;
    const doc1 = catalogOf([baseModel({ modelId: 'a' }), baseModel({ modelId: 'b' })], { version: '2099.03.01' });
    mockCatalog(doc1);
    expect((await syncCatalog()).action).toBe('applied');

    let page = listCatalogueSyncs({});
    expect(page.syncs).toHaveLength(before + 1);
    expect(page.syncs[0]).toMatchObject({
      version: '2099.03.01',
      previousVersion: null,
      tier: 'live',
      docAdded: 2,
      docRemoved: 0,
      docChanged: 0,
    });
    expect(page.syncs[0].inserted).toBe(2);

    const doc2 = catalogOf(
      [baseModel({ modelId: 'a', limits: { rpm: 30, rpd: 500, tpm: 6000, tpd: null } })],
      {
        version: '2099.03.02',
        embeddings: [{
          family: 'embed', platform: 'cohere', modelId: 'e1', displayName: 'E1',
          dimensions: 1024, maxInputTokens: 512, priority: 1, enabled: true, quotaLabel: '',
        }],
      },
    );
    mockCatalog(doc2);
    const applied = await syncCatalog();
    expect(applied.action).toBe('applied');
    // A manual "check for updates" reports the same quantities the log keeps.
    expect(applied.changes).toEqual({ added: 1, removed: 1, changed: 1, switchedOff: 0, switchedOn: 0 });

    page = listCatalogueSyncs({});
    expect(page.syncs).toHaveLength(before + 2);
    expect(page.syncs[0]).toMatchObject({
      version: '2099.03.02',
      previousVersion: '2099.03.01',
      docAdded: 1,
      docRemoved: 1,
      docChanged: 1,
    });
    expect(page.syncs[0].byPlatform).toEqual({
      groq: { a: 0, r: 1, c: 1, off: 0, on: 0 },
      cohere: { a: 1, r: 0, c: 0, off: 0, on: 0 },
    });

    const total = page.total;
    mockCatalog(null);
    const upToDate = await syncCatalog();
    expect(upToDate.action).toBe('up_to_date');
    expect(upToDate.changes).toBeUndefined();
    expect(listCatalogueSyncs({}).total).toBe(total);

    // The dashboard reads the same rows through the authenticated API.
    const list = await api('/api/models/changes/syncs?limit=10');
    expect(list.status).toBe(200);
    const listBody = await list.json() as { syncs: Array<{ id: number; version: string }>; total: number };
    expect(listBody.total).toBe(total);
    const detail = await api(`/api/models/changes/syncs/detail?id=${listBody.syncs[0].id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { version: string; details: Array<{ m: string; f: string }> };
    expect(detailBody.version).toBe('2099.03.02');
    expect(detailBody.details).toContainEqual({ r: 'chat', p: 'groq', m: 'a', f: 'rpd', o: 1000, n: 500 });
    expect((detailBody as unknown as { members: unknown }).members).toEqual({
      added: [{ r: 'embedding', p: 'cohere', m: 'e1', n: 'E1' }],
      removed: [{ r: 'chat', p: 'groq', m: 'b', n: 'Test Model' }],
    });

    const missing = await api('/api/models/changes/syncs/detail?id=999999');
    expect(missing.status).toBe(404);
  });
});
