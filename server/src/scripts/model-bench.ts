/**
 * Model screening benchmark — six short scenarios against ONE route at a time.
 *
 *   cd server
 *   ENCRYPTION_KEY=... npx tsx src/scripts/model-bench.ts --db <copy.db> --model groq/qwen/qwen3.6-27b [--model ...]
 *
 * Options
 *   --model <platform>/<modelId>   route to test (repeat for a batch)
 *   --db <path>                    SOURCE database. It is copied to a temp dir
 *                                  and only the copy is opened, so the provider
 *                                  adapters' quota bookkeeping never reaches it.
 *   --key-id <n>                   key to use (default: first usable key)
 *   --budget <tokens>              hard ceiling per model (default 6000)
 *   --runs <n>                     max runs for a borderline scenario (default 3)
 *   --effort <low|medium|high>     reasoning_effort to request
 *   --screen-only                  stage 1 only (A1, C1, C3)
 *   --only A1,C2                   just these scenarios
 *   --fresh                        ignore cached results
 *   --dry-run                      print the plan and token ceiling, call nothing
 *   --out <dir>                    results (default server/data/model-bench)
 *
 * Calls go straight to the provider adapter: no router, no chain fallback.
 * Routes that would spend paid balance are refused before any call.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Platform } from '@freellmapi/shared/types.js';
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { resolveProvider } from '../providers/index.js';
import { consumesPaidBalance } from '../services/provider-quota.js';
import { getComparePayload } from '../services/analysis.js';
import { chainRequirements, getChainMinimums } from '../services/chain-minimums.js';
import { STAGE_1, STAGE_2, type ScenarioId } from '../services/model-bench/fixtures.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../lib/sampling-params.js';
import { plannedTokens, runBenchmark, type Caller } from '../services/model-bench/runner.js';
import { buildPassport, renderMarkdown, type Passport } from '../services/model-bench/passport.js';
import { sandboxAvailable } from '../services/model-bench/sandbox.js';

interface Args {
  models: string[]; db?: string; keyId?: number; budget: number; runs: number; effort?: ReasoningEffort;
  screenOnly: boolean; only?: ScenarioId[]; fresh: boolean; dryRun: boolean; out: string;
}

function parse(argv: string[]): Args {
  const a: Args = { models: [], budget: 6000, runs: 3, screenOnly: false, fresh: false, dryRun: false, out: path.resolve('data/model-bench') };
  for (let i = 0; i < argv.length; i++) {
    const v = () => { const x = argv[++i]; if (x == null) throw new Error(`${argv[i - 1]} needs a value`); return x; };
    switch (argv[i]) {
      case '--model': a.models.push(v()); break;
      case '--db': a.db = path.resolve(v()); break;
      case '--key-id': a.keyId = Number(v()); break;
      case '--budget': a.budget = Number(v()); break;
      case '--runs': a.runs = Math.max(1, Math.min(3, Number(v()))); break;
      case '--effort': {
        const e = v();
        const effort = REASONING_EFFORTS.find(x => x === e);
        if (!effort) throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(', ')}`);
        a.effort = effort;
        break;
      }
      case '--screen-only': a.screenOnly = true; break;
      case '--only': a.only = v().split(',').map(s => s.trim().toUpperCase() as ScenarioId); break;
      case '--fresh': a.fresh = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--out': a.out = path.resolve(v()); break;
      default: throw new Error(`unknown option ${argv[i]}`);
    }
  }
  if (a.models.length === 0) throw new Error('--model <platform>/<modelId> is required');
  for (const id of a.only ?? []) if (![...STAGE_1, ...STAGE_2].includes(id)) throw new Error(`unknown scenario ${id}`);
  return a;
}

interface ModelRow { platform: string; model_id: string; display_name: string; context_window: number | null; supports_tools: number; supports_vision: number; key_id: number | null }
interface KeyRow { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null; model_scope_json: string | null }

function pickKey(model: ModelRow, keyId?: number): KeyRow {
  // Every custom relay shares platform 'custom', so "first usable custom key"
  // can be a different relay that does not serve this id. A custom route is
  // tested only through the key its catalogue row belongs to.
  if (model.platform === 'custom') {
    if (model.key_id == null) throw new Error(`custom/${model.model_id}: catalogue row names no key; cannot tell which relay serves it`);
    if (keyId != null && keyId !== model.key_id) throw new Error(`custom/${model.model_id} belongs to key ${model.key_id}, not ${keyId}`);
    keyId = model.key_id;
  }
  const keys = getDb().prepare(`
    SELECT id, encrypted_key, iv, auth_tag, base_url, model_scope_json FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown') ${keyId != null ? 'AND id = ?' : ''} ORDER BY id
  `).all(...(keyId != null ? [model.platform, keyId] : [model.platform])) as KeyRow[];
  const usable = keys.filter(k => {
    if (!k.model_scope_json) return true;
    try { return (JSON.parse(k.model_scope_json) as string[]).includes(model.model_id); } catch { return false; }
  });
  if (usable.length === 0) throw new Error(`no enabled, healthy key on ${model.platform} whose scope covers ${model.model_id}`);
  return usable[0];
}

async function benchOne(spec: string, args: Args): Promise<Passport | null> {
  const slash = spec.indexOf('/');
  const platform = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const db = getDb();
  const model = db.prepare('SELECT platform, model_id, display_name, context_window, supports_tools, supports_vision, key_id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as ModelRow | undefined;
  if (!model) throw new Error(`${spec}: no such chat model in the catalogue (ids are not guessed)`);
  if (consumesPaidBalance(platform as Platform, modelId)) throw new Error(`${spec}: would spend paid balance; refused`);
  const ids = args.only ?? (args.screenOnly ? STAGE_1 : [...STAGE_1, ...STAGE_2]);
  console.log(`\n${spec}: plan ${ids.join(' ')} · token ceiling ${plannedTokens(ids)} · budget ${args.budget}`);
  if (args.dryRun) return null;

  const key = pickKey(model, args.keyId);
  const cooling = db.prepare('SELECT MAX(expires_at_ms) AS until FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ? AND expires_at_ms > ?')
    .get(platform, modelId, Date.now()) as { until: number | null };
  if (cooling.until) throw new Error(`${spec}: on cooldown until ${new Date(cooling.until).toISOString()}; not spending calls into a known refusal`);
  const provider = resolveProvider(platform as Platform, key.base_url);
  if (!provider) throw new Error(`${spec}: no provider adapter`);
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const call: Caller = (messages, options) =>
    provider.chatCompletion(apiKey, messages, modelId, { ...options, timeoutMs: 90_000 }, { platform: platform as Platform, keyId: key.id });

  const run = await runBenchmark(call, {
    platform, modelId, endpoint: key.base_url ?? undefined, temperature: 0, seed: 7, reasoningEffort: args.effort,
    budgetTokens: args.budget, maxRuns: args.runs, fresh: args.fresh, only: args.only, screenOnly: args.screenOnly,
    cacheDir: path.join(args.out, 'cache'),
  });

  const row = getComparePayload(db).rows.find(r => r.platform === platform && r.modelId === modelId)!;
  const aaMeta = row.analysis
    ? db.prepare('SELECT index_version, fetched_at FROM aa_model WHERE slug = ?').get(row.analysis.slug) as { index_version: string | null; fetched_at: string | null } | undefined
    : undefined;
  const passport = buildPassport(run, {
    platform, modelId, displayName: model.display_name, contextWindow: model.context_window,
    supportsTools: model.supports_tools === 1, supportsVision: model.supports_vision === 1,
  }, {
    scores: row.scores,
    aa: row.analysis ? {
      slug: row.analysis.slug, name: row.analysis.name, indexVersion: aaMeta?.index_version ?? null, fetchedAt: aaMeta?.fetched_at ?? null,
      outputTokensPerSecond: row.analysis.medianOutputTokensPerSecond, timeToFirstTokenSeconds: row.analysis.medianTimeToFirstTokenSeconds,
      price1mInput: row.analysis.price1mInput, price1mOutput: row.analysis.price1mOutput,
    } : null,
  }, chainRequirements(), getChainMinimums(db).chains);

  const dir = path.join(args.out, 'passports');
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${platform}__${modelId.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  writeFileSync(`${base}.json`, JSON.stringify({ passport, run }, null, 2));
  writeFileSync(`${base}.md`, renderMarkdown(passport));
  const s = passport.internal.scenarios;
  console.log(`  ${(Object.keys(s) as ScenarioId[]).map(id => `${id}:${s[id].status}${s[id].score != null ? `(${s[id].score})` : ''}`).join(' ')}`);
  console.log(`  tokens ${passport.tokens.total} (plan ceiling ${passport.tokens.planned}) · calls ${passport.internal.operationalReliability.calls}, failed ${passport.internal.operationalReliability.failedCalls}${passport.stoppedBy ? ` · STOPPED: ${passport.stoppedBy}` : ''}`);
  console.log(`  passport ${base}.md`);
  return passport;
}

function ranking(passports: Passport[]): string {
  const weight = { qualified: 2, provisional: 1, 'insufficient evidence': 0, 'not qualified': 0 } as const;
  const rows = passports.map(p => ({
    p,
    fit: [...p.chains, ...p.ompRoles].reduce((s, r) => s + weight[r.status], 0),
  })).sort((a, b) => b.fit - a.fit || (b.p.internal.coding.value ?? -1) + (b.p.internal.agentic.value ?? -1) - (a.p.internal.coding.value ?? -1) - (a.p.internal.agentic.value ?? -1));
  return [
    '# Model screen ranking',
    '',
    'Published scores keep their provenance; internal scores are 0–100 on the screen\'s own scale and are never mixed with them.',
    '',
    '| Route | AA intelligence | AA coding | AA agentic | Internal coding | Internal agentic | Comparable | Chains | OMP roles |',
    '|---|---|---|---|---:|---:|---|---|---|',
    ...rows.map(({ p }) => {
      const pub = (c: Passport['published']['coding']) => (c.value == null ? '—' : `${c.value} (${c.provenance})`);
      const list = (rs: Passport['chains']) => rs.filter(r => r.status === 'qualified' || r.status === 'provisional').map(r => `${r.target}${r.status === 'provisional' ? '?' : ''}`).join(', ') || '—';
      return `| ${p.route.platform}/${p.route.modelId} | ${pub(p.published.intelligence)} | ${pub(p.published.coding)} | ${pub(p.published.agentic)} | ${p.internal.coding.value ?? '—'} | ${p.internal.agentic.value ?? '—'} | ${p.internal.comparable ? 'yes' : 'partial'} | ${list(p.chains)} | ${list(p.ompRoles)} |`;
    }),
    '',
    '`?` = provisional: rests on an estimate, a typed score or unverified operational evidence.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (!args.db) throw new Error('--db <path> is required (a copy is taken; the source is never opened for writing)');
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY must be set to the key that encrypted --db');
  if (!sandboxAvailable()) console.warn('warning: no OS sandbox; coding scenarios will read INCONCLUSIVE');

  const work = mkdtempSync(path.join(tmpdir(), 'fla-bench-db-'));
  try {
    const copy = path.join(work, 'freeapi.db');
    const source = new Database(args.db, { readonly: true, fileMustExist: true });
    await source.backup(copy);
    source.close();
    process.env.FREEAPI_DB_PATH = copy;
    initDb(copy);

    const passports: Passport[] = [];
    for (const spec of args.models) {
      try {
        const p = await benchOne(spec, args);
        if (p) passports.push(p);
      } catch (err) {
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
    if (passports.length > 0) {
      mkdirSync(args.out, { recursive: true });
      writeFileSync(path.join(args.out, 'ranking.md'), ranking(passports));
      console.log(`\nranking ${path.join(args.out, 'ranking.md')}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
