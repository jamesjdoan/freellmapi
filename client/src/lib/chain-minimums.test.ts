import { describe, expect, it } from 'vitest'
import { evaluate, scoreRowOf, scoreTone, type ChainMinimums, type ScoreRow } from '@/lib/chain-minimums'
import type { ScoreCell, ScoreProvenance } from '@/lib/score-provenance'

const measuredOnly = { general: false, coding: false, agentic: false }
const row = (over: Partial<ScoreRow> = {}): ScoreRow => ({
  general: 30, coding: 50, agentic: 35, estimated: measuredOnly, supportsTools: true, supportsVision: false, ...over,
})
const mins = (over: Partial<ChainMinimums> = {}): ChainMinimums => ({
  general: null, coding: null, agentic: null, acceptEstimated: false, either: [], ...over,
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
    const estimate = row({ general: 40, estimated: { ...measuredOnly, general: true } })
    expect(evaluate(estimate, mins({ general: 35 }), tools).status).toBe('unknown')
    expect(evaluate(estimate, mins({ general: 35, acceptEstimated: true }), tools).status).toBe('fits')
  })

  it('grades a tested score like a measurement and an approximated one as an estimate, per metric', () => {
    const cell = (value: number, provenance: ScoreProvenance): ScoreCell => ({ value, provenance, entry: null, editable: true })
    const scored = scoreRowOf({
      supportsTools: true, supportsVision: false,
      scores: { intelligence: cell(40, 'measured'), coding: cell(50, 'approximated'), agentic: cell(35, 'tested') },
    })
    // The approximated coding score alone makes the coding minimum unknown;
    // the measured and tested ones still grade.
    const e = evaluate(scored, mins({ general: 35, coding: 45, agentic: 30 }), tools)
    expect(e).toMatchObject({ status: 'unknown', unknown: ['coding'], shortfalls: [] })
    expect(evaluate(scored, mins({ general: 35, agentic: 30 }), tools).status).toBe('fits')
    expect(evaluate(scored, mins({ coding: 45, acceptEstimated: true }), tools).status).toBe('fits')
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

  describe('alternatives (OR)', () => {
    // general AND (coding OR agentic)
    const orMins = mins({ general: 25, coding: 60, agentic: 30, either: ['coding', 'agentic'] })

    it('fits on any one alternative, with the required one met', () => {
      expect(evaluate(row({ general: 30, coding: 50, agentic: 35 }), orMins, tools).status).toBe('fits')
      expect(evaluate(row({ general: 30, coding: 70, agentic: 10 }), orMins, tools).status).toBe('fits')
    })

    it('still fails on a required metric whatever the alternatives say', () => {
      const e = evaluate(row({ general: 20, coding: 70, agentic: 50 }), orMins, tools)
      expect(e.status).toBe('below')
      expect(e.shortfalls).toEqual([{ metric: 'general', value: 20, min: 25 }])
    })

    it('is below only when every alternative is measured below', () => {
      const e = evaluate(row({ general: 30, coding: 50, agentic: 20 }), orMins, tools)
      expect(e.status).toBe('below')
      expect(e.shortfalls.map(s => s.metric)).toEqual(['coding', 'agentic'])
    })

    it('is unknown when no alternative passes but one is unscored', () => {
      // Agentic could still carry it once scored, so this is not a miss.
      const e = evaluate(row({ general: 30, coding: 50, agentic: null }), orMins, tools)
      expect(e.status).toBe('unknown')
      expect(e.unknown).toEqual(['agentic'])
    })

    it('fits on a measured alternative even when another is an unaccepted estimate', () => {
      const e = evaluate(
        row({ general: 30, coding: 70, agentic: 50, estimated: { general: false, coding: false, agentic: true } }),
        orMins, tools,
      )
      expect(e.status).toBe('fits')
    })

    it('reads every set minimum as required when nothing is an alternative', () => {
      expect(evaluate(row({ general: 30, coding: 70, agentic: 10 }), mins({ general: 25, coding: 60, agentic: 30 }), tools).status)
        .toBe('below')
    })
  })
})
