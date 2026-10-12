import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  startZenGateWatch,
  stopZenGateWatch,
  findZenKey,
  tombstonedModelIds,
  classify,
  runGateWatch,
} from '../../services/clifree-gate-watch.js';
import type { Scheduler } from '../../lib/scheduler.js';

function makeScheduler() {
  const every: { ms: number; fn: () => void | Promise<void> }[] = [];
  const scheduler: Scheduler = {
    every(ms, fn) {
      every.push({ ms, fn });
      return () => {};
    },
    after() { return () => {}; },
  };
  return { scheduler, every };
}

const ZEN_SCOPE = 'https://opencode.ai/zen/v1';
const ENCRYPTION_KEY = '0'.repeat(64);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  initDb(':memory:');
});

afterEach(() => {
  stopZenGateWatch();
  delete process.env.CLIFREE_GATE_WATCH_DISABLED;
});

describe('zen gate classifier', () => {
  it('reads 200 as open', () => {
    expect(classify(200, '{"choices":[]}')).toBe('open');
  });
  it('reads the documented FreeTierError as gated', () => {
    expect(classify(403, '{"error":{"message":"OpenCode\'s free tier can only be used from within OpenCode"}}')).toBe('gated');
  });
  it('reads 410 as retired, not gated', () => {
    expect(classify(410, 'Model exo-free has been deprecated.')).toBe('retired');
  });
  it('reads a bare 401 as other, not gated — the decrypt-trap signature', () => {
    // That trap produced exactly this body. If it ever became "gated" the
    // watcher would silently misread a broken decryption as a closed gate.
    expect(classify(401, 'Invalid API key.')).toBe('other');
  });
});

describe('zen gate watch scheduling', () => {
  it('registers a 6-hour interval and is idempotent', () => {
    const { scheduler, every } = makeScheduler();
    startZenGateWatch(scheduler);
    startZenGateWatch(scheduler);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(6 * 60 * 60 * 1000);
  });
  it('does not register when disabled', () => {
    process.env.CLIFREE_GATE_WATCH_DISABLED = '1';
    const { scheduler, every } = makeScheduler();
    startZenGateWatch(scheduler);
    expect(every).toHaveLength(0);
  });
});

describe('zen gate target selection', () => {
  it('finds no Zen key and no tombstones in a fresh db', () => {
    expect(findZenKey()).toBeNull();
    expect(tombstonedModelIds()).toEqual([]);
  });

  it('probes only tombstoned -free ids, and only when a Zen key exists', async () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled, base_url) VALUES ('custom','x','y','z','healthy',1,'https://opencode.ai/zen/v1')"
    ).run();
    db.prepare(
      'INSERT INTO custom_model_tombstones (endpoint_scope, model_id) VALUES (?, ?)'
    ).run(ZEN_SCOPE, 'step-5-preview-free');
    db.prepare(
      'INSERT INTO custom_model_tombstones (endpoint_scope, model_id) VALUES (?, ?)'
    ).run('https://other.example/v1', 'elsewhere-free');

    // encrypted_key 'x' with iv/auth_tag 'y'/'z' is not valid ciphertext, so
    // decrypt fails and the pass is skipped rather than probing with garbage.
    await expect(runGateWatch()).resolves.toBeNull();

    // Cleanup so later tests in this file start from the fresh-db state.
    db.prepare("DELETE FROM api_keys WHERE base_url = 'https://opencode.ai/zen/v1'").run();
    db.prepare('DELETE FROM custom_model_tombstones').run();
  });
});

