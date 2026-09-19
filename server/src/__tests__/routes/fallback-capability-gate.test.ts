import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { setExtensionEnabled } from '../../services/extension-state.js';
import { recordCapabilityProbe } from '../../services/chain-capability.js';

/**
 * What `chain-capability-verification` does and does not control.
 *
 * Exactly one behaviour: the 409 a membership write returns for a route with a
 * RECORDED capability failure. Switching it off must not hide the measurement —
 * the audit is diagnostic, like /api/fallback/reachability, and a toggle that
 * made existing broken members vanish from view would be worse than no toggle.
 */

async function request(app: Express, method: string, path: string, token: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, body: json as Record<string, any> };
}

describe('chain-capability-verification gate', () => {
  let app: Express;
  let token: string;
  let blindId: number;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
    const db = getDb();
    // Reachability gates membership first, so the route needs a usable key or
    // its 409 fires before the one under test.
    const secret = encrypt('nvidia-capability-gate');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('nvidia', 'fixture', ?, ?, ?, 'healthy', 1)
    `).run(secret.encrypted, secret.iv, secret.authTag);
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          monthly_token_budget, context_window, enabled, supports_vision, supports_tools, endpoint_scope)
      VALUES ('nvidia', 'nemotron-parse-2.0', 'Nemotron Parse 2.0', 50, 50, 'Large', '', 131072, 1, 1, 1, '')
    `).run();
    blindId = (db.prepare("SELECT id FROM models WHERE model_id = 'nemotron-parse-2.0'").get() as { id: number }).id;
    db.prepare("INSERT INTO profiles (name, emoji, color, type) VALUES ('Vision', '', '#000', 'custom')").run();
    // The measurement that makes this route a known failure for Vision.
    recordCapabilityProbe(
      { platform: 'nvidia', modelId: 'nemotron-parse-2.0', endpointScope: '', capability: 'vision' },
      { verdict: 'dead', detail: 'empty completion from Nemotron Parse 2.0', latencyMs: 696 },
    );
  });

  it('enabled: a recorded capability failure is refused with 409', async () => {
    setExtensionEnabled('chain-capability-verification', true);
    const res = await request(app, 'POST', '/api/fallback/membership', token, {
      chain: 'Vision', modelDbIds: [blindId], member: true,
    });
    expect(res.status).toBe(409);
    expect(String(res.body.error.message)).toContain('vision');
    expect(res.body.error.incapable).toEqual([
      { platform: 'nvidia', modelId: 'nemotron-parse-2.0', capability: 'vision' },
    ]);
  });

  it('disabled: the same add succeeds, and the audit still reports the failure', async () => {
    setExtensionEnabled('chain-capability-verification', false);
    const add = await request(app, 'POST', '/api/fallback/membership', token, {
      chain: 'Vision', modelDbIds: [blindId], member: true,
    });
    expect(add.status).toBe(200);

    // The evidence is not hidden by the toggle — that is the whole point of it
    // gating enforcement only.
    const audit = await request(app, 'GET', '/api/fallback/capability?chain=Vision', token);
    expect(audit.status).toBe(200);
    expect(audit.body.failed).toHaveLength(1);
    expect(audit.body.failed[0]).toMatchObject({
      chain: 'Vision', platform: 'nvidia', modelId: 'nemotron-parse-2.0', capability: 'vision', state: 'failed',
    });
    expect(audit.body.chains).toContainEqual(
      expect.objectContaining({ chain: 'Vision', failed: 1, unverified: 0 }),
    );
  });

  it('disabled: manual verification stays reachable rather than 403ing', async () => {
    setExtensionEnabled('chain-capability-verification', false);
    // No live provider here, so the call is expected to reach the prober and
    // report a per-member outcome rather than be refused by the gate.
    const res = await request(app, 'POST', '/api/fallback/capability/verify', token, { chain: 'Vision' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
  });
});
