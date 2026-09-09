import { describe, expect, it } from 'vitest'
import { poolLabel } from './QuotaPage'

describe('provider overview column width', () => {
  it('drops the redundant platform prefix from the pool key', () => {
    expect(poolLabel({ platform: 'nvidia', pool: 'nvidia::rolling-60s' })).toBe('rolling-60s')
    expect(poolLabel({ platform: 'groq', pool: 'groq::model::openai/gpt-oss-120b' })).toBe('model::openai/gpt-oss-120b')
    expect(poolLabel({ platform: 'ollama', pool: 'ollama::weekly' })).toBe('weekly')
  })
  it('leaves a key that does not carry the prefix alone', () => {
    expect(poolLabel({ platform: 'custom', pool: 'relay::abc' })).toBe('relay::abc')
    expect(poolLabel({ platform: 'groq', pool: null })).toBe('—')
  })
})
