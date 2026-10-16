import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadeonProvider } from '../../providers/radeon.js';
import * as providers from '../../providers/index.js';
import { initDb, getDb } from '../../db/index.js';
import { NodeScheduler } from '../../lib/scheduler.js';
import { resetExtensionStateCache, setExtensionEnabled } from '../../services/extension-state.js';
import { startRadeonPressurePolling } from '../../services/radeon-pressure.js';

const NOW = Date.parse('2026-10-14T09:00:00Z');
const body = { scope: 'fleet', models: { 'GLM-5.3-Flash': { state: 'full', utilization: 100 } } };
let stopPolling: (() => void) | undefined;

/** Respect aborts so the former five-second bound fails the delayed-source case. */
function delayedFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init?.signal;
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve(new Response(JSON.stringify(body), { status: 200 }));
    }, 25_000);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

afterEach(() => {
  stopPolling?.();
  stopPolling = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetExtensionStateCache();
});

describe('AMD shared-fleet pressure', () => {
  it('shares one fetch across concurrent readers and the refresh window', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
    const provider = new RadeonProvider();
    const [first, second] = await Promise.all([provider.fetchModelPressure(), provider.fetchModelPressure()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ freshness: 'fresh', observedAt: new Date(NOW).toISOString(), models: body.models });
    await provider.fetchModelPressure();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains an old measured snapshot as stale when refreshing fails', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const provider = new RadeonProvider();
    await provider.fetchModelPressure();
    time.mockReturnValue(NOW + 20_000);
    const failed = await provider.fetchModelPressure();
    expect(failed).toMatchObject({ freshness: 'stale', observedAt: new Date(NOW).toISOString(), models: body.models });
    await provider.fetchModelPressure();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not label an invalid or unavailable first reading as idle or zero', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      scope: 'fleet', models: { 'GLM-5.3-Flash': { state: 'idle', utilization: -1 } },
    }), { status: 200 }));
    const result = await new RadeonProvider().fetchModelPressure();
    expect(result.freshness).toBe('unknown');
    expect(result.observedAt).toBeNull();
    expect(result.models['GLM-5.3-Flash']).toBeUndefined();
  });

  it('does not replace valid pressure with malformed refresh data', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const provider = new RadeonProvider();
    await provider.fetchModelPressure();
    time.mockReturnValue(NOW + 65_000);
    const result = await provider.fetchModelPressure();
    expect(result.freshness).toBe('stale');
    expect(result.observedAt).toBe(new Date(NOW).toISOString());
    expect(result.models['GLM-5.3-Flash']).toEqual({ state: 'full', utilization: 100 });
  });
});

describe('AMD background capacity observation', () => {
  it('accepts a 25-second source, serves cached reads meanwhile and spaces retries from completion', async () => {
    vi.useFakeTimers({ now: NOW });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(delayedFetch);
    const provider = new RadeonProvider();
    const pending = provider.fetchModelPressure();
    const shared = provider.fetchModelPressure();
    expect(provider.getModelPressure()).toEqual({ models: {}, observedAt: null, freshness: 'unknown' });
    await vi.advanceTimersByTimeAsync(24_999);
    expect(provider.getModelPressure().freshness).toBe('unknown');
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([pending, shared]);
    expect(provider.getModelPressure()).toMatchObject({
      models: body.models, freshness: 'fresh', observedAt: new Date(NOW + 25_000).toISOString(),
    });
    await provider.fetchModelPressure();
    await vi.advanceTimersByTimeAsync(19_999);
    await provider.fetchModelPressure();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = provider.fetchModelPressure();
    await vi.advanceTimersByTimeAsync(25_000);
    await next;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('makes a successful cached reading stale at the 60-second age boundary without fetching', async () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const provider = new RadeonProvider();
    await provider.fetchModelPressure();
    time.mockReturnValue(NOW + 59_999);
    expect(provider.getModelPressure().freshness).toBe('fresh');
    time.mockReturnValue(NOW + 60_000);
    expect(provider.getModelPressure()).toMatchObject({
      freshness: 'stale', observedAt: new Date(NOW).toISOString(), models: body.models,
    });
  });

  it('collects only when configured and a capacity consumer is enabled, and stops future requests', async () => {
    vi.useFakeTimers({ now: NOW });
    initDb(':memory:');
    getDb().prepare('DELETE FROM api_keys').run();
    resetExtensionStateCache();
    setExtensionEnabled('quota-capacity-dashboard', false);
    setExtensionEnabled('amd-capacity-routing', false);
    const provider = new RadeonProvider();
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
    stopPolling = startRadeonPressurePolling(new NodeScheduler());
    setExtensionEnabled('amd-capacity-routing', true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).not.toHaveBeenCalled();
    getDb().prepare("INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled) VALUES ('radeon','synthetic','iv','tag',1)").run();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(provider.getModelPressure().models['GLM-5.3-Flash']).toEqual({ state: 'full', utilization: 100 });
    expect(fetch).toHaveBeenCalledTimes(1);
    setExtensionEnabled('amd-capacity-routing', false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    setExtensionEnabled('quota-capacity-dashboard', true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    stopPolling();
    stopPolling();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not rearm collection after being stopped during a slow source request', async () => {
    vi.useFakeTimers({ now: NOW });
    initDb(':memory:');
    resetExtensionStateCache();
    getDb().prepare("INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, enabled) VALUES ('radeon','synthetic','iv','tag',1)").run();
    const provider = new RadeonProvider();
    vi.spyOn(providers, 'getProvider').mockReturnValue(provider);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(delayedFetch);
    stopPolling = startRadeonPressurePolling(new NodeScheduler());
    expect(provider.getModelPressure().freshness).toBe('unknown');
    stopPolling();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(provider.getModelPressure().freshness).toBe('fresh');
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
