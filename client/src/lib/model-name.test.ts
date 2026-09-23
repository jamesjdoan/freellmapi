import { describe, expect, it } from 'vitest'
import { shortModelName } from './model-name'

describe('shortModelName', () => {
  it('reduces an effort variant to its level', () => {
    expect(shortModelName('Claude Fable 5.1 (Adaptive Reasoning, Xhigh Effort, Default Fallback)')).toBe('Claude Fable 5.1 · Xhigh')
  })

  it('keeps the parts that distinguish siblings with the same effort', () => {
    const reasoning = shortModelName('Claude Sonnet 5 (Adaptive Reasoning, High Effort)')
    const plain = shortModelName('Claude Sonnet 5 (Non-reasoning, High Effort)')
    expect(plain).toBe('Claude Sonnet 5 · High · Non-reasoning')
    expect(reasoning).not.toBe(plain)
    expect(shortModelName('Claude Opus 5 (Max Effort, Opus 4.8 Fallback)')).toBe('Claude Opus 5 · Max · Opus 4.8 Fallback')
  })

  it('leaves names without an effort part untouched', () => {
    expect(shortModelName('GPT-5 (high)')).toBe('GPT-5 (high)')
    expect(shortModelName("DeepSeek R1 (Jan '25)")).toBe("DeepSeek R1 (Jan '25)")
    expect(shortModelName('Gemini 3.5 Flash')).toBe('Gemini 3.5 Flash')
  })
})
