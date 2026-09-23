// Benchmark names spell out their variant in a trailing parenthetical:
//   "Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback)"
//   "GPT-5.2 (high)"
//   "Qwen3.6 Max (Non-reasoning)"
// In a table column the variant is what tells siblings apart, and it sits at
// the end, where truncation cuts first. So every such name is split into the
// base and a variant rendered subdued beside it.
//
// The effort level leads the variant in one spelling, whether the source wrote
// "Xhigh Effort" or "xhigh". Parts that are the assumed default are dropped.
// Anything else is an exception and is kept: "Non-reasoning" survives because
// the catalogue lists both "Claude Sonnet 5 (Adaptive Reasoning, High Effort)"
// and "Claude Sonnet 5 (Non-reasoning, High Effort)".
const ASSUMED: Record<string, true> = { 'adaptive reasoning': true, reasoning: true, 'default fallback': true }
const LEVELS: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Xhigh', max: 'Max' }
const VARIANT = /^(.*?)\s*\(([^()]*)\)\s*$/
const EFFORT = /^(.+?)\s+effort$/i

export interface ModelNameParts {
  base: string
  /** Effort level first, then any non-default parts; null when nothing is left. */
  variant: string | null
}

function effortLevel(part: string): string | null {
  const word = (EFFORT.exec(part)?.[1] ?? part).toLowerCase()
  return LEVELS[word] ?? null
}

export function splitModelName(name: string): ModelNameParts {
  const m = VARIANT.exec(name)
  if (!m || !m[1]) return { base: name, variant: null }
  let level: string | null = null
  const kept: string[] = []
  for (const part of m[2].split(',').map(p => p.trim()).filter(Boolean)) {
    const l = effortLevel(part)
    if (l) level ??= l
    else if (!ASSUMED[part.toLowerCase()]) kept.push(part)
  }
  const variant = [...(level ? [level] : []), ...kept].join(' · ')
  return { base: m[1], variant: variant || null }
}
