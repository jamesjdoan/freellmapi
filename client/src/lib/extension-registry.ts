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
    id: 'provider-model-access',
    title: 'Provider model access',
    summary: 'Choose which catalogue models each provider key may serve, preserving scarce capacity for useful models.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
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
    summary: 'Copy the whole free catalogue — every provider and model, or only the ones routing can use right now — as a credential-blind review snapshot.',
    settingsLocation: 'Keys → provider key row → Models & account limits',
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
    id: 'separate-extension-branch',
    title: 'Separate extension branch',
    summary: 'Imperium changes stay on their own fork branch and are rebased onto upstream releases instead of merged into upstream main.',
    settingsLocation: 'Deployment: codex/provider-routing-controls',
    destinations: [
      {
        kind: 'external',
        label: 'View extension branch',
        href: 'https://github.com/jamesjdoan/freellmapi/tree/codex/provider-routing-controls',
      },
    ],
  },
] as const
