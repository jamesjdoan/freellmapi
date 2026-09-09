/**
 * apply-routing-curation — reconcile the live chains with the curated set.
 *
 * Chain membership lives in `profile_models`, which is runtime state an
 * operator edits from the dashboard. `data/routing-curation.ts` is the record
 * of what that state is SUPPOSED to be and why. This script is what connects
 * the two, and it is re-runnable: a catalogue sync that adds two hundred models
 * cannot silently widen a chain, because the next run switches off everything
 * the spec does not name.
 *
 * What it never does:
 *   - delete a catalogue row. Models drop out of ROUTING, not out of existence;
 *     they stay in /v1/models, stay pinnable by name, and stay discoverable.
 *   - touch `models.enabled`. That flag is catalogue visibility, and using it to
 *     express routing policy would hide 550 models an operator can legitimately
 *     ask for by name.
 *   - create profiles. A chain the operator has not created is reported, not
 *     invented — an eight-row INSERT that quietly changes what `auto:apex`
 *     means is not something a sync script should do on its own.
 *
 * Usage:
 *   tsx src/scripts/apply-routing-curation.ts            # dry run, prints the plan
 *   tsx src/scripts/apply-routing-curation.ts --apply    # write it
 *   tsx src/scripts/apply-routing-curation.ts --db <path>
 */
import { initDb, getDb } from '../db/index.js';
import {
  CURATED_ROUTES,
  CHAIN_CONTRACTS,
  chainMembers,
  type ChainName,
} from '../data/routing-curation.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

interface ModelRow { id: number; platform: string; model_id: string; supports_tools: number; supports_vision: number }

export interface CurationPlan {
  /** Chain rows to switch on, with the priority the spec gives them. */
  enable: { chain: ChainName; modelDbId: number; platform: string; modelId: string; priority: number; wasEnabled: boolean }[];
  /** Chain rows the spec does not name, currently routing. */
  disable: { chain: ChainName; modelDbId: number; platform: string; modelId: string }[];
  /** Spec entries with no catalogue row — a retired model, or a typo. */
  missingModels: { platform: string; modelId: string }[];
  /** Spec chains with no `profiles` row. */
  missingChains: ChainName[];
  /** Contract violations: a member that cannot do what its chain promises. */
  violations: { chain: ChainName; platform: string; modelId: string; reason: string }[];
}

/**
 * Work out the reconciliation without performing it.
 *
 * Separated from the write so the dry run and the apply cannot disagree about
 * what would happen, and so tests can assert the plan against a seeded DB
 * without mutating anything.
 */
export function planCuration(): CurationPlan {
  const db = getDb();
  const plan: CurationPlan = { enable: [], disable: [], missingModels: [], missingChains: [], violations: [] };

  // Catalogue rows keyed the way the spec names them. `endpoint_scope = ''`
  // restricts this to catalogue platforms: a relay serving the same model id is
  // a different route with different economics and is not what the spec means.
  const models = db.prepare(
    "SELECT id, platform, model_id, supports_tools, supports_vision FROM models WHERE endpoint_scope = ''",
  ).all() as ModelRow[];
  const byKey = new Map<string, ModelRow>();
  for (const m of models) byKey.set(`${m.platform}\u0000${m.model_id}`, m);

  const profiles = db.prepare('SELECT id, name FROM profiles').all() as { id: number; name: string }[];
  const profileByName = new Map<string, number>();
  for (const p of profiles) profileByName.set(p.name.toLowerCase(), p.id);

  for (const route of CURATED_ROUTES) {
    if (!byKey.has(`${route.platform}\u0000${route.modelId}`)) {
      plan.missingModels.push({ platform: route.platform, modelId: route.modelId });
    }
  }

  for (const contract of CHAIN_CONTRACTS) {
    const profileId = profileByName.get(contract.name.toLowerCase());
    if (profileId === undefined) {
      plan.missingChains.push(contract.name);
      continue;
    }

    const wanted = new Map<number, { priority: number; platform: string; modelId: string }>();
    for (const member of chainMembers(contract.name)) {
      const row = byKey.get(`${member.platform}\u0000${member.modelId}`);
      if (!row) continue; // already reported as missing
      // The contract is checked against the CATALOGUE's capability flags, not
      // against the spec's opinion of the model. A vision chain that admits a
      // text-only model is a broken promise however confidently it was written.
      if (contract.requiresTools && row.supports_tools !== 1) {
        plan.violations.push({ chain: contract.name, platform: row.platform, modelId: row.model_id, reason: 'chain requires tools, model has supports_tools = 0' });
        continue;
      }
      if (contract.requiresVision && row.supports_vision !== 1) {
        plan.violations.push({ chain: contract.name, platform: row.platform, modelId: row.model_id, reason: 'chain requires vision, model has supports_vision = 0' });
        continue;
      }
      wanted.set(row.id, { priority: member.priority, platform: row.platform, modelId: row.model_id });
    }

    const existing = db.prepare(
      'SELECT pm.model_db_id, pm.enabled, m.platform, m.model_id FROM profile_models pm JOIN models m ON m.id = pm.model_db_id WHERE pm.profile_id = ?',
    ).all(profileId) as { model_db_id: number; enabled: number; platform: string; model_id: string }[];
    const existingIds = new Set(existing.map(r => r.model_db_id));

    for (const [modelDbId, want] of wanted) {
      plan.enable.push({
        chain: contract.name, modelDbId, platform: want.platform, modelId: want.modelId,
        priority: want.priority, wasEnabled: existing.some(r => r.model_db_id === modelDbId && r.enabled === 1),
      });
      if (!existingIds.has(modelDbId)) existingIds.add(modelDbId); // insert path
    }

    for (const row of existing) {
      if (wanted.has(row.model_db_id) || row.enabled !== 1) continue;
      plan.disable.push({ chain: contract.name, modelDbId: row.model_db_id, platform: row.platform, modelId: row.model_id });
    }
  }

  return plan;
}

