// @vitest-environment jsdom
/**
 * The expiry countdown (2026-10-22).
 *
 * A model's free access can end at a date the provider published: Vercel's $0
 * MiniMax promotion ended 22 October 2026. The operator wants a countdown, and
 * wants it to be a REMINDER: nothing switches off when it reaches zero, because
 * a promotion ending is not a model breaking.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { ExpiryChip } from './expiry-chip'
import { formatExpiryCountdown } from '@/lib/expiry'

let root: Root
let container: HTMLDivElement

beforeAll(() => { (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

const t = (key: string, vars?: Record<string, string | number>) => {
  const table: Record<string, string> = {
    'keys.expiryCountdownDays': '{days}d {hours}h {minutes}m left',
    'keys.expiryCountdownHours': '{hours}h {minutes}m left',
    'keys.expiryCountdownMinutes': '{minutes}m left',
    'keys.expiryPassed': 'expired',
    'keys.expiryEndsAt': 'Ends {date}',
    'keys.expiryCountdownHint': 'A reminder only. Nothing switches off when it reaches zero.',
    'keys.expiryPassedHint': 'This date has passed. The model may still work; check it.',
  }
  let out = table[key] ?? key
  for (const [k, v] of Object.entries(vars ?? {})) out = out.replace(`{${k}}`, String(v))
  return out
}

describe('the expiry countdown', () => {
  it('counts down in days, hours and minutes', () => {
    expect(formatExpiryCountdown(2 * 86400_000 + 4 * 3600_000 + 19 * 60_000, t)).toBe('2d 4h 19m left')
    expect(formatExpiryCountdown(4 * 3600_000 + 19 * 60_000, t)).toBe('4h 19m left')
    expect(formatExpiryCountdown(19 * 60_000, t)).toBe('19m left')
  })

  it('says expired rather than counting past zero', () => {
    expect(formatExpiryCountdown(0, t)).toBe('expired')
    expect(formatExpiryCountdown(-1000, t)).toBe('expired')
  })

  it('renders the countdown and says the date in the tooltip', () => {
    const end = new Date(Date.now() + 3 * 3600_000).toISOString()
    act(() => {
      root.render(<I18nProvider initialLocale="en"><ExpiryChip expiresAt={end} label="Vercel $0 promotion ends" /></I18nProvider>)
    })
    const chip = container.querySelector('span[title]')!
    expect(chip.textContent).toMatch(/\d+h \d+m left/)
    const title = chip.getAttribute('title')!
    expect(title).toContain('Vercel $0 promotion ends')
    // The reminder says plainly that nothing switches off.
    expect(title).toContain('Nothing switches off')
  })

  it('keeps the unlimited flag meaning: an expired model is still a row, not a warning to act on', () => {
    const past = new Date(Date.now() - 3600_000).toISOString()
    act(() => {
      root.render(<I18nProvider initialLocale="en"><ExpiryChip expiresAt={past} label={null} /></I18nProvider>)
    })
    const chip = container.querySelector('span[title]')!
    expect(chip.textContent).toBe('expired')
    expect(chip.getAttribute('title')).toContain('may still work')
  })
})
