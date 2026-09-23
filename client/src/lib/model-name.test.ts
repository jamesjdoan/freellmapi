import { describe, expect, it } from 'vitest'
import { splitModelName } from './model-name'

describe('splitModelName', () => {
  it('reduces an effort variant to its level', () => {
    expect(splitModelName('Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback)'))
      .toEqual({ base: 'Claude Fable 5.1', variant: 'Xhigh' })
  })

  it('keeps the parts that distinguish siblings with the same effort', () => {
    const reasoning = splitModelName('Claude Sonnet 5 (Adaptive Reasoning, High Effort)')
    const plain = splitModelName('Claude Sonnet 5 (Non-reasoning, High Effort)')
    expect(plain).toEqual({ base: 'Claude Sonnet 5', variant: 'High · Non-reasoning' })
    expect(reasoning.variant).not.toBe(plain.variant)
    expect(splitModelName('Claude Opus 5 (Max Effort, Opus 4.8 Fallback)').variant).toBe('Max · Opus 4.8 Fallback')
  })

  it('leaves names without an effort part whole', () => {
    for (const name of ['GPT-5 (high)', "DeepSeek R1 (Jan '25)", 'Gemini 3.5 Flash']) {
      expect(splitModelName(name)).toEqual({ base: name, variant: null })
    }
  })
})
