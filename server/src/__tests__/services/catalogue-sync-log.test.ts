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
    doc: { added: 0, removed: 0, changed: 0 },
    byPlatform: {},
    details: [],
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
    expect(diff.byPlatform).toEqual({ groq: { a: 2, r: 0, c: 0 }, cohere: { a: 1, r: 0, c: 0 } });
  });

  it('counts a no-op resync as nothing', () => {
    const doc = catalogOf([baseModel({ modelId: 'a' })]);
    expect(diffCatalogs(doc, doc)).toEqual({ added: 0, removed: 0, changed: 0, byPlatform: {}, details: [] });
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
    expect(diff.byPlatform.groq).toEqual({ a: 0, r: 0, c: 1 });
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

  it('splits a modality change into a media departure and a chat arrival', () => {
    const prev = catalogOf([baseModel({ modelId: 'a' })]);
    const next = catalogOf([baseModel({ modelId: 'a', modality: 'image' })]);
    const diff = diffCatalogs(prev, next);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.byPlatform.groq).toEqual({ a: 1, r: 1, c: 0 });
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
      doc: { added: 0, removed: 0, changed: DETAILS_CAP + 100 },
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
    recordCatalogueSync(getDb(), syncInput({ version: '2099.02.02', doc: { added: 2, removed: 1, changed: 3 } }));
    recordCatalogueSync(getDb(), syncInput({ version: '2099.02.03', doc: { added: 1, removed: 0, changed: 0 } }));
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
    expect((await syncCatalog()).action).toBe('applied');

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
      groq: { a: 0, r: 1, c: 1 },
      cohere: { a: 1, r: 0, c: 0 },
    });

    const total = page.total;
    mockCatalog(null);
    expect((await syncCatalog()).action).toBe('up_to_date');
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

    const missing = await api('/api/models/changes/syncs/detail?id=999999');
    expect(missing.status).toBe(404);
  });
});
