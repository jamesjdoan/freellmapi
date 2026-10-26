// Curated production routing set.
//
// FreeLLMAPI discovers hundreds of models. That is the point of the catalogue
// and none of it is touched here. What this file decides is much narrower and
// much more consequential: which of those routes a HARNESS is allowed to be
// handed when it asks for a capability class rather than a model.
//
// The two are deliberately not the same set. A catalogue entry costs nothing;
// a routed one costs an attempt, a timeout budget, and — when it is a promo
// route nobody has measured — a request the operator cannot account for. So
// discovery stays wide and routing stays small.
//
//   catalogue (590 models, unchanged, all still listed and still pinnable)
//        ≠
//   routed set (this file: CORE + a thin overflow tail)
//
// Why a source file and not just the dashboard: chain membership lives in
// `profile_models`, which is runtime state. Catalogue syncs add models,
// providers retire them, and an operator clicking through six chains has no
// record of WHY a route is in one. This is that record, it is diffable, and
// `scripts/apply-routing-curation.ts` makes it re-appliable after any sync.
//
// It is not a second settings store. Nothing reads it at request time. It is
// applied to the database and then the database is the truth, exactly as
// before.

/**
 * What a routed model is FOR. Not a schema change: the catalogue has no
 * classification column and does not need one, because chain membership already
 * decides eligibility. This records the intent behind that membership so a
 * later reader can tell a deliberate overflow route from an oversight.
 */
export type ModelClassification =
  /** Verified access, known quota behaviour, acceptable reliability, and either
   *  independent capacity or a capability no CORE peer has. Critical paths. */
  | 'CORE'
  /** Real capacity, but scarce, shared with a CORE route, or less proven.
   *  Belongs at the tail of a chain, never at its head. */
  | 'OVERFLOW'
  /** Kept for one capability — vision, a specific analysis — that disqualifies
   *  it elsewhere. Usually `tools=false`, which is a reason to keep it out of
   *  agentic chains, not a reason to reject it. */
  | 'SPECIALIST'
  /** Promo, trial, or unmeasured. EXTRA-TIER only, never structural. */
  | 'EXPERIMENTAL';
// A model in no chain is DISABLED from routing by omission. Enumerating 560
// omissions would be a list nobody maintains; the applier switches off every
// chain row this file does not name, which is the same statement and cannot
// drift out of date.

/** The six public capability classes. Frontier and Workhorse were merged into
 *  Apex and Default on 2026-10-21 (91% and 93% shared membership, and each pair
 *  exhausted together); `auto:frontier` and `auto:workhorse` still resolve, as
 *  aliases in server/src/services/router.ts. Names match the `profiles` rows
 *  they apply to, and resolve as `auto:<lowercased name>` for clients. */
export type ChainName =
  | 'Default' | 'Coding' | 'Apex' | 'Fast-Lane' | 'Vision' | 'Extra-Tier';

export interface CuratedRoute {
  platform: string;
  modelId: string;
  /** The custom endpoint a `custom` route lives on — its `models.endpoint_scope`,
   *  i.e. the base URL. Omitted for catalogue platforms, whose scope is ''. Two
   *  custom keys can serve the same model id, and they are different routes with
   *  different quotas, so the id alone does not name one. */
  endpointScope?: string;
  classification: ModelClassification;
  /** Chain → position. Lower is earlier. Positions are the operator's manual
   *  order and the scorer's tiebreak; the quota-aware guardrails do the rest. */
  chains: Partial<Record<ChainName, number>>;
  /** Why this route is routed at all, and why at that position. Read this
   *  before moving anything. */
  why: string;
}

/**
 * Quota domains behind the routed set, as observed on this install.
 *
 * This is the single most important fact about the table below and the reason
 * chain order is not simply "strongest first": three NVIDIA models are three
 * capabilities but ONE allowance. Ordering kimi-k3, deepseek-v4-pro and
 * nemotron-3-ultra 1-2-3 in one chain reads like depth and is actually a
 * single point of failure with three names.
 *
 * Independence is asserted only where it has been observed in
 * `provider_quota_state`. Where it has not, the domain is one pool until
 * telemetry says otherwise — the conservative direction, since over-merging
 * costs some throughput and over-splitting invents capacity that is not there.
 */
export const QUOTA_DOMAINS: Record<string, { pool: string; independent: boolean; note: string }> = {
  nvidia: {
    pool: 'nvidia::model::<model>',
    independent: true,
    note: 'Per-model windows, measured 2026-09-12/14 — 40 req/min each, recorded as a policy on all 18 enabled models. A 70-call burst served 38 and refused 32 while a SECOND model served in the same second the first was refusing; a later three-model burst saw each hit its own 429 after 10-14 calls rather than all stopping together at 40. Previously recorded as one shared credit-pool, which understated the account by roughly 18x and hid every NVIDIA balance from the Quota overview.',
  },
  groq: {
    pool: 'groq::model::<model>',
    independent: true,
    note: 'Per-model pools, observed. gpt-oss-120b, gpt-oss-20b and qwen3.8-27b are three genuinely independent allowances, which makes Groq the best source of parallel capacity here.',
  },
  google: {
    pool: 'google::project-model::<model>',
    independent: true,
    note: 'Per-model project pools, but tiny: 20 RPD on the Flash routes. Independent and precious — depth comes from having several, not from any one of them.',
  },
  openrouter: {
    pool: 'openrouter::free',
    independent: false,
    note: 'One shared free-request pool across every :free route. Paid twins on the same key bill openrouter::credits and are barred from auto chains entirely (consumesPaidBalance).',
  },
  ollama: {
    pool: 'ollama::weekly',
    independent: false,
    note: 'One weekly balance, priced per model. Observed at 540/10000 (5.4%) — scarce, so overflow only and never for trivial work. Local Ollama is a separate unmetered pool and is unaffected.',
  },
  opencode: {
    pool: 'opencode::promo',
    independent: false,
    note: 'Promo capacity, quota UNKNOWN (confidence 0.1, probe only). Usable cautiously while it is learned; never structural.',
  },
};

