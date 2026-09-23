// Benchmark names spell out their variant in full:
//   "Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback)"
// In a table column the effort level is the only part that tells siblings
// apart, and it sits at the end, where truncation cuts first.
//
// Only names carrying an "<level> Effort" part are split, into the base
// "Claude Fable 5.1" and the variant "Xhigh". Parts that are the assumed
// default for an effort variant are dropped. Anything else is an exception
// and is kept: "Non-reasoning" is the reason the variant is not simply the
// effort, because the catalogue lists both
// "Claude Sonnet 5 (Adaptive Reasoning, High Effort)" and
// "Claude Sonnet 5 (Non-reasoning, High Effort)".
const ASSUMED: Record<string, true> = { 'adaptive reasoning': true, reasoning: true, 'default fallback': true }
const VARIANT = /^(.*?)\s*\(([^()]*)\)\s*$/
const EFFORT = /^(.+?)\s+effort$/i

export interface ModelNameParts {
  base: string
  /** Effort level plus any non-default parts, or null when the name is kept whole. */
  variant: string | null
}

export function splitModelName(name: string): ModelNameParts {
  const m = VARIANT.exec(name)
  if (!m) return { base: name, variant: null }
  const parts = m[2].split(',').map(p => p.trim()).filter(Boolean)
  const effort = parts.map(p => EFFORT.exec(p)).find(Boolean)
  if (!effort) return { base: name, variant: null }
  const kept = parts.filter(p => !EFFORT.test(p) && !ASSUMED[p.toLowerCase()])
  return { base: m[1], variant: [effort[1], ...kept].join(' · ') }
}
