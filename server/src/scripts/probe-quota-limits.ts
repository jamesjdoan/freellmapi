/**
 * probe-quota-limits — measure a provider's real rate limits, and record them.
 *
 * Why a burst rather than a reading: some providers publish nothing. Google
 * exposes no quota headers at all (verified by dumping every response header on
 * a 200) and its `usageMetadata` carries token counts only. The single place a
 * Gemini limit is ever stated is the body of a 429:
 *
 *   Quota exceeded for metric: …/generate_content_free_tier_requests,
 *   limit: 5, model: gemini-3.7-flash
 *   Please retry in 38.52990283s
 *
 * So the only way to learn the number is to exceed it deliberately, which costs
 * real allowance on a route that may only have twenty requests a day. That cost
 * is the reason every run is written to `quota_probe_run` with the catalogue's
 * claim beside it: the measurement should never have to be bought twice.
 *
 * Usage:
 *   tsx src/scripts/probe-quota-limits.ts --platform google --model gemini-3.7-flash
 *   tsx src/scripts/probe-quota-limits.ts --platform google --all   # every enabled model
 *   tsx src/scripts/probe-quota-limits.ts … --concurrency 40 --apply
 *
 * Without `--apply` it prints what it would send and records nothing. A probe
 * spends quota, so the dry run is the default.
 */
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordQuotaProbe } from '../services/quota-probe-log.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

interface ProbeOutcome {
  statusCodes: Record<string, number>;
  served: number;
  refused: number;
  measuredRpm: number | null;
  measuredRpd: number | null;
  retryHintMs: number | null;
  quotaBucket: string | null;
  verbatim: string | null;
}

/**
 * Reads a provider's refusal for the numbers it names.
 *
 * Google states minute and day limits with the SAME metric name, distinguished
 * only by value, so a burst that trips both reports two limits for one metric.
 * The smaller is the per-minute cap and the larger the daily one — there is no
 * other way to tell them apart, and guessing from the metric string alone
 * conflates them.
 */
export function readLimits(bodies: string[]): {
  rpm: number | null; rpd: number | null; bucket: string | null; retryMs: number | null;
} {
  const limits = new Set<number>();
  let bucket: string | null = null;
  let retryMs: number | null = null;

  for (const body of bodies) {
    for (const m of body.matchAll(/limit: (\d+), model: ([\w.-]+)/g)) {
      limits.add(Number(m[1]));
      bucket ??= m[2] ?? null;
    }
    const retry = body.match(/retry in ([\d.]+)s/);
    // The shortest hint is the per-minute one; a daily refusal quotes hours.
    if (retry) {
      const ms = Math.round(Number(retry[1]) * 1000);
      retryMs = retryMs == null ? ms : Math.min(retryMs, ms);
    }
  }

  const sorted = [...limits].sort((a, b) => a - b);
  return {
    rpm: sorted[0] ?? null,
    rpd: sorted.length > 1 ? sorted[sorted.length - 1]! : null,
    bucket,
    retryMs,
  };
}

async function probeGoogle(key: string, model: string, concurrency: number): Promise<ProbeOutcome> {
  const one = () =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 8 } }),
    })
      .then(async r => ({ status: r.status, body: r.status === 200 ? '' : await r.text() }))
      .catch(e => ({ status: 0, body: String(e) }));

  const results = await Promise.all(Array.from({ length: concurrency }, one));
  const statusCodes: Record<string, number> = {};
  for (const r of results) statusCodes[String(r.status)] = (statusCodes[String(r.status)] ?? 0) + 1;

  const served = results.filter(r => r.status === 200).length;
  const bodies = results.filter(r => r.body).map(r => r.body.replace(/\s+/g, ' '));
  const { rpm, rpd, bucket, retryMs } = readLimits(bodies);

  return {
    statusCodes,
    served,
    refused: results.length - served,
    measuredRpm: rpm,
    measuredRpd: rpd,
    retryHintMs: retryMs,
    quotaBucket: bucket,
    verbatim: bodies[0] ?? null,
  };
}

async function main(): Promise<void> {
  const platform = arg('platform');
  const concurrency = Number(arg('concurrency') ?? 40);
  const apply = process.argv.includes('--apply');
  if (platform !== 'google') {
    console.log('Only google is implemented: it is the provider that publishes no headers.');
    console.log('Another provider needs its own request shape and refusal grammar here.');
    return;
  }

  initDb(arg('db') ?? process.env.DB_PATH ?? 'server/data/freeapi.db');
  const db = getDb();

  const models = process.argv.includes('--all')
    ? db.prepare("SELECT model_id FROM models WHERE platform = 'google' AND enabled = 1").all().map((r: any) => r.model_id as string)
    : [arg('model')!].filter(Boolean);
  if (models.length === 0) {
    console.log('Name a --model, or pass --all.');
    return;
  }

  const keyRow = db.prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'google' AND enabled = 1 AND status IN ('healthy','unknown') LIMIT 1",
  ).get() as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!keyRow) {
    console.log('No usable google key.');
    return;
  }
  const key = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);

  for (const model of models) {
    const claim = db.prepare(
      "SELECT rpm_limit, rpd_limit FROM models WHERE platform = 'google' AND model_id = ?",
    ).get(model) as { rpm_limit: number | null; rpd_limit: number | null } | undefined;

    if (!apply) {
      console.log(`DRY RUN ${model}: would send ${concurrency} concurrent requests ` +
        `(catalogue claims ${claim?.rpm_limit ?? '?'}/min, ${claim?.rpd_limit ?? '?'}/day)`);
      continue;
    }

    const out = await probeGoogle(key, model, concurrency);
    recordQuotaProbe({
      platform: 'google',
      model_id: model,
      method: 'burst',
      concurrency,
      served: out.served,
      refused: out.refused,
      status_codes_json: JSON.stringify(out.statusCodes),
      measured_rpm: out.measuredRpm,
      measured_rpd: out.measuredRpd,
      catalogue_rpm: claim?.rpm_limit ?? null,
      catalogue_rpd: claim?.rpd_limit ?? null,
      retry_hint_ms: out.retryHintMs,
      quota_bucket: out.quotaBucket,
      verbatim: out.verbatim,
      notes: null,
    }, db);

    console.log(`${model}: ${JSON.stringify(out.statusCodes)} -> ` +
      `${out.measuredRpm ?? '?'}/min${out.measuredRpd ? `, ${out.measuredRpd}/day` : ''}`);

    // A rolling minute has to clear or the next model inherits this one's
    // refusals and reports a limit that is not its own.
    if (models.length > 1) await sleep(65_000);
  }
}

// Importable for tests; runs the CLI only when invoked directly, under tsx or
// as the compiled copy in the container.
if (process.argv[1] && /probe-quota-limits\.(ts|js)$/.test(process.argv[1])) void main();
