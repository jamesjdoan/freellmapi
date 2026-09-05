import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

let app: Express;
let dashboardToken = '';

async function getGuidance(authorized: boolean) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}/api/keys/quota-guidance`, {
    headers: authorized ? { Authorization: `Bearer ${dashboardToken}` } : {},
  });
  const body = await response.json().catch(() => null);
  server.close();
  return { status: response.status, body };
}

describe('GET /api/keys/quota-guidance', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashboardToken = mintDashboardToken();
  });

  it('requires dashboard authentication', async () => {
    const response = await getGuidance(false);
    expect(response.status).toBe(401);
  });

  it('returns the reviewed extension catalogue without credentials', async () => {
    const response = await getGuidance(true);
    expect(response.status).toBe(200);
    expect(response.body.version).toBe('2026.09.02');
    expect(response.body.providers.map((provider: any) => provider.platform)).toEqual([
      'google', 'groq', 'huggingface', 'nvidia', 'ollama', 'opencode', 'openrouter',
    ]);
    expect(JSON.stringify(response.body)).not.toContain('encrypted_key');
    expect(JSON.stringify(response.body)).not.toContain('maskedKey');
  });

  it('separates shared account guidance from model-specific limits', async () => {
    const response = await getGuidance(true);
    const openrouter = response.body.providers.find((provider: any) => provider.platform === 'openrouter');
    expect(openrouter).toMatchObject({
      scope: 'shared_pool',
      status: 'verified',
      recommendedLimits: { rpmLimit: 20, rpdLimit: 50 },
    });

    const groq = response.body.providers.find((provider: any) => provider.platform === 'groq');
    const gptOss = groq.models.find((model: any) => model.modelId === 'openai/gpt-oss-120b');
    expect(gptOss).toMatchObject({
      scope: 'model',
      recommendedLimits: { rpmLimit: 30, rpdLimit: 1000, tpmLimit: 8000, tpdLimit: 200000 },
    });
  });

  it('keeps unsupported or uncertain economics reference-only', async () => {
    const response = await getGuidance(true);
    const huggingface = response.body.providers.find((provider: any) => provider.platform === 'huggingface');
    expect(huggingface.facts).toContainEqual(expect.objectContaining({ metric: 'credits', amount: 0.1, period: 'month', applicability: 'reference_only' }));
    expect(huggingface.recommendedLimits).toBeNull();

    const opencode = response.body.providers.find((provider: any) => provider.platform === 'opencode');
    expect(opencode.status).toBe('uncertain');
    expect(opencode.recommendedLimits).toBeNull();
  });
});
