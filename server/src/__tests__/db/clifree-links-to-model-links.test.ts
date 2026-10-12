import { beforeEach, expect, it } from 'vitest';
import { z } from 'zod';
import { getDb, initDb } from '../../db/index.js';
import { up, down } from '../../db/migrations/20261012_000001_clifree_links_to_model_links.js';

beforeEach(() => { process.env.ENCRYPTION_KEY = '0'.repeat(64); initDb(':memory:'); });

const setLegacy = (doc: Record<string, string | null>) => getDb()
  .prepare("INSERT INTO settings (key, value) VALUES ('clifree_fleet_links', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(JSON.stringify(doc));
const link = (platform: string, modelId: string) => getDb()
  .prepare('SELECT aa_slug, source FROM aa_model_link WHERE platform = ? AND model_id = ?').get(platform, modelId);
const legacy = () => z.object({ value: z.string() }).optional()
  .parse(getDb().prepare("SELECT value FROM settings WHERE key = 'clifree_fleet_links'").get())?.value;

it('moves panel remaps into aa_model_link, an operator decision there winning over the panel', () => {
  const db = getDb();
  db.prepare("INSERT INTO aa_model_link (platform, model_id, aa_slug, source) VALUES ('opencode', 'bunny-free', 'glm-flash', 'proxy')").run();
  db.prepare("INSERT INTO aa_model_link (platform, model_id, aa_slug, source) VALUES ('cline', 'a/b:free', 'auto-guess', 'auto')").run();
  setLegacy({
    'opencode:bunny-free': null,          // older "no counterpart" loses to the proxy
    'cline:a/b:free': 'real-model',       // an automatic match is not a decision
    'cline:nex/n2:free': null,            // "no counterpart" survives as a decision
    'groq:not-a-fleet-route': 'whatever', // outside the fleet: dropped
  });

  up(db);

  expect(link('opencode', 'bunny-free')).toEqual({ aa_slug: 'glm-flash', source: 'proxy' });
  expect(link('cline', 'a/b:free')).toEqual({ aa_slug: 'real-model', source: 'manual' });
  expect(link('cline', 'nex/n2:free')).toEqual({ aa_slug: null, source: 'manual' });
  expect(link('groq', 'not-a-fleet-route')).toBeUndefined();
  expect(legacy()).toBeUndefined();
});

it('survives a corrupt settings document and puts the decisions back on down', () => {
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('clifree_fleet_links', '{not json')").run();
  up(getDb());
  expect(legacy()).toBeUndefined();

  getDb().prepare("INSERT INTO aa_model_link (platform, model_id, aa_slug, source) VALUES ('cline', 'x/y:free', 'm', 'proxy')").run();
  down(getDb());
  expect(JSON.parse(legacy() ?? 'null')).toEqual({ 'cline:x/y:free': 'm' });
});