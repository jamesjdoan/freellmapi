import { describe, it, expect } from 'vitest'
import { buildBudgetLegend, sortByIntelligence, type LegendModel } from './budget-legend'

function model(platform: string, modelId: string, intelligenceRank: number | undefined, budget: number, used = 0): LegendModel {
  return {
    displayName: `${platform}/${modelId}`, platform, modelId, intelligenceRank, budget, used,
    poolKey: `${platform}::${modelId}`, poolBudget: budget,
  }
}

describe('sortByIntelligence', () => {
  it('orders smartest first regardless of the incoming (chain-priority) order', () => {
    // Chain priority is seeded provider by provider, so the server used to hand
    // the legend groq, groq, google, google… — the "arranged by provider" look.
    const chainOrder = [
      model('groq', 'llama-8b', 40, 1),
      model('groq', 'llama-70b', 12, 1),
      model('google', 'gemini-flash', 8, 1),
      model('google', 'gemma', 30, 1),
      model('cerebras', 'qwen-235b', 5, 1),
    ]
    expect(sortByIntelligence(chainOrder).map(m => m.modelId)).toEqual([
      'qwen-235b', 'gemini-flash', 'llama-70b', 'gemma', 'llama-8b',
    ])
  })

  it('keeps equal ranks in their incoming order and puts unranked rows last', () => {
    const rows = [
      model('a', 'unranked-first', undefined, 1),
      model('b', 'rank3-first', 3, 1),
      model('c', 'rank3-second', 3, 1),
      model('d', 'rank1', 1, 1),
      model('e', 'unranked-second', undefined, 1),
    ]
    expect(sortByIntelligence(rows).map(m => m.modelId)).toEqual([
      'rank1', 'rank3-first', 'rank3-second', 'unranked-first', 'unranked-second',
    ])
  })

  it('does not mutate its input', () => {
    const rows = [model('a', 'x', 2, 1), model('b', 'y', 1, 1)]
    const before = rows.map(m => m.modelId)
    sortByIntelligence(rows)
    expect(rows.map(m => m.modelId)).toEqual(before)
  })
})

describe('buildBudgetLegend', () => {
  it('counts shared capacity once and names every member in smartest-first order', () => {
    const first = { ...model('mistral', 'codestral', 5, 100_000_000), poolKey: 'mistral::codestral', poolBudget: 150_000_000 }
    const second = { ...model('mistral', 'mistral-code', 2, 100_000_000), poolKey: first.poolKey, poolBudget: first.poolBudget }
    const legend = buildBudgetLegend([first, model('groq', 'llama', 3, 50_000_000), second], 200_000_000)
    expect(legend.rows.map(r => [r.modelId, r.budget, r.widthPct, r.memberNames])).toEqual([
      ['mistral-code', 150_000_000, 75, ['mistral/mistral-code', 'mistral/codestral']],
      ['llama', 50_000_000, 25, ['groq/llama']],
    ])
  })

  it('does not subtract recorded traffic from a renewing allowance estimate', () => {
    const legend = buildBudgetLegend([model('groq', 'llama', 1, 1_000_000, 2_000_000)], 1_000_000)
    expect(legend.rows[0].budget).toBe(1_000_000)
    expect(legend.rows[0].widthPct).toBe(100)
  })

  it('folds rows without a published budget into the unpublished count', () => {
    const legend = buildBudgetLegend([
      model('groq', 'llama-70b', 1, 1_000_000),
      model('pollinations', 'openai', 5, 0),
      model('llm7', 'gpt', 9, 0),
    ], 1_000_000)
    expect(legend.rows.map(r => r.modelId)).toEqual(['llama-70b'])
    expect(legend.unpublishedCount).toBe(2)
  })

  it('never divides by a zero budget', () => {
    const legend = buildBudgetLegend([model('groq', 'x', 1, 10)], 0)
    expect(legend.rows[0].widthPct).toBe(0)
  })
})