/**
 * Apply a plan. One transaction: a half-curated chain — new members enabled,
 * old ones still routing — is a worse state than either end of the change.
 */
export function applyCuration(plan: CurationPlan): void {
  const db = getDb();
  const profiles = db.prepare('SELECT id, name FROM profiles').all() as { id: number; name: string }[];
  const profileByName = new Map<string, number>();
  for (const p of profiles) profileByName.set(p.name.toLowerCase(), p.id);

  const upsert = db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = 1
  `);
  const disable = db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ? AND model_db_id = ?');

  db.transaction(() => {
    for (const row of plan.enable) {
      const profileId = profileByName.get(row.chain.toLowerCase());
      if (profileId === undefined) continue;
      upsert.run(profileId, row.modelDbId, row.priority);
    }
    for (const row of plan.disable) {
      const profileId = profileByName.get(row.chain.toLowerCase());
      if (profileId === undefined) continue;
      disable.run(profileId, row.modelDbId);
    }
  })();
}

function main(): void {
  initDb(arg('db'));
  const plan = planCuration();

  for (const chain of CHAIN_CONTRACTS) {
    const rows = plan.enable.filter(r => r.chain === chain.name).sort((a, b) => a.priority - b.priority);
    const off = plan.disable.filter(r => r.chain === chain.name);
    console.log(`\nauto:${chain.name.toLowerCase()} — ${rows.length} routed, ${off.length} switched off`);
    for (const r of rows) console.log(`  ${String(r.priority).padStart(2)}  ${r.platform}/${r.modelId}${r.wasEnabled ? '' : '  (new)'}`);
  }

  if (plan.violations.length > 0) {
    console.log('\nCONTRACT VIOLATIONS (not applied):');
    for (const v of plan.violations) console.log(`  ${v.chain}: ${v.platform}/${v.modelId} — ${v.reason}`);
  }
  if (plan.missingModels.length > 0) {
    console.log('\nSpec names models absent from the catalogue:');
    for (const m of plan.missingModels) console.log(`  ${m.platform}/${m.modelId}`);
  }
  if (plan.missingChains.length > 0) {
    console.log(`\nMissing profiles (create them before applying): ${plan.missingChains.join(', ')}`);
  }

  const totals = `${plan.enable.length} chain rows enabled, ${plan.disable.length} switched off`;
  if (!process.argv.includes('--apply')) {
    console.log(`\nDRY RUN — ${totals}. Re-run with --apply to write.`);
    return;
  }
  applyCuration(plan);
  console.log(`\nApplied: ${totals}. Catalogue rows untouched.`);
}

// Importable for tests; only runs the CLI when invoked directly.
if (process.argv[1] && process.argv[1].endsWith('apply-routing-curation.ts')) main();
