// Benchmark names spell out their variant in full:
//   "Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback)"
// In a table column the effort level is the only part that tells siblings
// apart, and it sits at the end, where truncation cuts first.
//
// Only names carrying an "<level> Effort" part are shortened, to
// "Claude Fable 5.1 · Xhigh". Parts that are the assumed default for an
// effort variant are dropped. Anything else is an exception and is kept:
// "Non-reasoning" is the reason this is not simply "base · effort", because
// the catalogue lists both "Claude Sonnet 5 (Adaptive Reasoning, High Effort)"
// and "Claude Sonnet 5 (Non-reasoning, High Effort)".
const ASSUMED: Record<string, true> = { 'adaptive reasoning': true, reasoning: true, 'default fallback': true }
const VARIANT = /^(.*?)\s*\(([^()]*)\)\s*$/
const EFFORT = /^(.+?)\s+effort$/i

export function shortModelName(name: string): string {
  const m = VARIANT.exec(name)
  if (!m) return name
  const parts = m[2].split(',').map(p => p.trim()).filter(Boolean)
  const effort = parts.map(p => EFFORT.exec(p)).find(Boolean)
  if (!effort) return name
  const kept = parts.filter(p => !EFFORT.test(p) && !ASSUMED[p.toLowerCase()])
  return [m[1], effort[1], ...kept].join(' · ')
}