/**
 * The routed set, as applied to the database on 2026-09-14.
 * Frontier and Workhorse were merged into Apex and Default on 2026-10-21 —
 * 91% and 93% shared membership, each pair exhausting together — and the
 * surviving chains were renumbered contiguously; see the chain contracts.
 *
 * ORDER IS GROUNDED IN MEASUREMENT, not in catalogue tier, and four axes decide
 * it — each of which changed the answer when it was added:
 *
 *  1. Capability for the chain's purpose: intelligence, coding index, or
 *     measured latency.
 *  2. Reliability, over the trailing 14 days. Capability describes what a model
 *     does when it answers; position has to describe how often it answers at
 *     all. kimi-k3 scores 43.8 — the highest here — and succeeds 21% of 148
 *     attempts with 8 hangs, so it heads nothing and sat at Frontier 5.
 *  3. Scarcity. Google's Flash routes are 20/day and Ollama Cloud is one
 *     monthly balance; both are demoted a tier rather than excluded.
 *  4. Provenance. An unproven provider and an unmeasured route both take a
 *     penalty: unknown is not a qualification.
 *
 * Then two structural rules: at most two members drawing on one quota pool, and
 * distinct pools across the head, so a chain has depth at the moment its first
 * choice refuses.
 *
 * Fast-Lane is ordered on MEASURED latency, not published tokens/sec, because
 * the two disagree: nemotron-3.5-lightning publishes 288 tok/s and averages
 * 22,032ms over 735 successful calls, while qwen3.8-27b publishes the lowest
 * tok/s in the set and answers in 190ms. Ordered on the published figure, the
 * fast lane led with its slowest route and took 31.8s; it now answers in 291ms.
 *
 * Numbers below are from this install and are expected to age. They are
 * recorded because the ORDER is only defensible against the evidence that
 * produced it — re-measure before reordering.
 */
