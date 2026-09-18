// @vitest-environment jsdom
/**
 * A hide control with nothing to hide.
 *
 * Both controls used to accept a press that changed nothing: the panel's "Hide
 * can't route" button and the scope dialog's "Hide disabled models" box. On a
 * provider where every row can serve, pressing it looked broken rather than
 * empty.
 *
 * Both stay live while they are ON, so a filter left on from another provider
 * can always be turned back off. That is the failure this asserts against: a
 * naive `disabled={count === 0}` wedges the control in the ON state, with rows
 * hidden and no way to reveal them.
 */
import { describe, it, expect } from 'vitest'
import { hideControlPressable as pressable } from '@/lib/route-blockers'

describe('a hide control with nothing to hide', () => {
  it('cannot be pressed when there is nothing to hide', () => {
    expect(pressable(0, false)).toBe(false)
  })

  it('can be pressed when rows would actually be hidden', () => {
    expect(pressable(14, false)).toBe(true)
  })

  it('stays pressable while ON even with nothing to hide, so it can be turned off', () => {
    // The wedge: a filter switched on for NVIDIA, then a provider with nothing
    // hideable. Disabling on count alone would strand it.
    expect(pressable(0, true)).toBe(true)
  })
})
