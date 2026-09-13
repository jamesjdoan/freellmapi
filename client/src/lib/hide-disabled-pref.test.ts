// @vitest-environment jsdom
//
// The complaint this fixes is that the toggle forgot itself on every expand.
// So the rules worth pinning are about MEMORY, not rendering: per provider,
// survives a reload, and never throws where localStorage is unavailable.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readHideDisabled, writeHideDisabled } from '@/lib/hide-disabled-pref'

describe('hide-disabled preference', () => {
  beforeEach(() => { localStorage.clear() })

  it('defaults to showing everything', () => {
    expect(readHideDisabled('groq')).toBe(false)
  })

  it('remembers per provider, so one choice does not follow you', () => {
    // HuggingFace has 122 catalogue rows and wants hiding; Groq has four and
    // does not. One shared flag made the control feel broken on both.
    writeHideDisabled('huggingface', true)

    expect(readHideDisabled('huggingface')).toBe(true)
    expect(readHideDisabled('groq')).toBe(false)
  })

  it('forgets on the way back, rather than storing an explicit false', () => {
    // A stored "false" would outlive any change to the default; absence means
    // "no opinion", which is what un-hiding actually expresses.
    writeHideDisabled('groq', true)
    writeHideDisabled('groq', false)

    expect(localStorage.getItem('freellmapi.keys.hideDisabled.groq')).toBeNull()
    expect(readHideDisabled('groq')).toBe(false)
  })

  it('survives where localStorage throws, because it is only view state', () => {
    // Private modes and blocked origins throw on access. A panel must not fail
    // to render because a preference could not be read.
    const boom = () => { throw new Error('denied') }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })

    expect(() => writeHideDisabled('groq', true)).not.toThrow()
    expect(readHideDisabled('groq')).toBe(false)

    vi.unstubAllGlobals()
  })
})
