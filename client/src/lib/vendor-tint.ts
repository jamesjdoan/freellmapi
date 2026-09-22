/**
 * A vendor's own colour, as a transparent row tint.
 *
 * Baselines are yardsticks, and reading a column of them means first working
 * out whose model each one is: "GPT-5.6 Sol (high)" and "Claude Fable 5.1
 * (Adaptive Reasoning, Xhigh Effort, Default Fallback)" are both long strings
 * that start differently and scan the same. A tint answers "whose is this"
 * before the name is read.
 *
 * Matched on the AA creator first and the model name second. Creator is the
 * reliable field; the name is a fallback for rows whose creator is absent,
 * which is common for the smaller labs.
 *
 * Deliberately faint (/5 and /10). These sit behind text in a dense table, and
 * a saturated fill would make the name harder to read than no tint at all.
 */

/** Substring → tailwind background, first match wins, so order matters where
 *  one vendor's name contains another's. */
const TINTS: [string, string][] = [
  ['anthropic', 'bg-orange-500/10'],
  ['claude', 'bg-orange-500/10'],
  ['openai', 'bg-blue-500/10'],
  ['gpt', 'bg-blue-500/10'],
  ['qwen', 'bg-purple-500/10'],
  ['alibaba', 'bg-purple-500/10'],
  ['google', 'bg-amber-500/10'],
  ['gemini', 'bg-amber-500/10'],
  ['gemma', 'bg-amber-500/10'],
  ['nvidia', 'bg-lime-500/10'],
  ['nemotron', 'bg-lime-500/10'],
  ['deepseek', 'bg-cyan-500/10'],
  ['meta', 'bg-indigo-500/10'],
  ['llama', 'bg-indigo-500/10'],
  ['mistral', 'bg-rose-500/10'],
  ['x-ai', 'bg-slate-500/10'],
  ['grok', 'bg-slate-500/10'],
  ['z-ai', 'bg-teal-500/10'],
  ['glm', 'bg-teal-500/10'],
  ['cohere', 'bg-pink-500/10'],
  ['inclusionai', 'bg-violet-500/10'],
  ['ling', 'bg-violet-500/10'],
  ['moonshot', 'bg-fuchsia-500/10'],
  ['kimi', 'bg-fuchsia-500/10'],
]

/**
 * Tint for a model, or '' when its vendor is not one we colour.
 *
 * Returning '' rather than a default grey is the point: an uncoloured row says
 * "no vendor recognised", which is information. A fallback tint would claim a
 * vendor identity the data does not support.
 */
export function vendorTint(name: string | null | undefined, creator?: string | null): string {
  const haystack = `${creator ?? ''} ${name ?? ''}`.toLowerCase()
  for (const [needle, tint] of TINTS) {
    if (haystack.includes(needle)) return tint
  }
  return ''
}
