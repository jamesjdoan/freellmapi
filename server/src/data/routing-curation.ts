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
 * nemotron-3-ultra 1-2-3 in `auto:frontier` reads like depth and is actually a
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
 *
 * ORDER IS GROUNDED IN MEASUREMENT, not in catalogue tier, and four axes decide
 * it — each of which changed the answer when it was added:
 *
 *  1. Capability for the chain's purpose: intelligence, coding index, or
 *     measured latency.
 *  2. Reliability, over the trailing 14 days. Capability describes what a model
 *     does when it answers; position has to describe how often it answers at
 *     all. kimi-k3 scores 43.8 — the highest here — and succeeds 21% of 148
 *     attempts with 8 hangs, so it heads nothing and sits at Frontier 5.
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
    chains: { Frontier: 5, Apex: 4, Coding: 4, Workhorse: 4, Default: 4 },
    why: 'intelligence 44.9 — the highest in this pool, above kimi-k3 at 43.8 — with coding 74.8 and a 977K window. Two probes only, so it heads nothing: 1328ms on 2026-09-17, and a 35s answer on the 16th while the daily token quota was already spent. One route per chain because unorouter free is a single daily token quota.',
  },
  {
    platform: 'unorouter', modelId: 'glm-5.3-flash:free', classification: 'OVERFLOW',
    chains: { Vision: 4 },
    why: 'intelligence 41.9 with tools AND vision on a 977K window, 2198ms measured. Vision only: it is the unorouter route that chain\'s metric names, and a second route from the same counter would buy nothing. Timed out at 40s on 2026-09-16 against a spent quota; answered in 2.2s once it reset.',
  },
  // ── google ────────────────────────────────────────────────────
  {
    platform: 'google', modelId: 'gemini-3.8-flash', classification: 'OVERFLOW',
    chains: { Frontier: 2, Coding: 3, Vision: 3, Apex: 3 },
    why: '68% over 74 attempts. 18670ms measured. intelligence 41.2. coding 76.3. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.7-flash', classification: 'CORE',
    chains: { Coding: 1, Frontier: 1, Vision: 1, Apex: 2 },
    why: '77% over 194 attempts. 7356ms measured. intelligence 39.4. coding 76.1. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.6-flash', classification: 'CORE',
    chains: { Apex: 1, Vision: 2, Coding: 2, Frontier: 6 },
    why: '87% over 159 attempts. 15225ms measured. intelligence 34.3. coding 69.2. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.5-flash', classification: 'CORE',
    chains: { Coding: 6, Frontier: 7, Vision: 7 },
    why: '70% over 132 attempts. 8723ms measured. intelligence 33. coding 70.1. 5/min. 20/day. SCARCE — demoted a tier.',
  },
  {
    platform: 'google', modelId: 'gemini-3.5-flash-lite', classification: 'CORE',
    chains: { Workhorse: 5, Default: 5, Vision: 8 },
    why: '77% over 22 attempts. 16256ms measured. intelligence 22.7. coding 49.3. 15/min. 500/day.',
  },
  {
    platform: 'google', modelId: 'gemini-3.1-flash-lite', classification: 'CORE',
    chains: { Vision: 9 },
    why: '84% over 192 attempts. intelligence 16. coding 34.7. 15/min, 500/day — twenty-five times the allowance the Gemini Flash routes carry, which is the depth this chain needed: five of its first eight members are Google 20/day.',
  },
  {
    platform: 'google', modelId: 'gemma-4-26b-a4b-it', classification: 'SPECIALIST',
    chains: { Vision: 10 },
    why: 'Vision WITHOUT tools, which is why no agentic chain will take it and why Vision admits SPECIALIST at all. intelligence 16.7, 30/min, 4 attempts — a tail, not a fallback.',
  },
  {
    platform: 'google', modelId: 'gemini-3.1-flash-lite-preview', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 5 },
    why: 'Added 2026-09-18. 803ms measured direct. Google meters per project+model, so this is its own 20/day allowance rather than a second claim on one already counted. Fast-Lane tail: the chain had shrunk to three members, and this is depth that costs nothing until the faster heads refuse.',
  },
  // ── groq ──────────────────────────────────────────────────────
  {
    platform: 'groq', modelId: 'qwen/qwen3.8-27b', classification: 'OVERFLOW',
    chains: { Default: 2, Workhorse: 2, Frontier: 3, 'Fast-Lane': 4, Apex: 5, Coding: 5, Vision: 5 },
    why: '190ms measured, intelligence 33.9, coding 68.1, and 100% across every chain probe on 2026-09-18. Added to Frontier 3 the same day: that chain was four Google routes plus one unorouter, so a spent Google day and one credit cooldown emptied it completely — it refused all 7 candidates twice. Groq is its own counter, which is the depth Frontier was missing.',
  },
  {
    platform: 'groq', modelId: 'openai/gpt-oss-20b', classification: 'CORE',
    chains: { 'Fast-Lane': 1 },
    why: '98% over 330 attempts. 586ms measured. intelligence 9. coding 20.7.',
  },
  {
    platform: 'groq', modelId: 'openai/gpt-oss-120b', classification: 'CORE',
    chains: { Default: 8, Workhorse: 8 },
    why: '94% over 88 attempts. intelligence 12.3. One of the two most-proven routes here that was in NO chain at all — found by auditing enabled models against chain membership, not by noticing it was missing.',
  },
  // ── mistral ───────────────────────────────────────────────────
  {
    platform: 'mistral', modelId: 'ministral-3b-latest', classification: 'CORE',
    chains: { 'Fast-Lane': 2, Vision: 11 },
    why: 'Added 2026-09-18. 584ms measured against the provider directly, tools and vision, 256K window. Mistral held ELEVEN enabled models and not one chain row before this — an entire keyed provider contributing no capacity, found by auditing keys against membership. Mistral meters PER MODEL, so this is an allowance nothing else here draws on.',
  },
  // ── nvidia ────────────────────────────────────────────────────
  // nvidia/moonshotai/kimi-k3 removed 2026-09-18: 21% over 148 attempts, 65835ms
  // measured, and on the post-v0.11.0 roster it aborted at the 180s ceiling. Its
  // model row is switched off. Intelligence 43.8 was the highest in the NVIDIA
  // pool, which is exactly why it held Frontier 5 for a week: capability alone
  // kept a route that answered one call in five.
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3-ultra-550b-a55b', classification: 'CORE',
    chains: { Workhorse: 1, Default: 1, Frontier: 4, Apex: 7 },
    why: '78% over 917 attempts. 21192ms measured. intelligence 23.4. coding 49.3. 40/min. Added to Frontier 4 on 2026-09-18 for a third independent pool behind Groq: slow, but the chain needed something that is not Google and not a spent credit balance.',
  },
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3-super-120b-a12b', classification: 'CORE',
    chains: { Default: 6, Workhorse: 6 },
    why: '97% over 6883 attempts. 12729ms measured. intelligence 13.6. coding 37.7. 40/min.',
  },
  {
    platform: 'nvidia', modelId: 'nvidia/nemotron-3.5-lightning-30b-a3b', classification: 'CORE',
    chains: { Default: 7, Workhorse: 7 },
    why: '97% over 761 attempts, the best reliability figure on this install, and it was in no chain. Kept OUT of Fast-Lane deliberately: it averages 22,032ms despite publishing 288 tok/s. The middle tier does not rank on latency, so its reliability is what counts here. 40/min.',
  },
  // ── ollama ────────────────────────────────────────────────────
  {
    platform: 'ollama', modelId: 'nemotron-3-ultra', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 2 },
    why: '89% over 504 attempts. 30339ms measured. intelligence 23.4. coding 49.3. SCARCE — demoted a tier.',
  },
  {
    platform: 'ollama', modelId: 'gemma4:31b', classification: 'SPECIALIST',
    chains: { 'Extra-Tier': 4 },
    why: '5 attempt(s) — too thin to rate. 6378ms measured. intelligence 15.4. coding 43.4. SCARCE — demoted a tier.',
  },
  {
    platform: 'ollama', modelId: 'nemotron-3-super', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 5 },
    why: '62% over 395 attempts. 11896ms measured. intelligence 13.6. coding 37.7. SCARCE — demoted a tier.',
  },
  // ── opencode ──────────────────────────────────────────────────
  {
    platform: 'opencode', modelId: 'ling-3.0-flash-fin-free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 1 },
    why: '3 attempt(s) — too thin to rate. intelligence 24.9. coding 50.6. provider barely exercised here.',
  },
  {
    platform: 'opencode', modelId: 'nemotron-3-ultra-free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 3 },
    why: '72% over 145 attempts. 27385ms measured. intelligence 23.4. coding 49.3. provider barely exercised here.',
  },
  // opencode/mimo-v2.5-free removed 2026-09-18: model row switched off, so its
  // Extra-Tier row pointed at a route the router would never walk.
  // opencode/big-pickle removed 2026-09-18: model row switched off, same reason.
  // ── anyapi ────────────────────────────────────────────────────
  {
    platform: 'anyapi', modelId: 'dots-studio/dots-3-note-preview:free', classification: 'EXPERIMENTAL',
    chains: { 'Extra-Tier': 6 },
    why: 'Added 2026-09-18. Tools and vision on a 488K window, and it answered Extra-Tier on its first routed call. Intelligence reads 500 from the catalogue, which is a placeholder and not a measurement — hence EXPERIMENTAL and a tail position. Deliberately NOT in Vision despite being vision-capable: that chain admits CORE, OVERFLOW and SPECIALIST only, and its own contract refused this route when I tried. It earns Vision once it has a record rather than a placeholder. AnyAPI is one shared 100K-token/day team budget across every model.',
  },
  // ── openrouter ────────────────────────────────────────────────
  {
    platform: 'openrouter', modelId: 'nex-agi/nex-n2.5-mini:free', classification: 'OVERFLOW',
    chains: { Workhorse: 3, Default: 3, Apex: 6, Coding: 7 },
    why: '1 attempt(s) — too thin to rate. intelligence 28.2. coding 59.1. OpenRouter spends ONE account counter (1000/day, 20/min) whichever :free model answers, so only its strongest qualifying route is listed: a weaker sibling costs the same unit for less, and adds no depth because they exhaust together.',
  },
  {
    platform: 'openrouter', modelId: 'nex-agi/nex-n2.5-pro:free', classification: 'OVERFLOW',
    chains: { Vision: 6 },
    why: '2 attempt(s) — too thin to rate. intelligence 28.2. coding 59.1. OpenRouter spends ONE account counter (1000/day, 20/min) whichever :free model answers, so only its strongest qualifying route is listed: a weaker sibling costs the same unit for less, and adds no depth because they exhaust together.',
  },
  {
    platform: 'openrouter', modelId: 'inclusionai/ling-3.0-flash-sante:free', classification: 'OVERFLOW',
    chains: { 'Fast-Lane': 3 },
    why: '3 attempt(s) — too thin to rate. 1394ms measured. intelligence 24.9. coding 50.6. OpenRouter spends ONE account counter (1000/day, 20/min) whichever :free model answers, so only its strongest qualifying route is listed: a weaker sibling costs the same unit for less, and adds no depth because they exhaust together.',
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
    purpose: 'The peak of the free catalogue, for ESCALATION — the strongest capability available whether or not it suits daily volume. Deliberately NOT the same as frontier: frontier is the best practical daily driver, apex is what a request escalates TO when frontier was not enough.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW', 'EXPERIMENTAL'],
  },
  {
    name: 'Coding',
    purpose: 'Implementation worker: coding ability, tool/edit reliability, adequate context, reasonable latency, sustainable quota. The likely harness TASK role.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
  {
    name: 'Frontier',
    purpose: 'Strongest RELIABLE free general-purpose driver: the working edge a harness can sit on all day. Optimised for reasoning, coding, tool use, context and reliability together — not for maximising model count. The likely harness DEFAULT.',
    requiresTools: true, requiresVision: false,
    admits: ['CORE', 'OVERFLOW'],
  },
  {
    name: 'Workhorse',
    purpose: 'Reliable balanced middle tier: quota depth, reliability, tool support, decent intelligence, sustained throughput. Has no one-to-one harness role and does not need one.',
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
