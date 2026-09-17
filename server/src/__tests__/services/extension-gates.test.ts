/**
 * Each gate must actually change behaviour, and must not destroy data doing it.
 *
 * A switch that persists but governs nothing is worse than no switch: the panel
 * then reports a state the router does not honour. One case per wired
 * extension, asserting what a consumer observes on each side of the toggle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, setSetting, getSetting } from '../../db/index.js';
import { setExtensionEnabled, resetExtensionStateCache } from '../../services/extension-state.js';
import { EXTENSION_STATE_KEY } from '@freellmapi/shared/extension-registry.js';
import { getProviderPreferences, PROVIDER_PREFERENCES_KEY } from '../../services/model-groups.js';
import { quotaDomainsAdmit, invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import { startBurnRun, BurnStartError } from '../../services/quota-burn.js';
import { pollProviderUsageApis } from '../../services/provider-usage-api.js';
import { getQuotaForecast } from '../../services/quota-forecast.js';
import { applyCuration } from '../../scripts/apply-routing-curation.js';
import { persistRequestAttempts } from '../../lib/request-log.js';

describe('extension gates change behaviour', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(EXTENSION_STATE_KEY);
    resetExtensionStateCache();
  });

  it('provider-preference: the saved order is read when on, ignored when off, kept either way', () => {
    const saved = JSON.stringify({
      version: 1,
      groups: { 'qwen3.8-27b': { mode: 'preferred', memberOrder: ['groq:qwen/qwen3.8-27b'] } },
    });
    setSetting(PROVIDER_PREFERENCES_KEY, saved);

    expect(getProviderPreferences().groups['qwen3.8-27b']?.memberOrder)
      .toEqual(['groq:qwen/qwen3.8-27b']);

    setExtensionEnabled('provider-preference', false);
    expect(getProviderPreferences().groups).toEqual({});
    // The row survives: switching it back on restores the order rather than
    // making the operator rebuild it.
    setExtensionEnabled('provider-preference', true);
    expect(getProviderPreferences().groups['qwen3.8-27b']?.mode).toBe('preferred');
    expect(getSetting(PROVIDER_PREFERENCES_KEY)).toBe(saved);
  });

  it('quota-ledger-precedence: an exhausted operator limit closes a route only while it is on', () => {
    // Same fixture the admission tests use: a real key, a route, an operator
    // limit of 5/day, and 5 requests already spent against it.
    const keyId = Number(getDb().prepare(
      "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','x','x','x','healthy',1)",
    ).run().lastInsertRowid);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 5,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    } as never);
    // Usage is counted from rate_limit_usage, not the requests log.
    const insert = getDb().prepare(
      "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES ('groq','twin',?,'request',0,?)",
    );
    for (let i = 0; i < 5; i++) insert.run(keyId, Date.now());
    invalidateQuotaPressure();

    const gated = quotaDomainsAdmit('groq', 'twin', '');
    setExtensionEnabled('quota-ledger-precedence', false);
    const ungated = quotaDomainsAdmit('groq', 'twin', '');

    // On: closed, and it names the domain that closed it.
    expect(gated.ok).toBe(false);
    expect(gated.blockedBy).toContain('operator');
    // Off: admitted with no opinion — upstream's own counters decide instead.
    expect(ungated).toEqual({ ok: true, blockedBy: null });
    // Either way the policy row is untouched: this gate is enforcement, not data.
    expect(getDb().prepare('SELECT COUNT(*) c FROM quota_policy').get()).toMatchObject({ c: 1 });
  });

  it('quota-forecast-warnings: the low-balance flag goes quiet, the figures stay', () => {
    const keyId = Number(getDb().prepare(
      "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','x','x','x','healthy',1)",
    ).run().lastInsertRowid);
    // 2 of 1000 left is unambiguously low on both rules.
    getDb().prepare(
      `INSERT INTO provider_quota_state
         (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_strategy, source, confidence, observed_at, updated_at)
       VALUES ('groq', ?, 'groq::account', 'requests', 1000, 2, 'provider_reported', 'header', 1, datetime('now'), datetime('now'))`,
    ).run(keyId);

    const on = getQuotaForecast()[0];
    expect(on?.low_balance).toBe(true);
    expect(on?.remaining).toBe(2);

    setExtensionEnabled('quota-forecast-warnings', false);
    const off = getQuotaForecast()[0];
    expect(off?.low_balance).toBe(false);
    // The measurement itself is untouched — only the warning is suppressed.
    expect(off?.remaining).toBe(2);
    expect(off?.limit).toBe(1000);
  });

  it('curated-routed-set: applying the curation refuses when off', () => {
    setExtensionEnabled('curated-routed-set', false);
    expect(() => applyCuration({ enable: [], disable: [] } as never)).toThrow(/switched off/i);
  });

  it('request-routing-trace: stops writing new attempt rows, keeps the ones written', () => {
    const db = getDb();
    const keyId = Number(db.prepare(
      "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','x','x','x','healthy',1)",
    ).run().lastInsertRowid);
    const requestId = Number(db.prepare(
      `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, created_at)
       VALUES ('groq','twin',?,'success',1,1,10,datetime('now'))`,
    ).run(keyId).lastInsertRowid);
    const trace = (ordinal: number) => ({
      lastRequestRowId: requestId,
      records: [{
        ordinal, platform: 'groq', modelId: 'twin', keyOrdinal: 1, keyLabel: 'k',
        outcome: 'ok', startOffsetMs: 0, durationMs: 5, errorSummary: null, routing: null,
      }],
    });
    const count = () => (db.prepare('SELECT COUNT(*) c FROM request_attempts').get() as { c: number }).c;

    persistRequestAttempts(trace(1) as never);
    expect(count()).toBe(1);

    setExtensionEnabled('request-routing-trace', false);
    persistRequestAttempts(trace(2) as never);
    // No new row, and the earlier trace is still there to read.
    expect(count()).toBe(1);
  });

  it('quota-burn-probing: refuses to start when off, and says why', () => {
    setExtensionEnabled('quota-burn-probing', false);
    expect(() => startBurnRun({ platform: 'groq', metric: 'requests' } as never))
      .toThrow(BurnStartError);
    expect(() => startBurnRun({ platform: 'groq', metric: 'requests' } as never))
      .toThrow(/switched off/i);
  });

  it('provider-usage-apis: polls nothing when off', async () => {
    setExtensionEnabled('provider-usage-apis', false);
    // Zero polled, and no provider was called: with no keys configured an
    // enabled poll would still walk the platform list.
    await expect(pollProviderUsageApis()).resolves.toBe(0);
  });
});
