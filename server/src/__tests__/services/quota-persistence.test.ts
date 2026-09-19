import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  upsertQuotaPolicy,
  listQuotaPolicies,
  resolveEffectiveQuotas,
} from '../../services/quota-policy.js';
import {
  getReservationWeights,
  setReservationWeights,
  getQuotaRoutingMode,
  setQuotaRoutingMode,
  recordRoutingDecision,
  listRoutingDecisions,
} from '../../services/quota-routing.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('quota persistence', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory for this test
    // path.join, not concatenation: tmpdir() has no trailing separator, so
    // `tmpdir() + name` creates a SIBLING of the temp dir rather than a child.
    tempDir = mkdtempSync(path.join(tmpdir(), 'quota-persistence-'));
    dbPath = path.join(tempDir, 'test.db');
    // Initialize the DB at this path
    initDb(dbPath);
  });

  afterEach(() => {
    // Clean up the temporary directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    // Ensure any leftover temp dirs are cleaned up (should already be done)
  });

  // Helper to insert a dummy API key and model needed for quota resolution
  function seedBaseData(): number {
    const db = getDb();
    // Insert an API key
    db.prepare('INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)').run('test-platform', 'test-key', 'x', 'x', 'x', 'healthy', 1);
    const apiKeyId = Number(db.prepare('SELECT last_insert_rowid()').get().last_insert_rowid);

    // Insert a model
    db.prepare('INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, supports_vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'test-platform',
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
    return apiKeyId;
  }

  it('quota policy persists across DB reopen and is resolved', () => {
    const apiKeyId = seedBaseData();
    const db = getDb();

    // Insert a quota policy
    const policyInput = {
      platform: 'test-platform',
      modelId: 'test-model',
      scope: 'provider_account' as const,
      metric: 'requests' as const,
      periodKind: 'calendar_day' as const,
      periodMs: null,
      timezone: 'UTC',
      anchorDay: null,
      limit: 100,
      priority: 0,
      enabled: true,
      source: 'operator',
      confidence: 0.8,
      notes: '',
    };
    const upserted = upsertQuotaPolicy(policyInput);
    expect(upserted).toHaveProperty('id');
    const policyId = upserted.id;

    // Close and reopen the DB by calling initDb again with same path
    initDb(dbPath);
    const db2 = getDb();

    // Verify the policy still exists
    const policies = listQuotaPolicies('test-platform');
    expect(policies).toHaveLength(1);
    expect(policies[0]!.id).toBe(policyId);
    expect(policies[0]!.limit).toBe(100);

    // Verify that resolveEffectiveQuotas returns the policy
    const effective = resolveEffectiveQuotas('test-platform', 'test-model');
    // We expect at least one quota (from the policy) since catalog limits are null
    expect(effective).toHaveLength(1);
    expect(effective[0].metric).toBe('requests');
    expect(effective[0].limit).toBe(100);
    expect(effective[0].period).toEqual({ kind: 'calendar_day', timezone: 'UTC' });
    expect(effective[0].source).toBe('operator');
  });

  it('reservation weights survive DB reopen', () => {
    seedBaseData(); // ensure DB is initialized
    const db = getDb();

    // Set reservation weights
    const weights = { 'test-platform': 0.5, 'other-platform': 0.2 };
    setReservationWeights(weights);

    // Close and reopen
    initDb(dbPath);
    const db2 = getDb();

    // Verify weights persist
    const persisted = getReservationWeights();
    expect(persisted).toEqual(weights);
  });

});