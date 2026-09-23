import { splitModelName } from '@/lib/model-name'

// A benchmark model name with its effort variant set back: smaller, lighter
// and fainter than the base, because it qualifies the model rather than
// naming a different one. No title of its own, so a caller's tooltip on a
// wrapping element is not shadowed.
export function ModelName({ name, className }: { name: string; className?: string }) {
  const { base, variant } = splitModelName(name)
  return (
    <span className={className}>
      {base}
      {variant && <span className="ml-1 text-[0.85em] font-light text-muted-foreground">{variant}</span>}
    </span>
  )
}
