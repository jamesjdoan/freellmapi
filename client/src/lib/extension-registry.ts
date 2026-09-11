export type ExtensionDestination = {
  kind: 'internal' | 'external'
  label: string
  href: string
}

export type ImperiumExtension = {
  id: string
  title: string
  summary: string
  settingsLocation: string
  destinations: ExtensionDestination[]
}

/**
 * Discoverability metadata for features maintained by the Imperium fork.
 * This is deliberately not a feature flag or a second settings store: each
 * destination points to the page that already owns the real configuration.
 */
export const IMPERIUM_EXTENSIONS: readonly ImperiumExtension[] = [
  {
    id: 'provider-preference',
    title: 'Provider preference ordering',
    summary: 'Keep one unified model name while choosing which healthy provider should be tried first.',
    settingsLocation: 'Models → Chat models → choose a unified model',
    destinations: [
      { kind: 'internal', label: 'Choose a model', href: '/models/chat' },
    ],
  },
  {
    id: 'models-hide-disabled',
    title: 'Hide disabled models',
    summary: 'The chain opens without the models every provider has switched off, counted on the filter so nothing is silently missing. Kept per browser.',
    settingsLocation: 'Models → Chat models → Hide disabled',
    destinations: [
      { kind: 'internal', label: 'Open chat models', href: '/models/chat' },
    ],
  },
  {
    id: 'provider-model-access',
    title: 'Provider model access',
    summary: 'Choose which catalogue models each provider key may serve, with search and confirm-gated bulk enable/disable. Enabled models lead, then the most advanced — tier, rank, then the highest version within a family — and disabled ones are hidden by default.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
    ],
  },
  {
    id: 'provider-row-summary',
    title: 'Provider row summary',
    summary: 'Read each provider at a glance: how many of its models its keys are enabled to serve, and a single row instead of a disclosure when it holds only one key.',
    settingsLocation: 'Keys → Providers',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
    ],
  },
  {
    id: 'provider-account-limits',
    title: 'Provider account limits',
    summary: 'Set credential-wide RPM, RPD and TPD gates independently from model-specific catalogue limits.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
    destinations: [
      { kind: 'internal', label: 'Open account limits', href: '/keys' },
    ],
  },
  {
    id: 'provider-quota-guidance',
    title: 'Provider free-tier guidance',
    summary: 'See sourced free allowances, quota scope, freshness and advisory flags beside the controls that enforce supported limits.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
    destinations: [
      { kind: 'internal', label: 'Open quota guidance', href: '/keys' },
    ],
  },
  {
    id: 'free-catalogue-copy',
    title: 'Free catalogue copy',
    summary: 'Copy List, on the Providers header for the whole catalogue and in a key\'s dialog for one provider: every provider and model, or only the ones a usable key is enabled to serve, as a credential-blind review snapshot indexed by provider.',
    settingsLocation: 'Keys → Providers → Copy List',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
    ],
  },
  {
    id: 'quota-pool-routing',
    title: 'Quota-pool-aware routing',
    summary: 'Track shared, per-model, project, credit, unknown and local capacity without double-counting it.',
    settingsLocation: 'Automatic routing; usage context: Models → Chat models → Monthly token budget',
    destinations: [
      { kind: 'internal', label: 'View usage budget', href: '/models/chat#quota-pools' },
    ],
  },
  {
    id: 'quota-capacity-dashboard',
    title: 'Quota and capacity dashboard',
    summary: 'One page for every provider: pools the provider measures itself, allowances counted locally against a known limit, and windows estimated from refill and recovery behaviour where nothing is published. Carries each number source so an estimate is never read as a measurement.',
    settingsLocation: 'Quota (navigation) → Provider overview, Reset timeline, Shadow routing',
    destinations: [
      { kind: 'internal', label: 'Open quota dashboard', href: '/quota' },
    ],
  },
  {
    id: 'nav-playground-agents-menu',
    title: 'Condensed top navigation',
    summary: 'Playground and Agents are reached from the overflow (…) menu rather than the top bar, which keeps five entries. Folding them into a shared top-bar entry was the first attempt and left both pages in two places at once.',
    settingsLocation: 'Navigation: overflow (…) menu on desktop, main menu on mobile',
    destinations: [
      { kind: 'internal', label: 'Open playground', href: '/playground' },
      { kind: 'internal', label: 'Open agents', href: '/agents' },
    ],
  },
  {
    id: 'catalogue-log',
    title: 'Catalogue arrival and departure log',
    summary: 'An append-only history of models entering and leaving the catalogue, folded by year, month, week and day. The two existing surfaces report what the catalogue holds NOW and cannot answer what happened last week; a departure is captured with the chains it was serving, because a deleted row leaves nothing to read afterwards.',
    settingsLocation: 'Models → Chat models → Catalogue log',
    destinations: [
      { kind: 'internal', label: 'Open the catalogue log', href: '/models/chat' },
    ],
  },
  {
    id: 'provider-churn',
    title: 'Per-provider catalogue churn',
    summary: 'What each provider gained and lost lately, on its key row, expanding into per-model scope switches. A retirement names what it cost — the chains that model was serving.',
    settingsLocation: 'Keys → provider key row → churn chip',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
    ],
  },
  {
    id: 'model-benchmarks',
    title: 'Measured model comparison',
    summary: 'Compare the catalogue on Artificial Analysis intelligence, coding, agentic, speed, latency and price instead of on our own hand-tuned ranks. Sortable, searchable by model, provider, chain or benchmark, and scoped by what is routed, reachable, enabled or merely discovered. The API key is stored encrypted; unmeasured models sort last rather than as zero.',
    settingsLocation: 'Analytics → Compare models',
    destinations: [
      { kind: 'internal', label: 'Open compare models', href: '/analytics/compare' },
    ],
  },
  {
    id: 'benchmark-mapping',
    title: 'Benchmark mapping and baselines',
    summary: 'See which benchmark each row matched and correct it: one searchable picker, applied to every route of a logical model at once, committed on OK. Pin paid frontier models as shaded baselines so a free score is read against a yardstick.',
    settingsLocation: 'Analytics → Compare models → Mapped to; Add a baseline',
    destinations: [
      { kind: 'internal', label: 'Open compare models', href: '/analytics/compare' },
    ],
  },
  {
    id: 'benchmark-proxy',
    title: 'Proxy scores for unpublished models',
    summary: 'Borrow a nearest-equivalent model\'s scores for a model Artificial Analysis does not publish, marked ≈ and adjustable three coarse steps per metric so it can be ranked rather than sorted arbitrarily. A proxy is never evidence two routes are the same model, a measurement can never be adjusted, and the dashboard prompts to swap in real data once the upstream publishes it.',
    settingsLocation: 'Keys → provider → model row → Mapped to → closest match',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
      { kind: 'internal', label: 'Review estimates', href: '/analytics/compare' },
    ],
  },
  {
    id: 'logical-model-merge',
    title: 'Merge catalogue rows into one logical model',
    summary: 'Fold rows that are the same model under different names into one routing group, choosing which name survives, and undo a whole merge from the row or take one route back out. Writes the router\'s own unify overrides, so failover changes immediately and every view agrees.',
    settingsLocation: 'Models → Chat models → Merge',
    destinations: [
      { kind: 'internal', label: 'Open chat models', href: '/models/chat' },
    ],
  },
  {
    id: 'provider-models-panel',
    title: 'Provider model comparison on Keys',
    summary: 'Expanding a provider lists every model it serves with its measured scores, the chains routing to it, and one switch for whether this key routes it at all. One provider open at a time; rows that cannot route are faded.',
    settingsLocation: 'Keys → Providers → expand a provider',
    destinations: [
      { kind: 'internal', label: 'Open provider keys', href: '/keys' },
    ],
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
  },
  {
    id: 'separate-extension-branch',
    title: 'Separate extension branch',
    summary: 'Imperium changes stay on their own fork branch and are rebased onto upstream releases instead of merged into upstream main.',
    settingsLocation: 'Deployment: docs/freellm-assert-start-on-redeploy',
    destinations: [
      {
        kind: 'external',
        label: 'View extension branch',
        href: 'https://github.com/jamesjdoan/freellmapi/tree/docs/freellm-assert-start-on-redeploy',
      },
    ],
  },
] as const
