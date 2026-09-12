/**
 * probe-daily-cap — walk a model to its DAILY refusal and record what it says.
 *
 * The per-minute ceiling can be found in seconds by over-sending. A daily one
 * cannot: the only way a provider names it is to reach it, which costs the whole
 * allowance and leaves the route unusable until reset. That is the price of the
 * number, and it is why each run is written to `quota_probe_run` with the
 * provider's words attached.
 *
 * Telling the two apart matters. Google states both on ONE metric name and
 * distinguishes them only by value:
 *
 *   limit: 5,  model: gemini-3.7-flash   ← per minute, retry in ~38s
 *   limit: 20, model: gemini-3.7-flash   ← per day,    retry in hours
 *
 * So a refusal naming the per-minute number is just the pacing working; the run
 * waits out the window and continues. A refusal naming anything else is the
 * daily cap and ends the run.
 *
 * Usage:
 *   tsx src/scripts/probe-daily-cap.ts --model gemini-3.5-flash-lite --rpm 15 --budget 60
 *   tsx src/scripts/probe-daily-cap.ts … --apply
 *
 * `--budget` bounds the spend. Without a ceiling found inside it the run records
 * a lower bound, which is still worth having: "at least 300/day" rules out the
 * 20/day the catalogue assumes.
 */
import { initDb, getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordQuotaProbe } from '../services/quota-probe-log.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

interface Attempt { status: number; body: string }

async function send(key: string, model: string): Promise<Attempt> {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 8 } }),
  })
    .then(async r => ({ status: r.status, body: r.status === 200 ? '' : (await r.text()).replace(/\s+/g, ' ') }))
    .catch(e => ({ status: 0, body: String(e) }));
}

/** The limits a refusal names, excluding the per-minute one we already know. */
function namedLimits(body: string, perMinute: number): number[] {
  return [...body.matchAll(/limit: (\d+)/g)]
    .map(m => Number(m[1]))
    .filter(n => n !== perMinute);
}

async function main(): Promise<void> {
  const model = arg('model');
  const perMinute = Number(arg('rpm') ?? 5);
  const budget = Number(arg('budget') ?? 60);
  const apply = process.argv.includes('--apply');
  if (!model) {
    console.log('Name a --model.');
    return;
  }

  initDb(arg('db') ?? process.env.DB_PATH ?? 'server/data/freeapi.db');
  const db = getDb();
  const keyRow = db.prepare(
    "SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'google' AND enabled = 1 AND status IN ('healthy','unknown') LIMIT 1",
  ).get() as { encrypted_key: string; iv: string; auth_tag: string } | undefined;
  if (!keyRow) {
    console.log('No usable google key.');
    return;
  }
  const key = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);

  const claim = db.prepare("SELECT rpm_limit, rpd_limit FROM models WHERE platform = 'google' AND model_id = ?")
    .get(model) as { rpm_limit: number | null; rpd_limit: number | null } | undefined;

  if (!apply) {
    console.log(`DRY RUN ${model}: would send up to ${budget} requests at ${perMinute}/min ` +
      `(~${Math.ceil(budget / perMinute)} minutes), stopping at the first refusal naming a limit other than ${perMinute}.`);
    return;
  }

  const statusCodes: Record<string, number> = {};
  let served = 0;
  let refused = 0;
  let dailyLimit: number | null = null;
  let verbatim: string | null = null;
  let retryMs: number | null = null;

  for (let sent = 0; sent < budget && dailyLimit == null; sent += perMinute) {
    const batch = Math.min(perMinute, budget - sent);
    const results = await Promise.all(Array.from({ length: batch }, () => send(key, model)));

    for (const r of results) {
      statusCodes[String(r.status)] = (statusCodes[String(r.status)] ?? 0) + 1;
      if (r.status === 200) { served += 1; continue; }
      refused += 1;
      const other = namedLimits(r.body, perMinute);
      if (other.length > 0 && dailyLimit == null) {
        dailyLimit = Math.max(...other);
        verbatim = r.body;
        const retry = r.body.match(/retry in ([\d.]+)s/);
        retryMs = retry ? Math.round(Number(retry[1]) * 1000) : null;
      }
    }

    console.log(`  sent ${sent + batch}/${budget} · served ${served} · refused ${refused}` +
      (dailyLimit != null ? ` · DAILY LIMIT ${dailyLimit}` : ''));

    // The per-minute window has to clear before the next batch, or its
    // refusals would be mistaken for the daily ceiling.
    if (dailyLimit == null && sent + batch < budget) await sleep(62_000);
  }

  recordQuotaProbe({
    platform: 'google',
    model_id: model,
    method: 'burst',
    concurrency: served + refused,
    served,
    refused,
    status_codes_json: JSON.stringify(statusCodes),
    measured_rpm: null,
    measured_rpd: dailyLimit,
    catalogue_rpm: claim?.rpm_limit ?? null,
    catalogue_rpd: claim?.rpd_limit ?? null,
    retry_hint_ms: retryMs,
    quota_bucket: null,
    verbatim,
    notes: dailyLimit != null
      ? `Daily ceiling found by walking the model to refusal at ${perMinute}/min.`
      : `No daily ceiling inside a budget of ${budget} requests: the allowance is at least ${served}/day, ` +
        `which is the useful half of the answer when the catalogue assumes ${claim?.rpd_limit ?? 'less'}.`,
  }, db);

  console.log(dailyLimit != null
    ? `${model}: daily limit ${dailyLimit} (served ${served} before refusal)`
    : `${model}: no daily ceiling within ${budget} — at least ${served}/day`);
}

if (process.argv[1] && /probe-daily-cap\.(ts|js)$/.test(process.argv[1])) void main();
