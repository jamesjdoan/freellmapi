/**
 * The Imperium fork's extensions, in one place, for both server and client.
 *
 * Two things live here and nothing else:
 *
 *  1. DOCUMENTATION - what each extension is, where its controls are, which
 *     files implement it, and precisely what stops happening when it is
 *     switched off. `offBehaviour` and `takesEffect` are required on every
 *     entry: an operator disabling something is entitled to know whether their
 *     saved data survives and when the change bites.
 *  2. The ENABLEMENT DEFAULT. Nothing else about a feature is configured here.
 *     Provider order, quota limits, benchmark mappings, probe budgets and
 *     routing modes keep their existing stores. A toggle decides whether an
 *     extension runs; it never becomes a second copy of its settings.
 *
 * Mutable state is one JSON document in `settings` under `imperium_extensions`
 * (see ExtensionState below), loaded once into an immutable snapshot so a gate
 * on the request path costs a map lookup rather than a SELECT.
 *
 * OFF IS NEVER DESTRUCTIVE. Schema migrations always run. Rows, tables and
 * parameters stay. Disabling the merge extension does not un-merge models;
 * disabling the catalogue log does not delete its history.
 */

export type ExtensionCategory =
  /** Changes what is shown. Off = upstream's UI, with no loss of stored data. */
  | 'presentation'
  /** Changes which physical route a request gets. Off = upstream's routing. */
  | 'routing'
  /** Prevents a class of harm. Off needs an explicit, recorded decision. */
  | 'safety'
  /** Operator tooling outside the request path. Off = the command refuses. */
  | 'tooling';

export type ExtensionDestination = {
  kind: 'internal' | 'external';
  label: string;
  href: string;
};

export type ImperiumExtension = {
  /** Stable id. One independently toggleable extension per id, and the key
   *  used in the persisted `enabled` map - never renamed once shipped. */
  id: string;
  title: string;
  summary: string;
  /** Where its own parameters live. Human-readable, not a route to parse. */
  settingsLocation: string;
  destinations: ExtensionDestination[];
  category: ExtensionCategory;
  /** Initialisation default for an id absent from the persisted document.
   *  The paid-balance guard is always true and may not ship otherwise. */
  defaultEnabled: boolean;
  /** Exactly what stops happening, and what is retained, when off. */
  offBehaviour: string;
  /** The boundary at which a change applies: next request, next job, next
   *  page load, next invocation - including anything already in flight. */
  takesEffect: string;
  /** Files and symbols that implement it, including its gate. Maintenance
   *  metadata for a reader; never resolved or executed. */
  codeLocations: string[];
  /** Dangerous transitions need a fixed, named confirmation policy. */
  disableConfirmation: 'none' | 'paid-spend';
};

/** The one mutable document, stored as JSON in `settings.imperium_extensions`. */
export interface ExtensionState {
  version: 1;
  /** Monotonic, for compare-and-set writes and client refresh. */
  revision: number;
  enabled: Record<string, boolean>;
  /** Required before the paid-balance guard may be off. Cleared when the
   *  guard returns on, so a second disable must be acknowledged again. An
   *  off guard with no acknowledgement is rejected at load. */
  paidSpendAcknowledgement: null | { policyVersion: 1; confirmedAt: string };
}

export const EXTENSION_STATE_KEY = 'imperium_extensions';

/** The exact string a disable request must carry for the paid-balance guard. */
export const PAID_SPEND_CONFIRMATION = 'ALLOW PAID SPEND';

