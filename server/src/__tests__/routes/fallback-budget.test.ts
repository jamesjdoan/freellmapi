import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { z } from 'zod';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let token: string;

async function usage() {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/fallback/token-usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return z.object({
      totalBudget: z.number(),
      totalUsed: z.number(),
      models: z.array(z.object({ modelId: z.string(), poolBudget: z.number().optional() })),
    }).parse(await response.json());
  } finally {
    server.close();
  }
}

function key(platform: string, status = 'healthy', scope: string[] | null = null) {
  const secret = encrypt('budget-test');
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES (?, 'budget-test', ?, ?, ?, ?, 1, ?)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag, status, scope ? JSON.stringify(scope) : null).lastInsertRowid);
}

function model(platform: string, modelId: string, budget: string, enabled = true) {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, monthly_token_budget)
    VALUES (?, ?, ?, 1, 1, ?)`).run(platform, modelId, modelId, budget);
  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number };
  db.prepare('UPDATE models SET enabled = 1, monthly_token_budget = ? WHERE id = ?').run(budget, row.id);
  db.prepare('INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 10000, 1)').run(row.id);
  db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?').run(enabled ? 1 : 0, row.id);
  return row.id;
}

describe('Chat monthly capacity', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('UPDATE fallback_config SET enabled = 1').run();
    db.prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();
    db.prepare("DELETE FROM settings WHERE key = 'default_chain_profile_id'").run();
  });

  it('excludes disabled chain routes, inaccessible scopes and invalid credentials', async () => {
    model('groq', 'openai/gpt-oss-120b', '~6M');
    model('google', 'gemini-2.5-flash', '~3M', false);
    model('mistral', 'codestral-latest', '~100M');
    key('groq', 'healthy', ['some-other-model']);
    key('groq', 'invalid');
    key('google');
    key('mistral');
    const data = await usage();
    expect(data.totalBudget).toBe(100_000_000);
    expect(data.models.map(m => m.modelId)).toEqual(['codestral-latest']);
  });

  it('counts a shared allowance once per usable key, including disjoint key scopes', async () => {
    model('mistral', 'codestral-latest', '~100M');
    model('mistral', 'mistral-code-latest', '~50M');
    key('mistral');
    key('mistral', 'healthy', ['mistral-code-latest']);
    const data = await usage();
    expect(data.totalBudget).toBe(150_000_000);
    expect(data.models.map(m => m.poolBudget)).toEqual([150_000_000, 150_000_000]);
  });

  it('uses only enabled members of the active profile, not the default chain', async () => {
    const enabled = model('groq', 'openai/gpt-oss-120b', '~6M');
    const disabled = model('mistral', 'codestral-latest', '~100M');
    key('groq'); key('mistral');
    const db = getDb();
    const profile = z.object({ id: z.number() }).parse(db.prepare('SELECT id FROM profiles LIMIT 1').get()).id;
    db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profile);
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1), (?, ?, 2, 0)')
      .run(profile, enabled, profile, disabled);
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)").run(String(profile));
    const data = await usage();
    expect(data.totalBudget).toBe(6_000_000);
    expect(data.models.map(m => m.modelId)).toEqual(['openai/gpt-oss-120b']);
  });

  it('does not invent capacity when every enabled key is invalid', async () => {
    model('groq', 'openai/gpt-oss-120b', '~6M');
    key('groq', 'invalid');
    const data = await usage();
    expect(data.totalBudget).toBe(0);
    expect(data.models).toEqual([]);
  });

  it('counts only credentials belonging to a custom model endpoint', async () => {
    const id = model('custom', 'endpoint-model', '~10M');
    const own = key('custom');
    const other = key('custom');
    const db = getDb();
    db.prepare('UPDATE api_keys SET base_url = ? WHERE id = ?').run('https://own.example/v1', own);
    db.prepare('UPDATE api_keys SET base_url = ? WHERE id = ?').run('https://other.example/v1', other);
    db.prepare('UPDATE models SET key_id = ?, endpoint_scope = ? WHERE id = ?').run(own, 'https://own.example/v1', id);
    const data = await usage();
    expect(data.totalBudget).toBe(10_000_000);
  });

  it('reports recorded chat usage independently of published capacity and chain membership', async () => {
    model('mistral', 'codestral-latest', '~100M');
    key('mistral');
    const db = getDb();
    db.prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type)
      VALUES ('custom', 'unknown-allowance', 'success', 120000000, 5, 1, 'chat')`).run();
    db.prepare(`INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type)
      VALUES ('custom', 'embedding', 'success', 500, 500, 1, 'embedding')`).run();
    const data = await usage();
    expect(data.totalBudget).toBe(100_000_000);
    expect(data.totalUsed).toBe(120_000_005);
  });
});
