/**
 * Why a route is not serving, and the test result as a colour.
 *
 * Lives outside provider-models-panel.tsx deliberately: that file exports
 * components only, because a non-component export in it breaks fast refresh
 * (its own note says so, and adding these there would have made the note a
 * lie).
 */
export interface BlockedRow {
  enabled: boolean
  keyScope: 'none' | 'disabled' | 'unscoped' | 'in' | 'out'
}

export interface VerdictLike {
  verdict: 'ok' | 'dead' | 'limited' | 'untested'
}

/**
 * Why this route is not serving, in the order the router decides it.
 *
 * The gap this fills: NVIDIA's kimi-k3 and deepseek-v4-flash both show a green
 * "tested, answered" mark and then say nothing about being switched off in the
 * catalogue, so the row reads as a working route that the router is ignoring
 * for no reason. A greyed row is a question, not an answer.
 *
 * Null when the route can serve; the chain column handles "available and idle"
 * separately, because that one is a choice rather than an obstacle.
 */
export function blockedReason(r: BlockedRow): 'panelWhyNoKey' | 'panelWhyKeyOff' | 'panelWhyCatalogueOff' | 'panelWhyOutOfScope' | null {
  // Four distinct server states, kept distinct here: 'none' is no credential
  // at all, 'disabled' is a credential we hold that is switched off OR whose
  // status is not healthy/unknown (analysis.ts:465-468 - so "unusable", not
  // merely "off"), 'out' is a scoped key that does not name this model, and a
  // catalogue-off row is one switch away. They call for different actions, so
  // collapsing them into "not selected" would waste the row.
  if (r.keyScope === 'none') return 'panelWhyNoKey'
  if (r.keyScope === 'disabled') return 'panelWhyKeyOff'
  if (!r.enabled) return 'panelWhyCatalogueOff'
  if (r.keyScope === 'out') return 'panelWhyOutOfScope'
  return null
}

/**
 * The test result as a colour, on the edge of the row.
 *
 * The badge already carries the failure code and stays silent for a pass, which
 * keeps the table quiet but means a scan cannot tell tested-good from never
 * tested. An edge is readable at a glance and costs no width. Untested has NO
 * colour on purpose - the unknown-is-not-zero rule: absence of evidence must
 * not look like evidence.
 */
export function verdictEdge(health?: VerdictLike): string {
  switch (health?.verdict) {
    case 'ok': return 'border-l-2 border-l-emerald-500/60'
    case 'limited': return 'border-l-2 border-l-amber-500/60'
    case 'dead': return 'border-l-2 border-l-rose-500/60'
    default: return 'border-l-2 border-l-transparent'
  }
}


/**
 * Whether a hide control can do anything if pressed.
 *
 * Both hide controls - the panel's "Hide can't route" button and the scope
 * dialog's "Hide disabled models" box - were pressable with nothing to hide,
 * which reads as broken rather than empty.
 *
 * Still pressable while ON: disabling on `count === 0` alone wedges a filter
 * that was switched on elsewhere, leaving rows hidden with no way back.
 */
export function hideControlPressable(hideableCount: number, isOn: boolean): boolean {
  return !(hideableCount === 0 && !isOn)
}
