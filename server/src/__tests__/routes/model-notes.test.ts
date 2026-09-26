import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// A parked model's reason ("410 end of life at NVIDIA") is the operator's note,
// kept by (platform, model_id) so it outlives the catalogue re-inserting the row.

let app: Express;
let token = '';

async function call(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json };
}

function addModel(modelId: string): number {
  return Number(getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source)
    VALUES ('nvidia', ?, ?, 1, 1, 'Large', 0, 'user')
  `).run(modelId, modelId).lastInsertRowid);
}

async function noteOf(modelId: string) {
  const res = await call('GET', '/api/analysis/compare');
  return res.body.rows.find((r: { modelId: string }) => r.modelId === modelId)?.note;
}

describe('model notes', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('saves, updates the date alone, clears, and survives the model row being re-inserted', async () => {
    const id = addModel('deepseek-ai/deepseek-v4-flash-0731');
    expect(await noteOf('deepseek-ai/deepseek-v4-flash-0731')).toBeNull();

    expect((await call('PATCH', `/api/models/${id}`, { note: '  410 end of life at NVIDIA  ', recheckAt: '2026-10-26' })).status).toBe(200);
    expect(await noteOf('deepseek-ai/deepseek-v4-flash-0731')).toMatchObject({ text: '410 end of life at NVIDIA', recheckAt: '2026-10-26' });

    // A date-only edit keeps the text; a text-only edit keeps the date.
    await call('PATCH', `/api/models/${id}`, { recheckAt: '2026-11-01' });
    expect(await noteOf('deepseek-ai/deepseek-v4-flash-0731')).toMatchObject({ text: '410 end of life at NVIDIA', recheckAt: '2026-11-01' });
    await call('PATCH', `/api/models/${id}`, { note: 'EOL, checked again' });
    expect(await noteOf('deepseek-ai/deepseek-v4-flash-0731')).toMatchObject({ text: 'EOL, checked again', recheckAt: '2026-11-01' });

    // The catalogue drops and re-adds the row: the note is still attached.
    getDb().prepare('DELETE FROM models WHERE id = ?').run(id);
    const again = addModel('deepseek-ai/deepseek-v4-flash-0731');
    expect(await noteOf('deepseek-ai/deepseek-v4-flash-0731')).toMatchObject({ text: 'EOL, checked again' });

    // Blank text removes the note and its date together.
    await call('PATCH', `/api/models/${again}`, { note: '' });
    expect(await noteOf('deepseek-ai/deepseek-v4-flash-0731')).toBeNull();
  });

  it('refuses a date that is not YYYY-MM-DD', async () => {
    const id = addModel('moonshotai/kimi-k3');
    expect((await call('PATCH', `/api/models/${id}`, { note: 'slow', recheckAt: '26/10/2026' })).status).toBe(400);
  });
});
