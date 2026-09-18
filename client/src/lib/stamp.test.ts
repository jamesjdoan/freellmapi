import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatStamp, parseStamp } from './stamp'

describe('formatStamp', () => {
  afterEach(() => vi.useRealTimers())

  it('reads a SQLite stamp as UTC, not local time', () => {
    // `datetime('now')` carries no zone marker and is UTC. Parsed as local it
    // shifts every row by the offset, which is how a 23:30 event lands on the
    // wrong day in the log.
    expect(parseStamp('2026-09-16 14:54:00').toISOString()).toBe('2026-09-16T14:54:00.000Z')
    expect(parseStamp('2026-09-16T14:54:00Z').toISOString()).toBe('2026-09-16T14:54:00.000Z')
  })

  it('omits the year in the current one and states it otherwise', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-18T00:00:00Z'))
    expect(formatStamp('2026-09-16 14:54:00')).not.toContain('2026')
    expect(formatStamp('2025-09-16 14:54:00')).toContain('2025')
  })

  it('adds a time only when asked, so a boundary date stays a date', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-18T00:00:00Z'))
    expect(formatStamp('2026-09-16 14:54:00')).not.toMatch(/\d{1,2}:\d{2}/)
    expect(formatStamp('2026-09-16 14:54:00', { time: true })).toMatch(/\d{1,2}:\d{2}/)
  })

  it('times a window boundary the same way it times an event', () => {
    // Every catalogue surface opts into `{ time: true }`, the `since` hint
    // included, so the panel and the log read as one design. Worth knowing
    // about the hint specifically: its value is `Date.now() - 30 days`
    // evaluated per request, so its minute advances on every reload while the
    // event rows below it stay put. That is the window moving, not a bug.
    vi.useFakeTimers().setSystemTime(new Date('2026-09-18T13:38:21Z'))
    expect(formatStamp('2026-08-19 13:38:21', { time: true })).toMatch(/19 \w+ \d{1,2}:\d{2}/)
  })

  it('renders an em dash for junk rather than "Invalid Date"', () => {
    expect(formatStamp('')).toBe('—')
    expect(formatStamp('not a date')).toBe('—')
  })
})
