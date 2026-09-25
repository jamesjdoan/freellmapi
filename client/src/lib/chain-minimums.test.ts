import { describe, expect, it } from 'vitest'
import { evaluate, scoreTone, type ChainMinimums, type ScoreRow } from '@/lib/chain-minimums'

const row = (over: Partial<ScoreRow> = {}): ScoreRow => ({
  general: 30, coding: 50, agentic: 35, estimated: false, supportsTools: true, supportsVision: false, ...over,
})
const mins = (over: Partial<ChainMinimums> = {}): ChainMinimums => ({
  general: null, coding: null, agentic: null, acceptEstimated: false, ...over,
})
const tools = { requiresTools: true, requiresVision: false }

describe('chain minimums evaluation', () => {
  it('treats an unmeasured score as unknown, never as a fail', () => {
    // Coding chain on a model AA never scored for agentic: not "below", and not "fits".
    const e = evaluate(row({ agentic: null }), mins({ coding: 45, agentic: 30 }), tools)
    expect(e.status).toBe('unknown')
    expect(e.unknown).toEqual(['agentic'])
    expect(e.shortfalls).toEqual([])
  })

  it('lets a measured miss outrank an unknown, and names every shortfall', () => {
    const e = evaluate(row({ general: 22, agentic: null }), mins({ general: 25, agentic: 30 }), tools)
    expect(e.status).toBe('below')
    expect(e.shortfalls).toEqual([{ metric: 'general', value: 22, min: 25 }])
  })

  it('only accepts a proxy estimate where the chain opts in', () => {
    const estimate = row({ general: 40, estimated: true })
    expect(evaluate(estimate, mins({ general: 35 }), tools).status).toBe('unknown')
    expect(evaluate(estimate, mins({ general: 35, acceptEstimated: true }), tools).status).toBe('fits')
  })

  it('refuses a chain whose contract the model cannot meet, whatever its scores', () => {
    const noTools = row({ general: 55, supportsTools: false })
    const e = evaluate(noTools, mins({ general: 45 }), tools)
    expect(e.status).toBe('structural')
    expect(e.missing).toEqual(['tools'])
  })

  it('meets a minimum exactly at the line', () => {
    expect(evaluate(row({ general: 25 }), mins({ general: 25 }), tools).status).toBe('fits')
    expect(scoreTone(25, 25)).toBe('meets')
    expect(scoreTone(24.2, 25)).toBe('near')
    expect(scoreTone(23.9, 25)).toBe('below')
    expect(scoreTone(null, 25)).toBeNull()
  })
})
