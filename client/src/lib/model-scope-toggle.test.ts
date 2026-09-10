import { describe, expect, it } from 'vitest'
import { scopeAfterToggle } from './model-scope-selection'

const ALL = ['a', 'b', 'c']

describe('scopeAfterToggle', () => {
  it('narrows a serves-everything key to the rest of the catalogue', () => {
    // NULL means "serves everything", so switching one off has to materialise
    // the others rather than start from an empty set and lose them.
    expect(scopeAfterToggle(ALL, null, 'b', false)).toEqual({ modelScope: ['a', 'c'] })
    expect(scopeAfterToggle(ALL, [], 'b', false)).toEqual({ modelScope: ['a', 'c'] })
  })

  it('returns to NULL when the last excluded model is switched back on', () => {
    // The case that makes this function exist. Writing ['a','b','c'] instead
    // would pin the key to today's catalogue and exclude every later arrival.
    expect(scopeAfterToggle(ALL, ['a', 'b'], 'c', true)).toEqual({ modelScope: null })
  })

  it('keeps an explicit list explicit while anything is still excluded', () => {
    expect(scopeAfterToggle(ALL, ['a'], 'b', true)).toEqual({ modelScope: ['a', 'b'] })
  })

  it('refuses to switch off the last model rather than widening the scope', () => {
    // An empty scope reads as "serves everything" in the column, so obeying
    // here would turn the switch into its own opposite.
    expect(scopeAfterToggle(ALL, ['c'], 'c', false)).toEqual({ refuse: 'last' })
  })

  it('preserves a stored id the routable list does not offer', () => {
    // allIds comes from /api/fallback, which omits a model disabled at
    // catalogue level. Pruning against it revoked the key's access to real
    // models as a side effect of an unrelated switch - observed on a live key,
    // where turning off a retired model also dropped gemini-2.5-flash.
    expect(scopeAfterToggle(ALL, ['a', 'curated-off'], 'b', true))
      .toEqual({ modelScope: ['a', 'curated-off', 'b'] })
  })

  it('still collapses to NULL when every routable model is on, extras and all', () => {
    // NULL serves everything, so it covers the extra id too - collapsing
    // loses nothing and keeps future arrivals flowing through the key.
    expect(scopeAfterToggle(ALL, ['a', 'b', 'curated-off'], 'c', true)).toEqual({ modelScope: null })
  })

  it('allows the last ROUTABLE model off while a curated-off one remains', () => {
    // Only a scope that would end up empty is refused. 'curated-off' is a real
    // model that happens to be switched off at catalogue level, so the key
    // keeps a meaningful scope and gets to serve it again when it comes back.
    expect(scopeAfterToggle(ALL, ['c', 'curated-off'], 'c', false))
      .toEqual({ modelScope: ['curated-off'] })
  })

  it('is a no-op when the model is already in the requested state', () => {
    expect(scopeAfterToggle(ALL, ['a'], 'a', true)).toEqual({ modelScope: ['a'] })
    expect(scopeAfterToggle(ALL, ['a'], 'b', false)).toEqual({ modelScope: ['a'] })
  })
})
