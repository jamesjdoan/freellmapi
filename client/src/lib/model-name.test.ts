import { describe, expect, it } from 'vitest'
import { splitModelName } from './model-name'

describe('splitModelName', () => {
  it('reduces an effort variant to its level, however the source spells it', () => {
    expect(splitModelName('Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback)'))
      .toEqual({ base: 'Claude Fable 5.1', variant: 'Xhigh' })
    expect(splitModelName('GPT-5.2 (xhigh)')).toEqual({ base: 'GPT-5.2', variant: 'Xhigh' })
    expect(splitModelName('Qwen3.6 (medium)')).toEqual({ base: 'Qwen3.6', variant: 'Medium' })
  })

  it('keeps the parts that distinguish siblings', () => {
    const reasoning = splitModelName('Claude Sonnet 5 (Adaptive Reasoning, High Effort)')
    const plain = splitModelName('Claude Sonnet 5 (Non-reasoning, High Effort)')
    expect(plain).toEqual({ base: 'Claude Sonnet 5', variant: 'High · Non-reasoning' })
    expect(reasoning.variant).not.toBe(plain.variant)
    expect(splitModelName('Claude Opus 5 (Max Effort, Opus 4.8 Fallback)').variant).toBe('Max · Opus 4.8 Fallback')
    expect(splitModelName("DeepSeek R1 (Jan '25)")).toEqual({ base: 'DeepSeek R1', variant: "Jan '25" })
  })

  it('drops a variant that says only the default', () => {
    expect(splitModelName('Qwen3.6 Max (Reasoning)')).toEqual({ base: 'Qwen3.6 Max', variant: null })
    expect(splitModelName('Qwen3.6 Max (Non-reasoning)')).toEqual({ base: 'Qwen3.6 Max', variant: 'Non-reasoning' })
  })

  it('leaves a name with no trailing parenthetical whole', () => {
    expect(splitModelName('Gemini 3.5 Flash')).toEqual({ base: 'Gemini 3.5 Flash', variant: null })
  })
})
