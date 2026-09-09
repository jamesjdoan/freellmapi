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
// providers retire them, and an operator clicking through eight chains has no
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

/** The eight public capability classes. Names match the `profiles` rows they
 *  apply to, and resolve as `auto:<lowercased name>` for clients. */
export type ChainName =
  | 'Default' | 'Coding' | 'Apex' | 'Frontier'
  | 'Workhorse' | 'Fast-Lane' | 'Vision' | 'Extra-Tier';

export interface CuratedRoute {
  platform: string;
  modelId: string;
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
 * nemotron-3-ultra 1-2-3 in `auto:apex` reads like depth and is actually a
 * single point of failure with three names.
 *
 * Independence is asserted only where it has been observed in
 * `provider_quota_state`. Where it has not, the domain is one pool until
 * telemetry says otherwise — the conservative direction, since over-merging
 * costs some throughput and over-splitting invents capacity that is not there.
 */
export const QUOTA_DOMAINS: Record<string, { pool: string; independent: boolean; note: string }> = {
  nvidia: {
    pool: 'nvidia::credit-pool',
    independent: false,
    note: 'ONE shared balance behind every NVIDIA model. Kimi, DeepSeek and every Nemotron draw the same allowance — capability diversity, not capacity diversity.',
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
 * The routed set.
 *
 * Every provider here has a working key on this install. Providers without one
 * — navy, cloudflare, mistral, cohere, ovh, requesty, kilo, sail, xkiro,
 * pollinations and the rest of the catalogue — are not "disabled", they were
 * never routable, and adding them to a chain would only buy an attempt that
 * fails at key selection.
 *
 * Hugging Face is the one provider with a key and no routes: it is in
 * DEFAULT_AUTOROUTE_DISABLED_PLATFORMS, so a chain row for it would be filtered
 * out of every auto chain anyway. Entering CORE needs the platform re-enabled
 * first, which is a separate decision with its own evidence.
 *
 * ORDER IS GROUNDED IN MEASURED SUCCESS RATE, not in catalogue tier. The first
 * draft of this file ordered apex by capability rank and put Kimi K3 at its
 * head; seven days of live traffic says Kimi K3 succeeds on 25% of 65 attempts
 * and currently hangs for the full 180s timeout. A capability tier describes
 * what a model can do when it answers. Chain position has to describe how often
 * it answers at all, because every position above a working route is a timeout
 * the caller pays for first.
 *
 * Success rates below are over the trailing 7 days on this install and are
 * expected to age. They are recorded because the ORDER is only defensible
 * against the evidence that produced it — re-measure before reordering.
 */
export const CURATED_ROUTES: CuratedRoute[] = [
  // ── NVIDIA — one shared pool, the highest-volume provider here ────────────
  // Capability breadth is why it appears in six chains; the shared
  // `nvidia::credit-pool` is why it never takes two consecutive head positions
  // in one of them.
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3-ultra-550b-a55b', classification: 'CORE',
    chains: { Coding: 1, Apex: 1 },
    why: '82% over 313 attempts, Frontier tier, 1M context, tools. The strongest route here that is also reliable, which is exactly what apex and coding both need at position 1.',
  },
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3-super-120b-a12b', classification: 'CORE',
    chains: { Workhorse: 2, Coding: 4, Default: 2 },
    why: '97% over 5421 attempts — the most-proven route on this install. The middle tier is what it is for, and it is the safety net under coding.',
  },
  {
    platform: 'nvidia', modelId: 'minimaxai/minimax-m3', classification: 'CORE',
    chains: { Frontier: 1 },
    why: 'Heads frontier: 93% over 1302 attempts at Frontier tier. Escalation has to be both stronger AND dependable, or it is just a slower way to fail.',
  },
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b', classification: 'CORE',
    chains: { 'Fast-Lane': 3, Workhorse: 5, Default: 5 },
    why: '98% over 96 attempts with a 1M window at fast-lane cost — the one cheap route that can still take a large scouting payload.',
  },
  {
    platform: 'nvidia', modelId: 'openai/gpt-oss-20b', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 5 },
    why: '88% over 24 attempts. Same model as the Groq fast-lane head on a different pool, but behind it: this one spends the shared NVIDIA balance apex and coding depend on.',
  },
  {
    platform: 'nvidia', modelId: 'meta/llama-3.2-90b-vision-instruct', classification: 'OVERFLOW',
    chains: { Vision: 5 },
    why: 'The only non-Google vision route with tools, so it is kept — but at 20% over 10 attempts and currently benched, it is a tail, not the fallback it was first drafted as.',
  },
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', classification: 'SPECIALIST',
    chains: { Vision: 6 },
    why: 'tools=false, so barred from every agentic chain — but image analysis does not need tool calls, and rejecting vision models for lacking them would throw away most of the free multimodal capacity.',
  },
  // nvidia/moonshotai/kimi-k3 and nvidia/deepseek-ai/deepseek-v4-pro-0813 are
  // routed nowhere, and the reason is latency rather than reliability.
  //
  // Both were demoted to extra-tier on their success rates (24% of 67 and 10%
  // of 31). The post-deploy probe showed why that was not enough: they do not
  // fail, they HANG — 3 of 67 and 2 of 31 attempts held the socket for the full
  // 180s timeout, which is the entire retry budget for the request. A route
  // like that cannot be tried cheaply anywhere. Placed last it still destroys
  // every attempt behind it the moment it is reached, which is exactly what
  // happened: `auto:extra-tier` went from serving in 10s to a hard failure,
  // with kimi-k3 as attempt two of two.
  //
  // A low success rate earns a demotion. A route that costs three minutes to
  // skip earns removal, because there is no position at which it is affordable.
  // Both stay in the catalogue and stay pinnable by name.

  // ── Groq — independent per-model pools, the parallel-work provider ────────
  // Deep daily allowances (1000 RPD on the gpt-oss routes) and the fastest
  // observed latencies here. Three concurrent workers on three Groq models
  // genuinely do not contend.
  {
    platform: 'groq', modelId: 'openai/gpt-oss-120b', classification: 'CORE',
    chains: { Workhorse: 1, Apex: 3, Coding: 2, Default: 1 },
    why: '86% at 1000 RPD on its own pool. Heads workhorse and default as the most sustainable capacity here; second in coding so the two head routes cannot exhaust together.',
  },
  {
    platform: 'groq', modelId: 'openai/gpt-oss-20b', classification: 'CORE',
    chains: { 'Fast-Lane': 1, Default: 4 },
    why: 'Heads fast-lane: 98% over 219 attempts at 598ms — by a wide margin the fastest and most reliable route on this install, and the lowest opportunity cost of anything routed.',
  },
  {
    platform: 'groq', modelId: 'qwen/qwen3.6-27b', classification: 'CORE',
    chains: { 'Fast-Lane': 2, Workhorse: 4 },
    why: '60 RPM / 1000 RPD / 500K TPD is the deepest per-minute allowance routed. Bounded subagents burst; this is what absorbs it.',
  },
  // qwen/qwen3.8-27b is deliberately absent. It is the strongest Groq model in
  // the catalogue and it returns `403: blocked at the org level` on this key —
  // 0 successes in 3 attempts, with a 'tier' cooldown recorded. A route the
  // credential cannot reach is not capacity. Re-add it if the account tier
  // changes; nothing else about it is wrong.

  // ── Google — small independent per-model pools, strongest vision ──────────
  // 20 RPD per Flash model. Independent, so several of them is real depth, but
  // no single one can carry a chain. Not every generation is enabled: three
  // Flash routes and two Lite routes, chosen for capability, window and
  // measured reliability rather than catalogue completeness.
  {
    platform: 'google', modelId: 'gemini-3.7-flash', classification: 'CORE',
    chains: { Vision: 1, Apex: 2, Coding: 3, Frontier: 4 },
    why: 'Heads vision and holds apex position 2: 85% over 100 attempts at 4.4s, 1M context, tools and vision, on a pool NVIDIA cannot exhaust. The best-evidenced Google route.',
  },
  {
    platform: 'google', modelId: 'gemini-3.6-flash', classification: 'CORE',
    chains: { Vision: 2, Frontier: 3 },
    why: '89% over 91 attempts — the highest-scoring Google route measured. Second in vision on an independent per-model allowance.',
  },
  {
    platform: 'google', modelId: 'gemini-3.8-flash', classification: 'CORE',
    chains: { Frontier: 2, Vision: 3 },
    why: 'Newest Frontier-tier Google route with tools and vision. No traffic yet, so it sits second rather than first: unmeasured is not the same as good.',
  },
  {
    platform: 'google', modelId: 'gemini-3.1-flash-lite', classification: 'CORE',
    chains: { 'Fast-Lane': 4, Workhorse: 3, Default: 3 },
    why: '80% at 4.7s. The cheap Google route that is actually fast — which is what put it in fast-lane ahead of its newer sibling.',
  },
  {
    platform: 'google', modelId: 'gemini-3.5-flash-lite', classification: 'CORE',
    chains: { Vision: 4 },
    why: 'Cheap 1M-context multimodal, 75% at 26s. Kept for vision depth and kept OUT of fast-lane: a 26-second average is not a fast lane.',
  },
  {
    platform: 'google', modelId: 'gemini-robotics-er-2-preview', classification: 'SPECIALIST',
    chains: { Vision: 7 },
    why: 'Vision, tools=false. Kept for image analysis where no tool call is needed; excluded from every agentic chain by that same flag.',
  },

  // ── OpenRouter — free routes only, one shared pool ────────────────────────
  // Every entry ends in ':free' and that is enforced, not a convention: the
  // router bars any OpenRouter model without the suffix from auto chains
  // (consumesPaidBalance), because the paid twin runs on the same key and would
  // bill the balance. One shared pool, so these are tails, never heads.
  {
    platform: 'openrouter', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free', classification: 'OVERFLOW',
    chains: { Apex: 4 },
    why: '85% over 235 attempts — the apex head model on a completely independent pool. Exactly what apex should fall through to when NVIDIA credit is spent.',
  },
  {
    platform: 'openrouter', modelId: 'nvidia/nemotron-3-super-120b-a12b:free', classification: 'OVERFLOW',
    chains: { Workhorse: 6, Frontier: 5 },
    why: 'Free twin of the most-proven workhorse route, on an independent pool. Overflow rather than core: one shared free pool with a 200 RPD ceiling.',
  },
  {
    platform: 'openrouter', modelId: 'poolside/laguna-s-2.1:free', classification: 'OVERFLOW',
    chains: { Coding: 5 },
    why: 'Purpose-built coding model, 262K, tools. Overflow because the shared free pool caps at 200 RPD across every :free route together.',
  },
  {
    platform: 'openrouter', modelId: 'cohere/north-mini-code:free', classification: 'OVERFLOW',
    chains: { Coding: 6 },
    why: 'Second coding-specific free route. 50 RPD is the tightest allowance routed, so it sits last in the chain.',
  },
  {
    platform: 'openrouter', modelId: 'nvidia/nemotron-3.5-lightning:free', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 6 },
    why: 'Fast-lane tail on an independent pool, behind the Groq and Google routes because they have far deeper daily allowances.',
  },
  {
    platform: 'openrouter', modelId: 'inclusionai/ling-3.0-flash-sante:free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 4 },
    why: 'Unproven on this install. Extra-tier is where a route earns telemetry before it is trusted anywhere else.',
  },

  // ── Ollama Cloud — scarce, overflow only ──────────────────────────────────
  // ollama::weekly observed at 540/10000. The quota-pressure guardrail demotes
  // these on its own, but chain placement should not have depended on that: a
  // 5% weekly balance has no business in fast-lane at any score. Local Ollama is
  // a separate unmetered pool and is unaffected by any of this.
  {
    platform: 'ollama', modelId: 'nemotron-3-ultra', classification: 'OVERFLOW',
    chains: { Apex: 5 },
    why: '80% over 188 attempts — genuinely usable, and last in apex because its weekly balance is at 5.4% and must be reserved for the highest-value requests.',
  },
  {
    platform: 'ollama', modelId: 'nemotron-3-super', classification: 'OVERFLOW',
    chains: { 'Extra-Tier': 3 },
    why: '62% over 390 attempts, and it answers in about 3s. Too unreliable and too scarce for a critical path, but it is the most dependable thing in extra-tier and belongs ahead of the routes that hang.',
  },

  // ── OpenCode — promo, quota unknown ───────────────────────────────────────
  // Quota is genuinely unknown (probe confidence 0.1), and unknown is not
  // unlimited: the scorer ranks it at UNKNOWN_POOL_PRESSURE, between exhausted
  // and fresh, so it is used enough to be learned and not enough to be depended
  // on. Live probes returned `400 Error from provider` on three of its routes,
  // which is the second reason nothing here is near a critical path.
  {
    platform: 'opencode', modelId: 'muse-spark-1.3-contributor-free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 1, Frontier: 6 },
    why: 'Frontier tier, 1M context, tools and vision. Genuinely strong, entirely unmeasured — last in frontier, first in extra-tier.',
  },
  {
    platform: 'opencode', modelId: 'nemotron-3-ultra-free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 2 },
    why: '78% over 134 attempts, the best OpenCode route measured. Promo capacity for a model already routed on two metered pools, so overflow value only.',
  },
  {
    platform: 'opencode', modelId: 'nemotron-3.5-lightning-free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 5 },
    why: 'Promo fast route. Kept out of fast-lane proper: unknown quota plus a live 400 is not what bounded subagents should meet.',
  },
  // opencode/deepseek-v4-flash-free is deliberately absent: 0 successes in 103
  // attempts. A route that has never once served is not overflow capacity.
  // nvidia/deepseek-ai/deepseek-v4-flash-0731 is absent from CORE for the same
  // reason at a lower dose — 20% over 237 attempts with a 98s average.
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
    purpose: 'Strongest RELIABLE free general-purpose driver. Optimised for reasoning, coding, tool use, context and reliability together — not for maximising model count. The likely harness DEFAULT.',
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
    name: 'Frontier',
    purpose: 'Strongest free intelligence available, for escalation — deliberately NOT the same as apex. Apex is the best practical daily driver; frontier is the strongest capability pool whether or not it suits daily volume.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW', 'EXPERIMENTAL'],
  },
  {
    name: 'Workhorse',
    purpose: 'Reliable balanced middle tier: quota depth, reliability, tool support, decent intelligence, sustained throughput. Has no one-to-one harness role and does not need one.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
  {
    name: 'Fast-Lane',
    purpose: 'Low-latency, high-volume work: scouting, search, summaries, classification, bounded subagents. Prefers routes with the lowest opportunity cost, so spending it never costs apex.',
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
    purpose: 'Generic safe compatibility endpoint for clients that send no capability class. Behaves like a dependable general-purpose route — deliberately NOT a secret alias for the most powerful model available.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
];

/** Ordered members of one chain, as the applier will write them. */
export function chainMembers(chain: ChainName): { platform: string; modelId: string; priority: number; classification: ModelClassification }[] {
  return CURATED_ROUTES
    .filter(route => route.chains[chain] !== undefined)
    .map(route => ({
      platform: route.platform,
      modelId: route.modelId,
      priority: route.chains[chain]!,
      classification: route.classification,
    }))
    .sort((a, b) => a.priority - b.priority);
}
