import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  acquireLease,
  releaseLease,
  resetLeases,
  recordRequest,
  countRequestsInWindow,
  invalidateShadowCounts,
  inFlightForKey,
  canMakeRequest,
} from '../../services/ratelimit.js';

describe('quota concurrency', () => {
  let testApiKeyId: number;
  let testApiKeyId2: number;
  let testModelId: string;
  const testPlatform = 'test-platform';

  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    invalidateShadowCounts();

    // Insert a dummy API key
    const db = getDb();
    const keyInfo = db.prepare('INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)').run(testPlatform, 'test-key', 'x', 'x', 'x', 'healthy', 1);
    testApiKeyId = Number(keyInfo.lastInsertRowid);

    // Insert a second API key for cross-key test
    const keyInfo2 = db.prepare('INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)').run(testPlatform, 'test-key-2', 'x', 'x', 'x', 'healthy', 1);
    testApiKeyId2 = Number(keyInfo2.lastInsertRowid);

    // Insert a dummy model
    db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      testPlatform,
      'test-model',
      'Test Model',
      100,
      100,
      'Medium',
      null,
      null,
      null,
      null,
      '',
      0,
      1,
      0
    );
    testModelId = 'test-model';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('N concurrent in-flight leases are visible to the next canMakeRequest caller', () => {
    const db = getDb();
    // Set a low RPM limit to make the test deterministic
    const limits = { rpm: 1, rpd: null, tpm: null, tpd: null };

    // Acquire 5 leases
    const leaseIds = [];
    for (let i = 0; i < 5; i++) {
      const lid = acquireLease(testPlatform, testModelId, testApiKeyId, 0); // tokens 0
      leaseIds.push(lid);
    }

    // With 5 leases in flight, canMakeRequest should be false (0 recorded + 5 in flight >= 1 rpm)
    const can = canMakeRequest(testPlatform, testModelId, testApiKeyId, limits);
    expect(can).toBe(false);

    // Release one lease
    releaseLease(leaseIds[0]);
    let canAfter = canMakeRequest(testPlatform, testModelId, testApiKeyId, limits);
    expect(canAfter).toBe(false); // still 4 in flight >= 1

    // Release all leases
    leaseIds.slice(1).forEach(releaseLease);
    const canAfterAll = canMakeRequest(testPlatform, testModelId, testApiKeyId, limits);
    expect(canAfterAll).toBe(true); // 0 in flight
  });

  it("releaseLease is idempotent and never double-decrements another lease's slot", () => {
    const db = getDb();
    // Acquire two leases
    const lid1 = acquireLease(testPlatform, testModelId, testApiKeyId, 0);
    const lid2 = acquireLease(testPlatform, testModelId, testApiKeyId, 0);

    // Release the first lease twice
    releaseLease(lid1);
    releaseLease(lid1); // should not throw

    // In-flight count should be 1 (only lid2 still held)
    const inFlight = inFlightForKey(testPlatform, testApiKeyId, Date.now());
    expect(inFlight).toBe(1);

    // Release the second lease
    releaseLease(lid2);
    const inFlightAfter = inFlightForKey(testPlatform, testApiKeyId, Date.now());
    expect(inFlightAfter).toBe(0);

    // Releasing a non-existent lease should not throw
    expect(() => releaseLease(9999)).not.toThrow();
  });

  it('interleaved recordRequest calls across several keys sum correctly in countRequestsInWindow', () => {
    const db = getDb();
    const windowMs = 60_000; // 1 minute
    const baseTime = Date.now();
    const now = baseTime;

    // We'll make 3 requests on key1 and 2 on key2
    const key1 = testApiKeyId;
    const key2 = testApiKeyId2;

    // Insert requests for key1
    for (let i = 0; i < 3; i++) {
      recordRequest(testPlatform, testModelId, key1);
    }
    // Insert requests for key2
    for (let i = 0; i < 2; i++) {
      recordRequest(testPlatform, testModelId, key2);
    }

    // The count across keys should be 5
    const count = countRequestsInWindow(testPlatform, testModelId, windowMs, now);
    expect(count).toBe(5);
  });

  it('the 5s memo does not serve a stale count after invalidateShadowCounts', () => {
    const db = getDb();
    const windowMs = 60_000;
    const baseTime = Date.now();
    let now = baseTime;

    // Insert one request
    recordRequest(testPlatform, testModelId, testApiKeyId);
    // Populate cache
    const cached1 = countRequestsInWindow(testPlatform, testModelId, windowMs, now);
    expect(cached1).toBe(1);

    // Insert another request (so true count is now 2)
    recordRequest(testPlatform, testModelId, testApiKeyId);
    // Without invalidating, should still return cached value (if within 5s)
    const cached2 = countRequestsInWindow(testPlatform, testModelId, windowMs, now);
    expect(cached2).toBe(1); // stale

    // Invalidate cache
    invalidateShadowCounts();
    // Now should get fresh count
    const fresh = countRequestsInWindow(testPlatform, testModelId, windowMs, now);
    expect(fresh).toBe(2);
  });
});