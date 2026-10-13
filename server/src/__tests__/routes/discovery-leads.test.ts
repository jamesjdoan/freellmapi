import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDb, getDb } from '../../db/index.js';
import { discoveryRouter } from '../../routes/discovery.js';
import { setExtensionEnabled } from '../../services/extension-state.js';
import { providerFromSource } from '../../services/external-model-discovery.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The discovery API is what an unattended agent writes to, so its contract is
// the one that caller depends on and the operator is protected by:
//   - re-posting the same finding updates rather than duplicates;
//   - the agent token can add leads and change only the leads an agent wrote,
//     never the operator's;
//   - the token cannot manage itself, and a revoked token stops working;
//   - switching the extension off closes the API to both callers.

describe('discovery API', () => {
  let server: Server;
  let url: string;
  let session: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    session = mintDashboardToken();
    const app = express();
    app.use(express.json());
    app.use('/api/discovery', discoveryRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server.once('listening', resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setExtensionEnabled('external-model-discovery', true);
    await new Promise<void>((resolve, reject) => { server.close(error => (error ? reject(error) : resolve())); });
  });

  const call = (token: string | null, path: string, init: RequestInit = {}) => fetch(`${url}/api/discovery${path}`, {
    ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
  });
  const post = (token: string, body: unknown) => call(token, '/leads', { method: 'POST', body: JSON.stringify(body) });
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM external_model_leads').get() as { n: number }).n;

  async function mintAgent(): Promise<string> {
    const res = await call(session, '/agent-token', { method: 'POST' });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  it('refuses a caller with neither a session nor the agent token', async () => {
    expect((await call(null, '/leads')).status).toBe(401);
    expect((await call('fld_not-the-token', '/leads')).status).toBe(401);
  });

  it('upserts on (source, modelId) so a re-run updates instead of duplicating', async () => {
    const lead = { source: 'https://opencode.ai/docs/zen', modelId: 'big-pickle', notes: 'Free in stealth' };
    expect((await post(session, lead)).status).toBe(200);
    const again = await post(session, { ...lead, status: 'testing', notes: 'Probe pending' });
    expect(count()).toBe(1);
    expect(await again.json()).toMatchObject({ status: 'testing', notes: 'Probe pending', addedBy: 'user' });
  });

  it('derives the provider from the source URL when none is given, and keeps a named one', async () => {
    const derived = await (await call(session, '/leads')).json() as { leads: Array<{ modelId: string; provider: string }> };
    expect(derived.leads.find(l => l.modelId === 'big-pickle')?.provider).toBe('opencode');
    const named = await post(session, { source: 'OpenRouter stealth page', modelId: 'space-bunny-alpha', provider: 'OpenRouter', status: 'rejected' });
    expect(await named.json()).toMatchObject({ provider: 'openrouter' });
    expect(providerFromSource('https://blog.anyrouter.dev/anyrouter-snapshot')).toBe('anyrouter');
    expect(providerFromSource('not a url')).toBeNull();
  });

  it('filters by provider and counts statuses across the whole table', async () => {
    const res = await call(session, '/leads?provider=opencode');
    const page = await res.json() as { leads: Array<{ modelId: string }>; total: number; byStatus: Record<string, number> };
    expect(page.leads.map(l => l.modelId)).toEqual(['big-pickle']);
    expect(page.byStatus).toMatchObject({ testing: 1, rejected: 1 });
  });

  it('records agent leads as the agent, whatever the body claims', async () => {
    const agent = await mintAgent();
    const res = await post(agent, { source: 'https://vercel.com/ai-gateway', modelId: 'stealth/glyph-cluster', addedBy: 'user' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ addedBy: 'agent', provider: 'vercel' });
  });

  it('lets the agent change and remove its own leads but not the operator’s', async () => {
    const agent = await mintAgent();
    const own = (await (await post(agent, { source: 'https://anyrouter.dev', modelId: 'stealth/space-bunny-alpha' })).json()) as { id: number };
    const operators = getDb().prepare("SELECT id FROM external_model_leads WHERE added_by = 'user' LIMIT 1").get() as { id: number };

    expect((await call(agent, `/leads/${own.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'verified' }) })).status).toBe(200);
    expect((await call(agent, `/leads/${operators.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'added' }) })).status).toBe(403);
    expect((await call(agent, `/leads/${operators.id}`, { method: 'DELETE' })).status).toBe(403);
    const before = count();
    expect((await post(agent, { source: 'https://opencode.ai/docs/zen', modelId: 'big-pickle', status: 'rejected' })).status).toBe(403);
    expect(count()).toBe(before);
    expect((getDb().prepare("SELECT status FROM external_model_leads WHERE model_id = 'big-pickle'").get() as { status: string }).status).toBe('testing');

    expect((await call(agent, `/leads/${own.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(count()).toBe(before - 1);
  });

  it('keeps token management with the operator, and a revoked token stops working', async () => {
    const agent = await mintAgent();
    expect((await call(agent, '/agent-token', { method: 'POST' })).status).toBe(403);
    expect((await call(agent, '/agent-token')).status).toBe(403);
    const replacement = await mintAgent();
    expect((await call(agent, '/leads')).status).toBe(401);
    expect((await call(replacement, '/leads')).status).toBe(200);
    const revoked = await call(session, '/agent-token', { method: 'DELETE' });
    expect(await revoked.json()).toEqual({ active: false, createdAt: null });
    expect((await call(replacement, '/leads')).status).toBe(401);
  });

  it('stores only the token hash', async () => {
    const agent = await mintAgent();
    const stored = getDb().prepare("SELECT value FROM settings WHERE key = 'discovery_agent_token_hash'").get() as { value: string };
    expect(stored.value).not.toContain(agent.slice(4));
    expect(stored.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects bad input without writing, and answers 404 for an unknown id', async () => {
    const before = count();
    expect((await post(session, { source: 'x' })).status).toBe(400);
    expect((await call(session, '/leads/1', { method: 'PATCH', body: JSON.stringify({ status: 'shipped' }) })).status).toBe(400);
    expect((await call(session, '/leads/9999', { method: 'DELETE' })).status).toBe(404);
    expect(count()).toBe(before);
  });

  it('keeps an operator-set status against agent re-runs, and appends the agent note once', async () => {
    const agent = await mintAgent();
    const found = { source: 'https://opencode.ai/docs/zen', modelId: 'nemotron-free', notes: 'Listed on /models' };
    const lead = (await (await post(agent, found)).json()) as { id: number };
    expect((await call(session, `/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'rejected' }) })).status).toBe(200);

    const rerun = { ...found, status: 'candidate', notes: 'Still listed 2026-10-15' };
    const after = await (await post(agent, rerun)).json() as { status: string; statusSetBy: string; notes: string };
    expect(after.status).toBe('rejected');
    expect(after.statusSetBy).toBe('user');
    expect(after.notes).toMatch(/^Listed on \/models\n\[agent \d{4}-\d{2}-\d{2}\] Still listed 2026-10-15$/);
    const again = await (await post(agent, rerun)).json() as { notes: string };
    expect(again.notes).toBe(after.notes);

    expect((await call(agent, `/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'testing' }) })).status).toBe(409);
    expect((await call(agent, `/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify({ notes: 'probe queued' }) })).status).toBe(200);
  });

  it('keeps the existing status when an agent re-posts its own lead without one', async () => {
    const agent = await mintAgent();
    const found = { source: 'https://llm7.io/models', modelId: 'llm7-free', status: 'testing' };
    await post(agent, found);
    const rerun = await (await post(agent, { source: found.source, modelId: found.modelId })).json() as { status: string };
    expect(rerun.status).toBe('testing');
  });

  it('ignores a model wherever it is found: hidden from the list, skipped for agents, refused for the operator', async () => {
    const agent = await mintAgent();
    await post(session, { source: 'https://opencode.ai/docs/zen', modelId: 'cat-jam-free' });
    await post(session, { source: 'https://opencode.ai/blog/stealth', modelId: 'cat-jam-free' });
    expect((await call(session, '/ignores', { method: 'POST', body: JSON.stringify({ provider: 'opencode', modelId: 'cat-jam-free', reason: 'harness-only' }) })).status).toBe(200);

    const page = await (await call(session, '/leads')).json() as { leads: Array<{ modelId: string }>; ignored: Array<{ provider: string; modelId: string; hiddenLeads: number; reason: string }> };
    expect(page.leads.some(l => l.modelId === 'cat-jam-free')).toBe(false);
    expect(page.ignored).toEqual([expect.objectContaining({ provider: 'opencode', modelId: 'cat-jam-free', hiddenLeads: 2, reason: 'harness-only' })]);

    const before = count();
    const skipped = await post(agent, { source: 'https://opencode.ai/changelog', modelId: 'cat-jam-free' });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ skipped: 'ignored' });
    expect((await post(session, { source: 'https://opencode.ai/new', modelId: 'cat-jam-free' })).status).toBe(409);
    expect(count()).toBe(before);

    expect((await call(agent, '/ignores', { method: 'POST', body: JSON.stringify({ provider: 'opencode', modelId: 'x' }) })).status).toBe(403);
    expect((await call(agent, '/ignores?provider=opencode&modelId=cat-jam-free', { method: 'DELETE' })).status).toBe(403);

    expect((await call(session, '/ignores?provider=opencode&modelId=cat-jam-free', { method: 'DELETE' })).status).toBe(200);
    const restored = await (await call(session, '/leads')).json() as { leads: Array<{ modelId: string }> };
    expect(restored.leads.filter(l => l.modelId === 'cat-jam-free')).toHaveLength(2);
    expect((await call(session, '/ignores?provider=opencode&modelId=cat-jam-free', { method: 'DELETE' })).status).toBe(404);
  });

  it('lists rejected leads after the live ones', async () => {
    const page = await (await call(session, '/leads')).json() as { leads: Array<{ status: string }> };
    const firstRejected = page.leads.findIndex(l => l.status === 'rejected');
    expect(firstRejected).toBeGreaterThan(-1);
    expect(page.leads.slice(firstRejected).every(l => l.status === 'rejected')).toBe(true);
  });

  it('closes to both callers when the extension is switched off', async () => {
    const agent = await mintAgent();
    setExtensionEnabled('external-model-discovery', false);
    expect((await call(session, '/leads')).status).toBe(404);
    expect((await call(agent, '/leads')).status).toBe(404);
    setExtensionEnabled('external-model-discovery', true);
    expect((await call(agent, '/leads')).status).toBe(200);
  });
});