export const CURATED_ROUTES: CuratedRoute[] = [
  // ── bai ───────────────────────────────────────────────────────
  // ── unorouter ─────────────────────────────────────────────────
  {
    platform: 'unorouter', modelId: 'glm-5.3:free', classification: 'OVERFLOW',
    chains: { Default: 10, Coding: 11, Apex: 8, 'Fast-Lane': 17, 'Extra-Tier': 13 },
    why: 'intelligence 44.9 — the highest in this pool, above kimi-k3 at 43.8 — with coding 74.8 and a 977K window. Two probes only, so it heads nothing: 1328ms on 2026-09-17, and a 35s answer on the 16th while the daily token quota was already spent. One route per chain because unorouter free is a single daily token quota.',
  },
  // Reconciled to the live Apex chain on 2026-10-26. The reconciliation put
  // MiniMax M3.1 Flash (NV) at Apex 3 and demoted this route to 11: same
  // intelligence (41.8 vs 42.7) but it draws the ONE unorouter daily token
  // quota, and 57% over 197 attempts in the trailing fortnight against the
  // MiniMax route's first measured success.
  {
    platform: 'unorouter', modelId: 'glm-5.3-flash:free', classification: 'OVERFLOW',
    chains: { Vision: 12 },
    why: 'intelligence 41.9 with tools AND vision on a 977K window, 2198ms measured. Vision only: it is the unorouter route that chain\'s metric names, and a second route from the same counter would buy nothing. Timed out at 40s on 2026-09-16 against a spent quota; answered in 2.2s once it reset.',
  },
  // ── google ────────────────────────────────────────────────────
  {
    platform: 'google', modelId: 'gemini-3.8-flash', classification: 'OVERFLOW',
    chains: { Default: 19, Coding: 22, Apex: 14, 'Fast-Lane': 46, Vision: 11, 'Extra-Tier': 65 },
    why: '68% over 74 attempts. 18670ms measured. intelligence 41.2. coding 76.3. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.7-flash', classification: 'CORE',
    chains: { Default: 18, Coding: 21, Apex: 13, 'Fast-Lane': 45, Vision: 10, 'Extra-Tier': 64 },
    why: '77% over 194 attempts. 7356ms measured. intelligence 39.4. coding 76.1. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.6-flash', classification: 'CORE',
    chains: { Default: 9, Coding: 10, Apex: 7, 'Fast-Lane': 14, Vision: 3, 'Extra-Tier': 12 },
    why: '87% over 159 attempts. 15225ms measured. intelligence 34.3. coding 69.2. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.5-flash', classification: 'CORE',
    chains: { Default: 11, Coding: 12, Apex: 9, 'Fast-Lane': 18, Vision: 4, 'Extra-Tier': 14 },
    why: '70% over 132 attempts. 8723ms measured. intelligence 33. coding 70.1. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.5-flash-lite', classification: 'CORE',
    chains: { 'Fast-Lane': 13, 'Extra-Tier': 10 },
    why: '77% over 22 attempts. 16256ms measured. intelligence 22.7. coding 49.3. 15/min. 500/day.',
  },
  {
    platform: 'google', modelId: 'gemini-3.1-flash-lite', classification: 'CORE',
    chains: { 'Fast-Lane': 2 },
    why: '84% over 192 attempts. intelligence 16. coding 34.7. 15/min, 500/day — twenty-five times the allowance the Gemini Flash routes carry, which is the depth the Workhorse chain needed when it joined that tail at 9. Not vision-only: 500/day and tools, so its allowance serves Fast-Lane and, since the 2026-10-21 merge, the Default tail as well. A vision model is a model that can ALSO see.',
  },
  // google/gemma-4-26b-a4b-it removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'google', modelId: 'gemini-3.1-flash-lite-preview', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 15 },
    why: 'Added 2026-09-18. 803ms measured direct. Google meters per project+model, so this is its own 20/day allowance rather than a second claim on one already counted. Fast-Lane tail: the chain had shrunk to three members, and this is depth that costs nothing until the faster heads refuse.',
  },
  // ── groq ──────────────────────────────────────────────────────
  {
    platform: 'groq', modelId: 'qwen/qwen3.8-27b', classification: 'CORE',
    chains: { Default: 8, Coding: 9, Apex: 6, 'Fast-Lane': 12, Vision: 2, 'Extra-Tier': 9 },
    why: '190ms measured, intelligence 33.9, coding 68.1, and 100% across every chain probe on 2026-09-18. Added to Frontier 3 that day (a chain merged into Apex on 2026-10-21): four Google routes plus one unorouter, so a spent Google day and one credit cooldown emptied it completely — it refused all 7 candidates twice. Groq is its own counter, which is the depth that chain was missing. CORE since the 2026-10-26 reconciliation, which found it heading the live Fast-Lane: 72% over 347 attempts at 1665ms average, the fastest route on this install, on its own per-model Groq pool. Most of its failures are the 1000 output-tokens-per-minute cap, which refuses in about a second, so the request fails over quickly.',
  },
  {
    platform: 'groq', modelId: 'openai/gpt-oss-20b', classification: 'CORE',
    chains: { 'Fast-Lane': 1 },
    why: '98% over 330 attempts. 586ms measured. intelligence 9. coding 20.7.',
  },
  {
    platform: 'groq', modelId: 'openai/gpt-oss-120b', classification: 'CORE',
    chains: { 'Fast-Lane': 41 },
    why: '94% over 88 attempts. intelligence 12.3. One of the two most-proven routes here that was in NO chain at all — found by auditing enabled models against chain membership, not by noticing it was missing.',
  },
  // ── mistral ───────────────────────────────────────────────────
  // mistral/ministral-3b-latest removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'mistral', modelId: 'ministral-14b-2512', classification: 'CORE',
    chains: { 'Fast-Lane': 44 },
    why: 'Added 2026-09-18. 563ms, and it answered a real base64 PNG with the right colour — probed with an image rather than with text, because that is what this chain is for. Mistral meters per model, so this is its own allowance behind Google. Default tail too (the Workhorse membership folded here on 2026-10-21): own Mistral per-model pool, 256k, tools.',
  },
  // mistral/mistral-code-latest removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'mistral', modelId: 'codestral-latest', classification: 'CORE',
    chains: { Coding: 8 },
    why: 'Added 2026-09-18. ok on probe. A dedicated code model on its own Mistral allowance, behind mistral-code-latest.',
  },
  // mistral/ministral-8b-latest removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'mistral', modelId: 'ministral-3b-2512', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 40 },
    why: 'Added 2026-09-18. ok on probe. Fast-Lane tail: cheapest Mistral route, own allowance.',
  },
  // nvidia/openai/gpt-oss-20b removed 2026-09-23: two consecutive probes aborted
  // at the 30s ceiling while the same model answered on Groq in 405ms and on
  // Ollama in 1266ms. Taken out of the NVIDIA key scope the same day, so its
  // Coding 10 / Workhorse 13 / Fast-Lane 8 rows pointed at a route no key could
  // serve. Groq's copy still heads Fast-Lane; re-probe before restoring it.
  {
    platform: 'nvidia', modelId: 'meta/muse-glimmer-30b', classification: 'CORE',
    chains: { 'Fast-Lane': 16 },
    why: 'Added 2026-09-18. ok on probe, intelligence 8 - the strongest spare route on any key we hold, with tools and vision. Vision depth on NVIDIA\'s per-model cap. Dropped from Apex in the 2026-10-26 reconciliation: it was already disabled from the live chain before this file was reconciled, and intelligence 8 does not belong on an escalation chain.',
  },
  // openrouter/inclusionai/ling-3.0-flash-fin:free removed 2026-10-21 with the
  // Frontier chain it lived in. Its folded position in Apex was refused by the
  // single-counter rule: Apex already carries nex-n2.5-mini:free, and both
  // routes draw the ONE OpenRouter account allowance, so they would exhaust
  // together while reading as depth. Re-curate it once a chain has no
  // OpenRouter route of its own.
  // ollama/gpt-oss:120b removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // ollama/gpt-oss:20b removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'google', modelId: 'gemini-3-flash-preview', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 11 },
    why: 'Added 2026-09-18. ok on probe. Extra-Tier tail: another Google 20/day counter, which is why it is nowhere near a critical path.',
  },
  {
    platform: 'mistral', modelId: 'ministral-8b-2512', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 43 },
    why: 'Added 2026-09-18. 636ms, saw the image correctly. Its own per-model Mistral allowance; a tail because the 14b sibling is stronger for the same cost. Fast-Lane tail too: vision capability is not a reason to withhold an uncapped Mistral pool from text work.',
  },
  // ── nvidia ────────────────────────────────────────────────────
  // nvidia/moonshotai/kimi-k3 removed 2026-09-18: 21% over 148 attempts, 65835ms
  // measured, and on the post-v0.11.0 roster it aborted at the 180s ceiling. Its
  // model row is switched off. Intelligence 43.8 was the highest in the NVIDIA
  // pool, which is exactly why it held Frontier 5 for a week: capability alone
  // kept a route that answered one call in five.
  // nvidia/nvidia/nemotron-3-ultra-550b-a55b removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // nvidia/nvidia/nemotron-3-super-120b-a12b removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // nvidia/nvidia/nemotron-3.5-lightning-30b-a3b removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // nvidia/meta/llama-3.2-11b-vision-instruct removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // nvidia/google/diffusiongemma-26b-a4b-it removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'nvidia', modelId: 'z-ai/glm-5.3-flash', classification: 'CORE',
    chains: { Default: 4, Coding: 1, Apex: 1, 'Fast-Lane': 5, 'Extra-Tier': 3 },
    why: 'Heads Apex on the 2026-10-26 reconciliation. 91% over 8514 attempts in the trailing fortnight, 19219ms average, intelligence 41.8, coding 71.5, tools. NVIDIA meters per model at 40/min, so it is its own pool. When its 429s land, Apex 2-3 carry the request: this head is the chain\'s default answer, not its last one.',
  },
  {
    platform: 'nvidia', modelId: 'minimaxai/minimax-m3.1-flash', classification: 'OVERFLOW',
    chains: { Default: 15, Coding: 16, Apex: 3, 'Extra-Tier': 18 },
    why: 'Added 2026-10-26 as the replacement for the retired Minimax M3.1 routes (the Vercel "$0 to 22 Oct" key and openrouter minimax-m3.1-flash:free, both dead by 2026-10-23). The catalogue shipped supports_tools = 0 unverified; a hand probe returned finish_reason tool_calls in 1.4-1.7s, and the true flag is carried as a model_overrides row that survives catalogue sync. intelligence 42.7. Its own NVIDIA per-model pool. 2 attempts, both ok — too thin to rate, hence OVERFLOW.',
  },
  // nvidia/stepfun-ai/step-5-preview is deliberately NOT in any chain
  // (2026-10-26). Non-streamed tool calls work (finish_reason tool_calls,
  // 6.6-16s), but every routed streaming attempt fails: 6 empty_completions at
  // 10-52s and one 45s timeout in the recorded history. The supportsTools
  // override is left in place because the flag is accurate; chain membership
  // waits on a streaming fix. Re-probe streamed, not hand-rolled.
  {
    platform: 'nvidia', modelId: 'deepseek-ai/deepseek-v4.1-flash', classification: 'CORE',
    chains: { Default: 1, Coding: 7, Apex: 5, 'Fast-Lane': 6, 'Extra-Tier': 6 },
    why: '85% over 5843 attempts, 29344ms average, intelligence 39.5, tools. Its own NVIDIA per-model pool. The chain\'s highest-volume reliable worker after the head.',
  },
  {
    platform: 'nvidia', modelId: 'z-ai/glm-5.3', classification: 'OVERFLOW',
    chains: { Default: 24, Coding: 27, Apex: 17, 'Fast-Lane': 51, 'Extra-Tier': 70 },
    why: '12% over 509 attempts with 57777ms average and 45s timeouts — the least reliable member of the chain, kept only because intelligence 44.8 and coding 74.8 are the second-best figures in it and its NVIDIA per-model pool is independent. A tail, not a fallback; do not promote without a reliability change.',
  },
  // ── radeon ────────────────────────────────────────────────────
  // Radeon meters ONE account allowance across its models, so the three radeon
  // routes below are one pool wearing three names. They are recorded because
  // that pool is the highest-volume on this install, and because the
  // shared-pool rule (at most two members per chain on one pool) is already
  // broken by live state — the record should say so rather than hide it.
  {
    platform: 'radeon', modelId: 'Qwen3.8-Flash-Next', classification: 'CORE',
    chains: { Default: 3, Coding: 3, Apex: 4, 'Fast-Lane': 9, 'Extra-Tier': 2 },
    why: '93% over 1741 attempts, 56799ms average — long agent turns, not outliers. intelligence 39.8, coding 73.1, tools. The best model on the highest-volume pool here, which is why it holds Apex 4 despite sharing that pool with two chain-mates.',
  },
  {
    platform: 'radeon', modelId: 'GLM-5.3-Flash', classification: 'OVERFLOW',
    chains: { Default: 20, Coding: 23, Apex: 15, 'Fast-Lane': 47, 'Extra-Tier': 66 },
    why: '41% over 146 attempts, 98525ms average — the slowest working member. intelligence 41.8, coding 71.5. Draws the same radeon allowance as Qwen3.8-Flash-Next, so it adds reach, not depth. Apex 9.',
  },
  {
    platform: 'radeon', modelId: 'DeepSeek-V4.1-Flash', classification: 'OVERFLOW',
    chains: { Default: 12, Coding: 13, Apex: 10, 'Fast-Lane': 19, Vision: 5, 'Extra-Tier': 15 },
    why: '68% over 28 attempts, 88492ms average. intelligence 39.5, tools AND vision. Same shared radeon allowance. Apex 13.',
  },
  // ── ollama ────────────────────────────────────────────────────
  {
    platform: 'ollama', modelId: 'nemotron-3-ultra', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 11 },
    why: '89% over 504 attempts. 30339ms measured. intelligence 23.4. coding 49.3. SCARCE — demoted a tier.',
  },
  // ollama/gemma4:31b removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // ollama/nemotron-3-super removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // ── opencode ──────────────────────────────────────────────────
  // opencode/ling-3.0-flash-fin-free removed 2026-09-18: 403 'OpenCode\'s free
  // tier' on probe. So is every other model on this key - all 11 scoped ids
  // answer 403 (free tier ended) or 404 (model not supported). The whole POOL is
  // gone upstream, not one route, so Extra-Tier holds no OpenCode row at all and
  // the catalogue entries stay for the day the promo returns.
  // opencode/nemotron-3-ultra-free removed 2026-09-18: same 403, same audit.
  // opencode/mimo-v2.5-free removed 2026-09-18: model row switched off, so its
  // Extra-Tier row pointed at a route the router would never walk.
  // opencode/big-pickle removed 2026-09-18: model row switched off, same reason.
  // openrouter/deepseek/deepseek-v4-flash-0731:free removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // nvidia/nemotron-parse-2.0 removed 2026-09-19, hours after being added, and
  // the reason is worth keeping: it PROBED ok (696ms) and then failed the only
  // job Vision exists for. A real 8x8 PNG returned `empty_completion` on 1/1
  // attempt; a plain text prompt returned ' hi i i Ai i i i i'. It is a document
  // PARSER with a vision flag, not a describer, and the health probe cannot tell
  // those apart because it only sends text. Capability flags and a text probe are
  // not evidence that a vision route can see - only an image is.
  // google/gemini-flash-latest and gemini-flash-lite-latest arrived 2026-09-19 and
  // both serve, but stay OUT of every chain: a `-latest` alias resolves to a
  // concrete model we already route, so it draws on the SAME per-model daily
  // counter. A second name on one allowance is the duplicate-quota illusion.
  // nvidia/nemotron-parse-2.0's siblings on unkeyed platforms (xkiro, kilo,
  // pollinations - 254 arrivals overnight) are not evaluated: no key reaches them.
  // Audited 2026-09-23 after probing all 50 keyed routes: 46 answered, and ten
  // of the working ones stay OUT of every chain on purpose. Re-read before
  // adding any of them.
  //   mistral/codestral-2508, mistral/ministral-14b-latest — a pinned build and
  //     a `-latest` alias of codestral-latest and ministral-14b-2512, which are
  //     routed. Same per-model allowance, so no depth.
  //   mistral/mistral-code-fim-latest — fill-in-the-middle completion, not chat.
  //   mistral/voxtral-small-2507, voxtral-small-latest — audio models on a 32K
  //     window with no published intelligence score. A ping proves they answer
  //     text, not that they are fit for any chain's purpose.
  //   nvidia/nemotron-parse-2.0 — the parser above, still unable to see.
  //   openrouter/dots-studio/dots-3-note-preview:free,
  //   openrouter/inclusionai/ling-3.0-flash-vl:free,
  //   openrouter/nvidia/nemotron-3-ultra-550b-a55b:free — one OpenRouter account
  //     counter, already spent by a route in every chain.
  //   anyapi/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free — AnyAPI is one
  //     shared team budget, and the same model is already in Vision via NVIDIA.
  // ── anyapi ────────────────────────────────────────────────────
  // anyapi/dots-studio/dots-3-note-preview:free removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // ── xkiro ─────────────────────────────────────────────────────
  // xKiro free models draw ONE daily token quota across the pool — its 429
  // names "today's free-model token quota" — so the three xkiro routes are one
  // pool wearing three names. Unlike unorouter and openrouter they are NOT in
  // SINGLE_COUNTER_PLATFORMS, because the quota is tokens-per-day rather than
  // a request counter; the distinction is academic for chain depth and the
  // routes are recorded as the shared pool they are.
  {
    platform: 'xkiro', modelId: 'qwen/qwen3.8-max:free', classification: 'OVERFLOW',
    chains: { Default: 2, Coding: 2, Apex: 2, 'Fast-Lane': 4, 'Extra-Tier': 1 },
    why: '97% over 296 attempts, 18127ms average — the best reliability figure in the chain. intelligence 45.4, coding 76.2. The strongest of the three xkiro routes on the shared daily quota, which is why it holds Apex 2.',
  },
  {
    platform: 'xkiro', modelId: 'qwen/qwen3.8-omni-flash:free', classification: 'OVERFLOW',
    chains: { Default: 13, Coding: 14, Apex: 11, 'Fast-Lane': 20, Vision: 6, 'Extra-Tier': 16 },
    why: '68% over 22 attempts, 21512ms average. intelligence 39.8, tools AND vision. Same shared xKiro daily quota; kept as a tail route.',
  },
  {
    platform: 'xkiro', modelId: 'mistralai/mistral-large-4-0', classification: 'OVERFLOW',
    chains: { Coding: 18, Apex: 12 },
    why: '25% over 4 attempts — one success, three 429s against the shared xKiro daily quota — and 923ms when it answers. intelligence 38.4. Kept at the tail; its 429s are the shared counter being spent, not the model failing.',
  },
  // ── custom ────────────────────────────────────────────────────
  // Custom routes live on a named endpoint (models.endpoint_scope). The scope
  // is part of the route\'s identity here because two custom keys can serve the
  // same model id with different quotas; the applier keys on it since 2026-10-26.
  {
    platform: 'custom', modelId: 'coding-glm-5.3-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { Default: 21, Coding: 24, Apex: 16, 'Fast-Lane': 48, 'Extra-Tier': 67 },
    why: '37% over 326 attempts, 14645ms average when it answers. intelligence 44.8, coding 74.8 on a 977K window. The Inferera key answers quota-domain-exhausted(provider_header) with no reset instant — provider_quota_state has held remaining 0 since 2026-10-16 — so it spends whole days unavailable. Kept mid-chain for its context ceiling, which outruns every other member.',
  },
  // ── openrouter ────────────────────────────────────────────────
  // openrouter/nex-agi/nex-n2.5-mini:free removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // openrouter/nex-agi/nex-n2.5-pro:free removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // openrouter/inclusionai/ling-3.0-flash-sante:free removed from routing in the 2026-10-26 reconciliation: in no live chain.
  // ── recorded from live chains, 2026-10-26 ─────────────────────
  // Routes the operator added through the dashboard that this file never
  // named. Each carries its measured record; none has a curated rationale.
  // agnes
  {
    platform: 'agnes', modelId: 'agnes-2.5-pro', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 40 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 35.2, coding 62.3. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'agnes', modelId: 'agnes-3.0-flash', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 63 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 35.2, coding 62.3. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // custom
  // custom/deepseek-v4.1-flash-free removed from routing in the 2026-10-26 reconciliation: in no live chain.
  {
    platform: 'custom', modelId: 'coding-glm-5.2-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { Default: 22, Coding: 25, 'Fast-Lane': 49, 'Extra-Tier': 68 },
    why: '31% over 213 attempts, 16462ms average in the 14 days to 2026-10-26. intelligence 33.7, coding 68.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'xiaomi-mimo-v2.6-flash-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { Default: 17, Coding: 19, 'Fast-Lane': 23, 'Extra-Tier': 22 },
    why: '0% over 1 attempts in the 14 days to 2026-10-26. intelligence 37.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'xiaomi-mimo-v2.5-pro-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { Coding: 20, 'Fast-Lane': 29, 'Extra-Tier': 29 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 26.0, coding 60.2. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'xiaomi-mimo-v2-pro-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 24, 'Extra-Tier': 24 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 28.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'coding-glm-5-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 25, 'Extra-Tier': 25 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 27.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'qwen3.6-plus-preview-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 26, 'Extra-Tier': 26 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 27.0, coding 54.5. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'coding-glm-5-turbo-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 27, 'Extra-Tier': 27 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 26.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'coding-glm-5.1-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 28, 'Extra-Tier': 28 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 26.1, coding 55.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'hy3-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 30, 'Extra-Tier': 30 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 25.3, coding 58.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'xiaomi-mimo-v2.5-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 36, 'Extra-Tier': 31 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 21.8, coding 56.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'coding-minimax-m2.7-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 33, 'Extra-Tier': 32 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.8, coding 52.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'ling-3.0-flash-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 39, 'Extra-Tier': 33 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 20.1, coding 50.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'xiaomi-mimo-v2-omni-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 31, 'Extra-Tier': 34 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 23.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'coding-minimax-m2.5-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 32, 'Extra-Tier': 35 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'minimax-m2.7-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 34, 'Extra-Tier': 36 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.8, coding 52.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'coding-minimax-m2.1-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 37, 'Extra-Tier': 37 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 20.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'mimo-v2-flash-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { 'Fast-Lane': 38, 'Extra-Tier': 38 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 20.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'custom', modelId: 'xiaomi-mimo-v2.6-pro-free', classification: 'OVERFLOW',
    endpointScope: 'https://api.inferera.com/v1',
    chains: { Vision: 9 },
    why: '0% over 3 attempts in the 14 days to 2026-10-26. intelligence 46.3. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // electronhub
  {
    platform: 'electronhub', modelId: 'gpt-5.6-luna', classification: 'OVERFLOW',
    chains: { Default: 23, Coding: 26, 'Fast-Lane': 50, Vision: 13, 'Extra-Tier': 69 },
    why: '29% over 21 attempts, 29529ms average in the 14 days to 2026-10-26. intelligence 37.3, coding 71.4. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'deepseek-v4-flash', classification: 'CORE',
    chains: { Default: 6, Coding: 5, 'Fast-Lane': 8, 'Extra-Tier': 5 },
    why: '93% over 169 attempts, 50501ms average in the 14 days to 2026-10-26. intelligence 34.3, coding 69.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'qwen3.8-flash-next', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 23 },
    why: '100% over 1 attempts, 7900ms average in the 14 days to 2026-10-26. intelligence 39.8, coding 73.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'ling-3.1-flash', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 39 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 41.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'gpt-6-luna', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 44 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 38.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'mimo-v2.6-flash', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 45 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 37.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'deepseek-v4-flash-0731', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 47 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 34.3, coding 69.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'gemini-3.5-flash-lite', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 35, 'Extra-Tier': 59 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.2, coding 49.3. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'electronhub', modelId: 'minimax-m2.1', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 62 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 20.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // inferbase
  {
    platform: 'inferbase', modelId: 'qwen3-8-max', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 41 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 45.4, coding 76.2. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'moonshot-kimi-k3', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 42 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 43.6, coding 76.2. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'qwen3-8-flash', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 43 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 39.8, coding 73.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'deepseek-v4-pro', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 46 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 36.0, coding 68.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'deepseek-v4-flash-0731', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 48 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 34.3, coding 69.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'zai-glm-5-2', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 49 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 33.7, coding 68.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'qwen3-7-max', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 50 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 29.5, coding 66.0. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'minimax-m3', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 51 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 29.2, coding 58.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'zai-glm-5', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 52 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 27.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'moonshot-kimi-k2-6', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 53 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 27.0, coding 61.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'zai-glm-5-1', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 54 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 26.1, coding 55.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'moonshot-kimi-k2-7-code', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 55 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 25.8, coding 60.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'moonshot-kimi-k2-5', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 56 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 23.5, coding 46.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'minimax-m2-5', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 57 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'minimax-m2-7', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 58 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.8, coding 52.6. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'zai-glm-4-7', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 60 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 22.2, coding 45.3. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'inferbase', modelId: 'qwen3-6-27b', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 61 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 21.4, coding 53.7. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // nvidia
  {
    platform: 'nvidia', modelId: 'stepfun-ai/step-5-preview', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 21 },
    why: '0% over 7 attempts in the 14 days to 2026-10-26. intelligence 43.7. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // openrouter
  {
    platform: 'openrouter', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 20 },
    why: '100% over 1 attempts, 1531ms average in the 14 days to 2026-10-26. intelligence 22.9, coding 49.3. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'openrouter', modelId: 'nvidia/nemotron-3.5-lightning:free', classification: 'CORE',
    chains: { 'Fast-Lane': 3 },
    why: '99% over 3055 attempts, 17058ms average in the 14 days to 2026-10-26. intelligence 12.9, coding 26.8. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // radeon
  {
    platform: 'radeon', modelId: 'DeepSeek-V4-Flash', classification: 'CORE',
    chains: { Default: 5, Coding: 4, 'Fast-Lane': 7, 'Extra-Tier': 4 },
    why: '94% over 214 attempts, 43937ms average in the 14 days to 2026-10-26. intelligence 34.3, coding 69.1. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'radeon', modelId: 'Qwen3.8-27B', classification: 'CORE',
    chains: { Default: 7, Coding: 6, 'Fast-Lane': 10, Vision: 1, 'Extra-Tier': 7 },
    why: '91% over 95 attempts, 63476ms average in the 14 days to 2026-10-26. intelligence 33.7, coding 68.1. CORE since the 2026-10-26 measured reorder put it at the head of Vision: the only vision-capable route above 80% success with more than 50 attempts. Slow, and on the shared radeon allowance, so Vision 2 is groq qwen3.8-27b on its own pool.',
  },
  {
    platform: 'radeon', modelId: 'MiMo-V2.6-Flash', classification: 'OVERFLOW',
    chains: { Default: 16, Coding: 17, 'Fast-Lane': 22, Vision: 8, 'Extra-Tier': 19 },
    why: '67% over 3 attempts, 7505ms average in the 14 days to 2026-10-26. intelligence 37.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'radeon', modelId: 'DeepSeek-V4-Flash-Vision-Exp', classification: 'OVERFLOW',
    chains: { Default: 14, Coding: 15, 'Fast-Lane': 21, Vision: 7, 'Extra-Tier': 17 },
    why: '62% over 13 attempts, 21692ms average in the 14 days to 2026-10-26. intelligence 34.8, coding 65.0. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  // zhipu
  {
    platform: 'zhipu', modelId: 'glm-4.5-flash', classification: 'OVERFLOW',
    chains: { 'Extra-Tier': 8 },
    why: '84% over 63 attempts, 36369ms average in the 14 days to 2026-10-26. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
  {
    platform: 'zhipu', modelId: 'glm-4.7-flash', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 42 },
    why: 'no routed attempts in the 14 days to 2026-10-26. intelligence 14.9. Recorded from the live chain in the 2026-10-26 reconciliation, not individually curated: re-measure before moving it.',
  },
];

/** Chain contracts. Documentation for operators and the assertion the tests
 *  check membership against — the same statement in both places, so a chain
 *  cannot quietly stop meaning what it says. */
export interface ChainContract {
  name: ChainName;
  purpose: string;
  /** Every member must emit structured tool calls. */
  requiresTools: boolean;
  /** Every member must accept image input. */
  requiresVision: boolean;
  /** No member may be classified below this. Ordered CORE > OVERFLOW >
   *  SPECIALIST > EXPERIMENTAL by how much weight a chain may put on it. */
  admits: ModelClassification[];
}

export const CHAIN_CONTRACTS: ChainContract[] = [
  {
    name: 'Apex',
    purpose: 'The top chain: the strongest reliable free general driver AND what a request escalates TO when that is not enough. Frontier merged into it on 2026-10-21 — the two shared 91% of members and exhausted together — and `auto:frontier` now resolves here as an alias. Because it is also the daily driver, an unmeasured promo route does not belong in it.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
  {
    name: 'Coding',
    purpose: 'Implementation worker: coding ability, tool/edit reliability, adequate context, reasonable latency, sustainable quota. The likely harness TASK role.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
  {
    name: 'Fast-Lane',
    purpose: 'Low-latency, high-volume work: scouting, search, summaries, classification, bounded subagents. Prefers routes with the lowest opportunity cost, so spending it never costs the drivers above it.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
  {
    name: 'Vision',
    purpose: 'Screenshots, UI inspection, image analysis, visual verification. The one chain where tools=false is admissible, because image analysis does not require tool calls.',
    requiresTools: false, requiresVision: true,
    admits: ['CORE', 'OVERFLOW', 'SPECIALIST'],
  },
  {
    name: 'Extra-Tier',
    purpose: 'Overflow and experimental capacity: promo routes, less verified providers, models undergoing validation. Never early on a critical path.',
    requiresTools: false, requiresVision: false,
    admits: ['CORE', 'OVERFLOW', 'SPECIALIST', 'EXPERIMENTAL'],
  },
  {
    name: 'Default',
    purpose: 'Generic safe compatibility endpoint for clients that send no capability class: a dependable general-purpose chain with the quota depth for sustained throughput. Workhorse merged into it on 2026-10-21 — the two shared 93% of members and exhausted together — and `auto:workhorse` now resolves here as an alias. Deliberately NOT a secret alias for the most powerful model available; escalation lives in Apex.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
];

/**
 * The chain every other chain overflows into (ADR
 * ARCH-20261022-extra-tier-overflow). Named here rather than spelled out at
 * the call site so the overflow and the contract can never drift apart.
 */
export const CHAIN_EXTRA_TIER: ChainName = 'Extra-Tier';

/** Ordered members of one chain, as the applier will write them. */
export function chainMembers(chain: ChainName): { platform: string; modelId: string; endpointScope?: string; priority: number; classification: ModelClassification }[] {
  return CURATED_ROUTES
    .filter(route => route.chains[chain] !== undefined)
    .map(route => ({
      platform: route.platform,
      modelId: route.modelId,
      ...(route.endpointScope !== undefined ? { endpointScope: route.endpointScope } : {}),
      priority: route.chains[chain]!,
      classification: route.classification,
    }))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Spending a shared allowance on the best thing it can buy.
 *
 * A source whose counter is ONE pool across every model — OpenRouter's :free
 * routes share 1000/day and 20/min on the account, verified against
 * /api/v1/key — charges the same unit whichever model answers. A weaker member
 * of that pool is therefore strictly worse than its strongest: identical cost,
 * less returned, and no failover depth either, because they exhaust together.
 *
 * So a single-counter source contributes exactly ONE route per chain, and it is
 * the best that chain's own metric can name: strongest by intelligence for
 * apex, by coding index for coding, FASTEST for fast-lane, vision-capable for
 * vision. Before this rule the fast lane and workhorse both carried
 * ling-3.0-flash (28.2 -> 24.9 intelligence) while nex-n2.5 drew the very same
 * counter.
 *
 * It does NOT apply to a provider with per-model windows. Google meters 20/day
 * PER MODEL and NVIDIA 40/min per model, so a second route there is a second
 * allowance and genuine depth — which is why those providers contribute
 * several members and OpenRouter contributes one.
 *
 * unorouter joined on 2026-09-17. Its free tier is one daily TOKEN quota
 * across every :free model, stated in its own refusal: "You've reached today's
 * free-model token quota." So the same rule applies — one route per chain, the
 * best that chain's metric names.
 *
 * b.ai and OpenCode are recorded as shared pools conservatively, but both
 * refuse per model when measured (hy3 refused while qwen3.8-flash served 60
 * concurrent calls; mimo refused while ling served), so they are not treated as
 * single-counter here.
 */
export const SINGLE_COUNTER_PLATFORMS = ['openrouter', 'unorouter'] as const;
