import fs from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { connectDb } from '../../../db/index.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';
const CUSTOM_PROVIDER_MODALITIES_FILENAME = '20260627_000001_custom_provider_modalities.ts';
const CATALOG_MODEL_STATE_FILENAME = '20260627_000002_catalog_model_state.ts';
const REQUEST_AGGREGATES_FILENAME = '20260628_120000_request_aggregates.ts';
const GITHUB_GPT41_CONTEXT_FILENAME = '20260630_000001_github_gpt41_context.ts';
const REQUEST_CLIENT_INFO_FILENAME = '20260706_000001_request_client_info.ts';
const CUSTOM_MODEL_TOOL_SUPPORT_FILENAME = '20260706_000002_custom_model_tool_support.ts';
const PROFILE_CHAIN_BACKFILL_FILENAME = '20260714_000001_profile_chain_backfill.ts';
const KEY_HEALTH_ERROR_FILENAME = '20260720_000001_key_health_error.ts';
const COOLDOWN_PROBE_PROVENANCE_FILENAME = '20260726_000001_cooldown_probe_provenance.ts';
const REQUEST_ATTEMPTS_FILENAME = '20260726_000002_request_attempts.ts';
const MODEL_SOURCE_PROVENANCE_FILENAME = '20260726_000003_model_source_provenance.ts';
const MEDIA_MODEL_META_FILENAME = '20260726_000004_media_model_meta.ts';
const REQUEST_SERVED_MODEL_FILENAME = '20260726_000005_request_served_model.ts';
const ATTEMPT_ERROR_SUMMARY_FILENAME = '20260726_000006_attempt_error_summary.ts';
const AGENT_COMPATIBILITY_FILENAME = '20260727_000001_agent_compatibility.ts';
const TOMBSTONE_PROVENANCE_FILENAME = '20260728_000001_tombstone_provenance.ts';
const CUSTOM_MODEL_ENDPOINT_IDENTITY_FILENAME = '20260729_000001_custom_model_endpoint_identity.ts';
const CUSTOM_ENDPOINT_HOST_LABELS_FILENAME = '20260802_000001_custom_endpoint_host_labels.ts';
const KEY_MODEL_SCOPE_FILENAME = '20260805_000001_key_model_scope.ts';
const CLIENT_PROFILES_FILENAME = '20260805_000002_client_profiles.ts';
const API_KEY_PROXY_FILENAME = '20260810_000001_api_key_proxy.ts';
const CUSTOM_MODEL_TOMBSTONES_FILENAME = '20260819_000001_custom_model_tombstones.ts';
const PLAYGROUND_CONVERSATIONS_FILENAME = '20260820_000001_playground_conversations.ts';
const SERVER_LOGS_FILENAME = '20260823_000001_server_logs.ts';
const BACKUPS_TABLE_FILENAME = '20260823_000002_backups_table.ts';
const ATTEMPT_KEY_LABEL_FILENAME = '20260823_000003_attempt_key_label.ts';
const PROFILE_AUTO_INCLUDE_FILENAME = '20260823_000004_profile_auto_include.ts';
const IDEMPOTENCY_CLAIMS_FILENAME = '20260901_000001_idempotency_claims.ts';
const QUOTA_OBSERVATION_LOOKUP_FILENAME = '20260901_000002_quota_observation_lookup.ts';
const REQUEST_CALLER_FILENAME = '20260901_000003_request_caller.ts';
const ANALYTICS_LATENCY_PERCENTILE_INDEX_FILENAME = '20260902_000001_analytics_latency_percentile_index.ts';
const PROVIDER_ACCOUNT_LIMITS_FILENAME = '20260902_000002_provider_account_limits.ts';
const MCP_ENABLED_DEFAULT_FILENAME = '20260903_000001_mcp_enabled_default.ts';
const RESPONSE_CACHE_FILENAME = '20260903_000002_response_cache.ts';
const KEY_MONTHLY_BUDGET_FILENAME = '20260904_000001_key_monthly_budget.ts';
const QUOTA_POLICY_FILENAME = '20260905_000001_quota_policy.ts';
const ROUTING_DECISION_FILENAME = '20260905_000002_routing_decision.ts';
const ROUTING_DECISION_ENDPOINT_FILENAME = '20260905_000003_routing_decision_endpoint.ts';
const QUOTA_POLICY_ENDPOINT_FILENAME = '20260905_000004_quota_policy_endpoint.ts';
const QUOTA_BURN_RUN_FILENAME = '20260906_000001_quota_burn_run.ts';
const QUOTA_UNIT_FILENAME = '20260906_000002_quota_unit.ts';
const REQUEST_ATTEMPT_ROUTING_TRACE_FILENAME = '20260909_000001_request_attempt_routing_trace.ts';
const CATALOGUE_CHANGE_TRACKING_FILENAME = '20260910_000001_catalogue_change_tracking.ts';
const CATALOGUE_EVENT_LOG_FILENAME = '20260910_000002_catalogue_event_log.ts';
const ANALYSIS_BENCHMARKS_FILENAME = '20260911_000001_analysis_benchmarks.ts';
const MODEL_GROUPS_FILENAME = '20260911_000002_model_groups.ts';
const DROP_MODEL_GROUPS_FILENAME = '20260911_000003_drop_model_groups.ts';
const PROXY_DELTA_FILENAME = '20260911_000004_proxy_delta.ts';
const PROXY_DELTA_PER_METRIC_FILENAME = '20260911_000005_proxy_delta_per_metric.ts';
const PROXY_DELTA_SPEED_FILENAME = '20260911_000006_proxy_delta_speed.ts';
const QUOTA_PROBE_RUN_FILENAME = '20260911_000007_quota_probe_run.ts';
const QUOTA_POLICY_PERIOD_KEY_FILENAME = '20260911_000008_quota_policy_period_key.ts';
const QUOTA_POLICY_BUCKET_FILENAME = '20260912_000001_quota_policy_bucket.ts';
const AA_COST_PER_TASK_FILENAME = '20260913_000001_aa_cost_per_task.ts';
const KEY_MONTHLY_USAGE_FILENAME = '20260914_000001_key_monthly_usage.ts';
const PRESERVE_QUOTA_STATE_FILENAME = '20260914_999999_preserve_quota_state.ts';
const QUOTA_SNAPSHOT_FRESHNESS_FILENAME = '20260915_000001_quota_snapshot_freshness.ts';

interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

interface DatabaseSnapshot {
  schema: SchemaRow[];
  rows: Record<string, unknown[]>;
}

describe('migration round trip', () => {

  // The manifest is the production order (the runner maps DEFAULT_MIGRATIONS
  // for the default set and only localeCompare-sorts a scanned directory), so
  // an entry missing from it is a migration that silently never runs. That is
  // exactly how a schema change gets lost in a rebase, and nothing else here
  // would notice.
  it('references every migration on disk, in filename order', () => {
    const onDisk = fs.readdirSync(new URL('../../../db/migrations/', import.meta.url))
      .filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts'))
      .sort((a, b) => a.localeCompare(b));
    const manifest = DEFAULT_MIGRATIONS.map(m => m.filename);
    expect(manifest).toEqual(onDisk);
    // Sorted, so the explicit array and a scanned directory cannot disagree.
    expect(manifest).toEqual([...manifest].sort((a, b) => a.localeCompare(b)));
  });
  it('connectDb opens a connection without applying migrations', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const db = connectDb(':memory:');

    try {
      expect(hasTable(db, 'models')).toBe(false);
      expect(hasTable(db, 'migrations')).toBe(false);
    } finally {
      db.close();
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('runs the legacy baseline against existing legacy DBs so rebased legacy changes apply', async () => {
    const db = new Database(':memory:');

    try {
      runLegacyBaseline(db);
      db.prepare(`
        UPDATE models
           SET enabled = 1
         WHERE platform = 'opencode'
           AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
      `).run();

      expect(getEnabledZenDeadPromoCount(db)).toBe(2);

      await runMigrations(db, 'up');

      expect(getEnabledZenDeadPromoCount(db)).toBe(0);
      // The runner must apply EVERY manifest entry, in manifest order. A
      // hardcoded copy of the list here only ever drifts; what matters is
      // that nothing in DEFAULT_MIGRATIONS is silently skipped.
      expect(getAppliedMigrationNames(db)).toEqual(DEFAULT_MIGRATIONS.map(m => m.filename));
    } finally {
      db.close();
    }
  });

  it('runs all migrations up, down to baseline, then up to the same schema', async () => {
    const db = new Database(':memory:');

    try {
      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);

      // The catalog seed has no custom models, so the custom-model tool-support
      // backfill only alters state once a user endpoint exists. Seed one (in its
      // post-migration state, tools = 1) so the round trip actually exercises
      // that migration's down (tools -> 0) and up (tools -> 1).
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, enabled, source)
        VALUES ('custom', 'roundtrip-custom', 'Roundtrip Custom', 50, 50, 1, 0, 1, 'user')
      `).run();

      // Same reasoning for the endpoint-label rename (#704): it only touches
      // custom api_keys rows, so seed one in its post-migration state (labelled
      // with its host) for the down (host -> 'Custom') and up to exercise.
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url)
        VALUES ('custom', '127.0.0.1:11434', 'x', 'x', 'x', 'http://127.0.0.1:11434/v1')
      `).run();

      // Same again for the /mcp lifecycle seed (#925): it reads api_keys, and
      // with the key above present its post-migration state is enabled ('1').
      // The first up ran against an empty api_keys and wrote '0', so pin the
      // post-seed value here for down (row removed) and up (row rewritten) to
      // round trip.
      db.prepare(`
        INSERT INTO settings (key, value) VALUES ('enable_mcp', '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run();

      const fullState = snapshotAppState(db);
      await runDownToBaseline(db);

      expect(getAppliedMigrationNames(db)).toEqual([LEGACY_BASELINE_FILENAME]);

      await runMigrations(db, 'up');
      expect(getPendingMigrationNames(db)).toEqual([]);
      expect(snapshotAppState(db)).toEqual(fullState);
    } finally {
      db.close();
    }
  });
  it('preserves original provider_quota_state rows in archive through freshness migration', async () => {
    const db = new Database(':memory:');
    try {
      // Apply baseline so tables exist
      runLegacyBaseline(db);
      // Seed a provider_quota_state row with confidence and reset_at
      db.prepare(`
        INSERT INTO provider_quota_state
          (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, reset_strategy, source, confidence, notes, observed_at, updated_at)
        VALUES ('groq', 1, 'groq::account', 'requests', 1000, 900, '2026-09-15T00:00:00Z', 'provider_reported', 'header', 0.9, 'seed', datetime('now'), datetime('now'))
      `).run();

      // Run all remaining migrations (archive then freshness)
      await runMigrations(db, 'up');

      // Verify archive table exists and holds the original values
      const archived = db.prepare(`
        SELECT platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, reset_strategy, source, confidence, notes, unit
        FROM provider_quota_state_pre_v0_11_0
      `).all();

      expect(archived.length).toBe(1);
      expect(archived[0]).toMatchObject({
        platform: 'groq',
        key_id: 1,
        quota_pool_key: 'groq::account',
        metric: 'requests',
        limit_value: 1000,
        remaining_value: 900,
        reset_at: '2026-09-15T00:00:00Z',
        reset_strategy: 'provider_reported',
        source: 'header',
        confidence: 0.9,
        notes: 'seed',
        // The seed predates the migration that adds `unit`, so this row has
        // none. The archive still carries the column; the live-DB rehearsal
        // covered rows that do have one.
        unit: null,
      });

      // Live state may have been altered by freshness; ensure archive unchanged
      const live = db.prepare(`
        SELECT confidence FROM provider_quota_state WHERE platform='groq' AND key_id=1 AND quota_pool_key='groq::account' AND metric='requests'
      `).get();
      // Freshness sets confidence to 0 when no observation, so confidence becomes 0
      expect(live?.confidence).toBe(0);
    } finally {
      db.close();
    }
  });
});

async function runDownToBaseline(db: Database.Database): Promise<void> {
  while (getAppliedMigrationNames(db).length > 1) {
    const migrationName = getLatestAppliedMigrationName(db);
    const before = snapshotAppState(db);

    await runMigrations(db, 'down');

    // A migration that rewrites ROWS rather than schema is correctly a no-op
    // here: this database has no rows for it to rewrite. It declares that
    // itself, so the assertion keeps its teeth for every schema migration
    // instead of being weakened for all of them.
    if (DEFAULT_MIGRATIONS.find(m => m.filename === migrationName)?.module.dataOnly === true) continue;

    expect(snapshotAppState(db), `${migrationName} down() must alter app DB state or throw irreversible`)
      .not.toEqual(before);
  }
}

function getLatestAppliedMigrationName(db: Database.Database): string {
  const row = db.prepare(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `).get() as { filename: string } | undefined;

  if (!row) throw new Error('No applied migrations found');
  return row.filename;
}

function getAppliedMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'applied')
    .map(status => status.filename);
}

function getPendingMigrationNames(db: Database.Database): string[] {
  return getMigrationStatuses(db)
    .filter(status => status.status === 'pending')
    .map(status => status.filename);
}

function getEnabledZenDeadPromoCount(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
      FROM models
     WHERE platform = 'opencode'
       AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       AND enabled = 1
  `).get() as { count: number };

  return row.count;
}

function snapshotSchema(db: Database.Database): SchemaRow[] {
  return db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'table', 'trigger', 'view')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY type, name
  `).all() as SchemaRow[];
}

function snapshotAppState(db: Database.Database): DatabaseSnapshot {
  const tableNames = getAppTableNames(db);
  const rows: Record<string, unknown[]> = {};

  for (const tableName of tableNames) {
    rows[tableName] = snapshotTableRows(db, tableName);
  }

  return {
    schema: snapshotSchema(db),
    rows,
  };
}

function getAppTableNames(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name <> 'migrations'
     ORDER BY name
  `).all() as { name: string }[];

  return rows.map(row => row.name);
}

function snapshotTableRows(db: Database.Database, tableName: string): unknown[] {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as { name: string }[];
  const orderBy = columns.map(column => quoteIdentifier(column.name)).join(', ');

  return db.prepare(`
    SELECT *
      FROM ${quoteIdentifier(tableName)}
     ORDER BY ${orderBy}
  `).all() as unknown[];
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(tableName);

  return Boolean(row);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