export const IMPERIUM_EXTENSIONS: readonly ImperiumExtension[] = [
  // ── Routing ───────────────────────────────────────────────────────────────
  {
    id: 'provider-preference',
    title: 'Provider preference ordering',
    summary: 'Keep one unified model name while choosing which healthy provider should be tried first.',
    settingsLocation: 'Models → Chat models → choose a unified model',
    destinations: [{ kind: 'internal', label: 'Choose a model', href: '/models/chat' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Saved preference order is ignored and candidates fall back to score order. The stored preferences are kept and apply again when re-enabled.',
    takesEffect: 'Next request. An in-flight request keeps the ordering it started with.',
    codeLocations: ['server/src/services/router.ts (orderChain)', 'client/src/lib/provider-preferences.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-pool-routing',
    title: 'Quota-pool-aware routing',
    summary: 'Track shared, per-model, project, credit, unknown and local capacity without double-counting it.',
    settingsLocation: 'Automatic routing; usage context: Models → Chat models → Monthly token budget',
    destinations: [{ kind: 'internal', label: 'View usage budget', href: '/models/chat#quota-pools' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Pool identity stops gating admission; upstream per-key quota semantics apply. Recorded observations and policies are retained.',
    takesEffect: 'Next request.',
    codeLocations: ['server/src/services/provider-quota.ts (resolveQuotaPolicy, inferQuotaPoolKey)', 'server/src/services/router.ts (quotaDomainsAdmit)'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-ledger-precedence',
    title: 'Quota ledger and precedence resolver',
    summary: 'Rank every claim about a limit in one place: live provider header, then provider usage API, then an operator’s typed limit, then configured provider knowledge, then the catalogue - and keep unknown distinct from zero.',
    settingsLocation: 'Quota → Provider overview; operator limits at Keys → key row → Models & account limits',
    destinations: [{ kind: 'internal', label: 'Open quota dashboard', href: '/quota' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Admission stops consulting the typed ledger and uses upstream’s counters alone. The quota_policy rows, their provenance and their history all remain.',
    takesEffect: 'Next request.',
    codeLocations: ['server/src/services/quota-policy.ts', 'server/src/services/quota-clock.ts', 'server/src/db/migrations/20260905_000001_quota_policy.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-aware-scoring',
    title: 'Scarcity, reset-urgency and provider spreading',
    summary: 'Score a route on how much of its allowance is left, how soon that allowance resets, and whether a concurrent worker is already drawing on the same counter.',
    settingsLocation: 'Quota → Shadow routing (mode is opt-in: off, shadow or active)',
    destinations: [{ kind: 'internal', label: 'Open shadow routing', href: '/quota#shadow' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Scores revert to capability and health alone. The recorded routing decisions are kept, and the existing off/shadow/active mode is NOT promoted by enabling this.',
    takesEffect: 'Next request.',
    codeLocations: ['server/src/services/quota-routing.ts (evaluateShadowDecision)', 'server/src/services/quota-pressure.ts', 'server/src/db/migrations/20260905_000002_routing_decision.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'curated-routed-set',
    title: 'Curated routed set and classifications',
    summary: 'A small production set drawn from a large discovery catalogue: each route classified CORE, OVERFLOW, SPECIALIST, EXPERIMENTAL or DISABLED, with its chain membership, position and the measured reason for that position.',
    settingsLocation: 'Fallback → chain membership; source of truth in server/src/data/routing-curation.ts',
    destinations: [{ kind: 'internal', label: 'Open fallback chains', href: '/fallback' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Chain membership is left to whatever the database holds; the curated contract stops being asserted. No catalogue row and no chain row is deleted.',
    takesEffect: 'Next request. Applying the curation to the database is a separate, explicit action.',
    codeLocations: ['server/src/data/routing-curation.ts', 'server/src/scripts/apply-routing-curation.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'relist-restores-membership',
    title: 'Relist restores chain membership',
    summary: 'A model that leaves the catalogue and comes back returns to the exact chains and positions it was serving, instead of coming back enabled and in no chain.',
    settingsLocation: 'Automatic, on catalogue sync',
    destinations: [{ kind: 'internal', label: 'Open the catalogue log', href: '/models/chat' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'A returning model is reinstated without its chain rows, as upstream does. The recorded membership stays on its tombstone and is restored if re-enabled before the next departure.',
    takesEffect: 'Next catalogue sync.',
    codeLocations: ['server/src/services/model-state.ts (serializeChainMembership, restoreChainMembership)', 'server/src/db/migrations/20260910_000001_catalogue_change_tracking.ts'],
    disableConfirmation: 'none',
  },
  // `model-health-verdicts` was listed here and is deliberately NOT toggleable.
  // Its two behaviours - PROBE_MAX_TOKENS = 64, and reading a provider 5xx as
  // `limited` rather than `dead` - are bug fixes, not preferences. The old
  // 4-token budget guaranteed a false verdict for every model that reasons
  // before it answers (measured: 13-29 thinking tokens before the first answer
  // token, so the probe could never see one), and a single 500 marked a route
  // that serves as permanently dead. A switch for that would read "report
  // wrong verdicts again", so there is no entry rather than a dishonest one.
  // Implemented at server/src/services/model-health.ts.
  {
    id: 'provider-account-limits',
    title: 'Provider account limits',
    summary: 'Set credential-wide RPM, RPD and TPD gates independently from model-specific catalogue limits.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
    destinations: [{ kind: 'internal', label: 'Open account limits', href: '/keys' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Account-wide gates stop being enforced; per-model catalogue limits still apply. The stored numbers are kept.',
    takesEffect: 'Next request.',
    codeLocations: ['server/src/db/migrations/20260902_000002_provider_account_limits.ts', 'server/src/services/ratelimit.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'provider-usage-apis',
    title: 'Provider usage APIs',
    summary: 'Read the balance a provider will actually tell you - Ollama Cloud’s monthly credit, OpenRouter’s credits - and treat it as authoritative over anything inferred.',
    settingsLocation: 'Quota → Provider overview (source column)',
    destinations: [{ kind: 'internal', label: 'Open quota dashboard', href: '/quota' }],
    category: 'routing',
    defaultEnabled: true,
    offBehaviour: 'Balances come from headers and inference only. Previously polled readings stay in the observation history.',
    takesEffect: 'Next poll.',
    codeLocations: ['server/src/services/provider-usage-api.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-forecast-warnings',
    title: 'Forecast and low-balance warnings',
    summary: 'Report the tightest remaining window per pool and warn before it runs out, rather than after the first refusal.',
    settingsLocation: 'Quota → Provider overview; Models → Chat models → Monthly token budget',
    destinations: [{ kind: 'internal', label: 'Open quota dashboard', href: '/quota' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The warning and the tightest-pool reduction are hidden. Upstream’s own forecast rows remain available, and no observation is discarded.',
    takesEffect: 'Next page load.',
    codeLocations: ['server/src/services/quota-forecast.ts (getQuotaForecast, LOW_BALANCE_THRESHOLD)', 'client/src/pages/QuotaPage.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-burn-probing',
    title: 'Burn-down probing',
    summary: 'Measure an unpublished allowance by spending a bounded, known amount of it, instead of guessing from a pricing page.',
    settingsLocation: 'Quota → Shadow routing → probe actions',
    destinations: [{ kind: 'internal', label: 'Open quota dashboard', href: '/quota' }],
    category: 'tooling',
    defaultEnabled: true,
    offBehaviour: 'No new burn run can be started and the scripts refuse before calling any provider. Completed runs and their results are kept.',
    takesEffect: 'Immediately - a queued run is not scheduled. A run already in flight finishes.',
    codeLocations: ['server/src/services/quota-burn.ts', 'server/src/scripts/probe-quota-limits.ts', 'server/src/scripts/probe-daily-cap.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-probe-log',
    title: 'Quota probe log',
    summary: 'An append-only record of every probe, what it measured and what verdict it produced.',
    settingsLocation: 'Quota → Probe log',
    destinations: [{ kind: 'internal', label: 'Open the probe log', href: '/quota#probes' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The panel is hidden; recording continues so the history has no gap. Nothing is deleted.',
    takesEffect: 'Next page load.',
    codeLocations: ['server/src/services/quota-probe-log.ts', 'client/src/components/quota-probe-log.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'request-routing-trace',
    title: 'Per-attempt routing trace',
    summary: 'Record why each candidate was chosen or skipped, per attempt, so an exhausted pool can be explained after the fact.',
    settingsLocation: 'Analytics → request detail',
    destinations: [{ kind: 'internal', label: 'Open analytics', href: '/analytics' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'New attempts stop writing trace rows. Existing traces are kept and still render. The paid-spend warning is NOT part of this extension and is emitted regardless.',
    takesEffect: 'Next request.',
    codeLocations: ['server/src/db/migrations/20260909_000001_request_attempt_routing_trace.ts', 'server/src/lib/fallback-loop.ts (logRoutingRefusal)'],
    disableConfirmation: 'none',
  },

  // ── Safety ────────────────────────────────────────────────────────────────
  {
    id: 'paid-balance-guard',
    title: 'Paid-balance guard',
    summary: 'A free chain cannot spend paid credit. On a gateway where a `:free` suffix is the only thing separating a free route from a billed one - OpenRouter, AnyAPI, unorouter - every other id is treated as paid and barred from automatic routing.',
    settingsLocation: 'Extensions → Paid-balance guard (disabling requires typed confirmation)',
    destinations: [{ kind: 'internal', label: 'Open extensions', href: '/extensions' }],
    category: 'safety',
    defaultEnabled: true,
    offBehaviour: 'Paid routes become selectable by automatic routing and lateral fallback, and real credit can be spent. Requires the typed confirmation and records who acknowledged it and when; an off state without a valid acknowledgement is refused at load. While off, a dashboard warning cannot be dismissed and every inference response carries X-FreeLLM-Paid-Balance-Guard: disabled. Naming a paid model explicitly is unaffected either way - that has always been an intentional request.',
    takesEffect: 'Next upstream dispatch, including a retry of a request already running. It cannot recall a call already sent.',
    codeLocations: ['server/src/services/provider-quota.ts (consumesPaidBalance, PAID_UNLESS_FREE_SUFFIX)', 'server/src/services/router.ts (automatic-chain filter)'],
    disableConfirmation: 'paid-spend',
  },

  // ── Presentation ──────────────────────────────────────────────────────────
  {
    id: 'models-hide-disabled',
    title: 'Hide disabled models',
    summary: 'The chain opens without the models every provider has switched off, counted on the filter so nothing is silently missing. Kept per browser.',
    settingsLocation: 'Models → Chat models → Hide disabled',
    destinations: [{ kind: 'internal', label: 'Open chat models', href: '/models/chat' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The filter control is removed and every model is listed. The per-browser preference is left in place.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/lib/hide-disabled-pref.ts', 'client/src/components/model-table.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'provider-model-access',
    title: 'Provider model access',
    summary: 'Choose which catalogue models each provider key may serve, with search and confirm-gated bulk enable/disable. Enabled models lead, then the most advanced - tier, rank, then the highest version within a family - and disabled ones are hidden by default.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
    destinations: [{ kind: 'internal', label: 'Open provider keys', href: '/keys' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The editor is hidden and scope is managed upstream’s way. Every saved model scope stays in force - hiding the editor does not widen a key’s scope.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/keys/model-scope-dialog.tsx', 'client/src/lib/model-scope-selection.ts', 'server/src/routes/keys.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'provider-row-summary',
    title: 'Provider row summary',
    summary: 'Read each provider at a glance: how many of its models its keys are enabled to serve, and a single row instead of a disclosure when it holds only one key.',
    settingsLocation: 'Keys → Providers',
    destinations: [{ kind: 'internal', label: 'Open provider keys', href: '/keys' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'Rows render upstream’s way, without the served-count summary.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/keys/provider-list.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'provider-quota-guidance',
    title: 'Provider free-tier guidance',
    summary: 'See sourced free allowances, quota scope, freshness and advisory flags beside the controls that enforce supported limits.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
    destinations: [{ kind: 'internal', label: 'Open quota guidance', href: '/keys' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The guidance panel is hidden. Enforcement of real limits is unaffected - this extension only ever displayed them.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/keys/quota-guidance-panel.tsx', 'server/src/data/quota-guidance.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'free-catalogue-copy',
    title: 'Free catalogue copy',
    summary: 'Copy List, on the Providers header for the whole catalogue and in a key’s dialog for one provider: every provider and model, or only the ones a usable key is enabled to serve, as a credential-blind review snapshot indexed by provider.',
    settingsLocation: 'Keys → Providers → Copy List',
    destinations: [{ kind: 'internal', label: 'Open provider keys', href: '/keys' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The action is removed. Nothing else changes; it only ever read.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/keys/free-catalog-copy-action.tsx', 'client/src/lib/provider-model-details-export.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'quota-capacity-dashboard',
    title: 'Quota and capacity dashboard',
    summary: 'One page for every provider: pools the provider measures itself, allowances counted locally against a known limit, and windows estimated from refill and recovery behaviour where nothing is published. Carries each number’s source so an estimate is never read as a measurement.',
    settingsLocation: 'Quota (navigation) → Provider overview, Reset timeline, Shadow routing',
    destinations: [{ kind: 'internal', label: 'Open quota dashboard', href: '/quota' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The page and its navigation entry are removed. Collection continues, so the history has no hole.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/pages/QuotaPage.tsx', 'server/src/routes/quota.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'reset-time-display',
    title: 'Reset-time display',
    summary: 'When each allowance returns, in one vocabulary, on both the Quota overview and every provider’s Keys row - including a folded window, whose countdown used to be dropped while its limit was shown.',
    settingsLocation: 'Quota → Provider overview; Keys → provider header',
    destinations: [{ kind: 'internal', label: 'Open quota dashboard', href: '/quota' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'Countdowns are hidden; limits still render. A rolling window has no reset instant to show and never did.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/lib/countdown.ts (formatCountdown)', 'client/src/components/keys/provider-models-panel.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'nav-playground-agents-menu',
    title: 'Condensed top navigation',
    summary: 'Playground and Agents are reached from the overflow (…) menu rather than the top bar, which keeps five entries.',
    settingsLocation: 'Navigation: overflow (…) menu on desktop, main menu on mobile',
    destinations: [
      { kind: 'internal', label: 'Open playground', href: '/playground' },
      { kind: 'internal', label: 'Open agents', href: '/agents' },
    ],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'Upstream’s navigation is restored, with both entries in the top bar.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/App.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'catalogue-log',
    title: 'Catalogue arrival and departure log',
    summary: 'An append-only history of models entering and leaving the catalogue, folded by year, month, week and day. The two existing surfaces report what the catalogue holds NOW and cannot answer what happened last week; a departure is captured with the chains it was serving, because a deleted row leaves nothing to read afterwards.',
    settingsLocation: 'Models → Chat models → Catalogue log',
    destinations: [{ kind: 'internal', label: 'Open the catalogue log', href: '/models/chat' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The panel is hidden; events keep being recorded so the history stays complete.',
    takesEffect: 'Next page load.',
    codeLocations: ['server/src/services/catalogue-log.ts', 'client/src/components/catalogue-log.tsx', 'client/src/lib/time-tree.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'provider-churn',
    title: 'Per-provider catalogue churn',
    summary: 'What each provider gained and lost lately, on its key row, expanding into per-model scope switches. A retirement names what it cost - the chains that model was serving.',
    settingsLocation: 'Keys → provider key row → churn chip',
    destinations: [{ kind: 'internal', label: 'Open provider keys', href: '/keys' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The chip and its panel are hidden. Churn history is retained.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/keys/provider-churn.tsx', 'server/src/services/catalogue-changes.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'model-benchmarks',
    title: 'Measured model comparison',
    summary: 'Compare the catalogue on Artificial Analysis intelligence, coding, agentic, speed, latency and price instead of on our own hand-tuned ranks. Sortable, searchable by model, provider, chain or benchmark, and scoped by what is routed, reachable, enabled or merely discovered. The API key is stored encrypted; unmeasured models sort last rather than as zero.',
    settingsLocation: 'Analytics → Compare models',
    destinations: [{ kind: 'internal', label: 'Open compare models', href: '/analytics/compare' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The page and its navigation entry are removed. Stored scores, mappings and the encrypted key are kept.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/pages/CompareModelsPage.tsx', 'server/src/services/analysis.ts', 'server/src/routes/analysis.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'benchmark-mapping',
    title: 'Benchmark mapping and baselines',
    summary: 'See which benchmark each row matched and correct it: one searchable picker, applied to every route of a logical model at once, committed on OK. Pin paid frontier models as shaded baselines so a free score is read against a yardstick.',
    settingsLocation: 'Analytics → Compare models → Mapped to; Add a baseline',
    destinations: [{ kind: 'internal', label: 'Open compare models', href: '/analytics/compare' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'Mappings become read-only and baselines are hidden. Every saved mapping and baseline is retained.',
    takesEffect: 'Next page load.',
    codeLocations: ['server/src/services/analysis-match.ts', 'client/src/components/compare/scope-picker.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'benchmark-proxy',
    title: 'Proxy scores for unpublished models',
    summary: 'Borrow a nearest-equivalent model’s scores for a model Artificial Analysis does not publish, marked ≈ and adjustable three coarse steps per metric so it can be ranked rather than sorted arbitrarily. A proxy is never evidence two routes are the same model, a measurement can never be adjusted, and the dashboard prompts to swap in real data once the upstream publishes it.',
    settingsLocation: 'Keys → provider → model row → Mapped to → closest match',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
      { kind: 'internal', label: 'Review estimates', href: '/analytics/compare' },
    ],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'Proxy scores stop being shown or offered, and affected models read as unmeasured. Saved proxies and their deltas are retained.',
    takesEffect: 'Next page load.',
    codeLocations: ['server/src/db/migrations/20260911_000004_proxy_delta.ts', 'server/src/services/analysis.ts'],
    disableConfirmation: 'none',
  },
  {
    id: 'logical-model-merge',
    title: 'Merge catalogue rows into one logical model',
    summary: 'Fold rows that are the same model under different names into one routing group, choosing which name survives, and undo a whole merge from the row or take one route back out. Writes the router’s own unify overrides, so failover changes immediately and every view agrees.',
    settingsLocation: 'Models → Chat models → Merge',
    destinations: [{ kind: 'internal', label: 'Open chat models', href: '/models/chat' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The merge editor is hidden. Existing merges REMAIN IN FORCE - disabling the editor does not un-merge anything, because undoing a merge changes routing and must be a deliberate act.',
    takesEffect: 'Next page load.',
    codeLocations: ['server/src/services/model-groups.ts', 'server/src/services/router.ts (resolveFusionCandidate)'],
    disableConfirmation: 'none',
  },
  {
    id: 'provider-models-panel',
    title: 'Provider model comparison on Keys',
    summary: 'Expanding a provider lists every model it serves with its measured scores, the chains routing to it, and one switch for whether this key routes it at all. One provider open at a time; rows that cannot route are faded.',
    settingsLocation: 'Keys → Providers → expand a provider',
    destinations: [{ kind: 'internal', label: 'Open provider keys', href: '/keys' }],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'The panel is hidden and upstream’s provider view is used. Saved per-model scope is untouched.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/keys/provider-models-panel.tsx'],
    disableConfirmation: 'none',
  },
  {
    id: 'key-reachability',
    title: 'Key reachability signals',
    summary: 'Provider swatches say whether a route can actually be called: filled for a usable key, hollow for one switched off, hollow square for no key at all, each linking to the screen that fixes it. Hovering names what that provider serves and how much of it the key permits, and a route the key omits can be added or removed from its scope on the spot.',
    settingsLocation: 'Analytics → Compare models; Keys → Providers',
    destinations: [
      { kind: 'internal', label: 'Open compare models', href: '/analytics/compare' },
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
    ],
    category: 'presentation',
    defaultEnabled: true,
    offBehaviour: 'Swatches and their scope shortcut are hidden. Key status and scope are unchanged.',
    takesEffect: 'Next page load.',
    codeLocations: ['client/src/components/platform-dot.tsx', 'client/src/lib/activated-platforms.ts'],
    disableConfirmation: 'none',
  },

  // ── Tooling ───────────────────────────────────────────────────────────────
  {
    id: 'deploy-script',
    title: 'Deployment script',
    summary: 'The build, recreate and health-verify sequence this install requires, including the quiescent volume archive taken before a schema change.',
    settingsLocation: 'scripts/deploy.sh (command line)',
    destinations: [{ kind: 'external', label: 'View extension branch', href: 'https://github.com/jamesjdoan/freellmapi/tree/docs/freellm-assert-start-on-redeploy' }],
    category: 'tooling',
    defaultEnabled: true,
    offBehaviour: 'The script refuses before doing any work and explains why. Deploying by hand with docker compose is unaffected, and no integrity check is removed.',
    takesEffect: 'Next invocation.',
    codeLocations: ['scripts/deploy.sh', 'scripts/deploy.test.mjs'],
    disableConfirmation: 'none',
  },
  {
    id: 'locale-fill',
    title: 'Locale fill from English',
    summary: 'New strings land in en.json and every other locale receives the English text, because the check gates on a key being present and this is a single-operator install. Only strings the operator names are translated.',
    settingsLocation: 'client/scripts/apply-translations.mjs (command line)',
    destinations: [{ kind: 'internal', label: 'Open extensions', href: '/extensions' }],
    category: 'tooling',
    defaultEnabled: true,
    offBehaviour: 'The fill script refuses; check:i18n still runs and still fails on a missing key. No locale file is modified.',
    takesEffect: 'Next invocation.',
    codeLocations: ['client/scripts/apply-translations.mjs', 'client/scripts/check-i18n.mjs'],
    disableConfirmation: 'none',
  },
  {
    id: 'separate-extension-branch',
    title: 'Separate extension branch',
    summary: 'Imperium changes stay on their own fork branch and are brought onto upstream releases there, rather than merged into upstream main.',
    settingsLocation: 'Deployment: docs/freellm-assert-start-on-redeploy',
    destinations: [{
      kind: 'external',
      label: 'View extension branch',
      href: 'https://github.com/jamesjdoan/freellmapi/tree/docs/freellm-assert-start-on-redeploy',
    }],
    category: 'tooling',
    defaultEnabled: true,
    offBehaviour: 'Documentation only - there is no runtime behaviour to stop. Present so the list is a complete inventory.',
    takesEffect: 'Not applicable.',
    codeLocations: ['AGENTS.md', 'docs/en/deployment/03-imperium-extension-branch.md'],
    disableConfirmation: 'none',
  },
] as const;

/** Ids, for validating a persisted document and rejecting unknown keys. */
export const EXTENSION_IDS: readonly string[] = IMPERIUM_EXTENSIONS.map(e => e.id);

export const PAID_BALANCE_GUARD_ID = 'paid-balance-guard';

/** Defaults for an id the persisted document has never seen. */
export function defaultExtensionEnabled(): Record<string, boolean> {
  return Object.fromEntries(IMPERIUM_EXTENSIONS.map(e => [e.id, e.defaultEnabled]));
}
