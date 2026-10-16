// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { BonusGrantsPanel } from './bonus-grants-panel'
import type { BonusGrantView } from '../../../../shared/bonus-types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient

const futureDate = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString()
const pastDate = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString()

const makeGrant = (overrides: Partial<BonusGrantView> = {}): BonusGrantView => ({
  id: 1,
  label: 'Xkiro bonus',
  platform: 'xkiro',
  keyIds: [10],
  metric: 'total_tokens',
  quantity: 30_000_000,
  used: 500_000,
  reserved: 10_000,
  remaining: 29_490_000,
  startsAt: pastDate(24),
  expiresAt: futureDate(696),
  status: 'active',
  normal: {
    limit: 1_000_000,
    limitSource: 'operator',
    used: 308,
    remaining: 999_692,
    resetAt: futureDate(4),
    timezone: 'UTC',
  },
  allowance: null,
  accounting: 'local',
  ...overrides,
})

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/api/quota/bonuses') return { grants: [makeGrant()], observedAt: new Date().toISOString() }
    if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'My xKiro key' }]
    return {}
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
}
function mount() {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <BonusGrantsPanel />
      </I18nProvider>
    </QueryClientProvider>
  ))
}

describe('BonusGrantsPanel', () => {
  it('renders grant pool, normal allowance, and spending window sections distinctly', async () => {
    mount()
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('Bonus grants')
    expect(text).toContain('Normal allowance')
    expect(text).toContain('Grant pool')
    expect(text).toContain('Spending window')
    expect(text).toContain('Xkiro bonus')
    expect(text).toContain('xkiro')
    expect(text).toContain('tokens')
  })

  it('says whether the normal limit is the provider\'s figure or the operator\'s', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return {
        grants: [makeGrant({ normal: { limit: 1_200_000, limitSource: 'provider', used: 1_500_000, remaining: 0, resetAt: futureDate(4), timezone: 'UTC' } })],
        observedAt: new Date().toISOString(),
      }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }]
      return {}
    })
    mount()
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('1,500,000 / 1,200,000')
    expect(text).toContain('limit reported by provider')
    expect(text).toContain('125%')
    const normalMeter = container.querySelector('[role="meter"][aria-label="Normal allowance"]')
    expect(normalMeter?.getAttribute('aria-valuenow')).toBe('100')
  })

  it('renders progress meter bars for normal, pool, and allowance', async () => {
    mount()
    await flush()
    const meters = container.querySelectorAll('[role="meter"]')
    expect(meters.length).toBeGreaterThanOrEqual(2)
  })

  it('shows empty state when no grants exist', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return { grants: [], observedAt: new Date().toISOString() }
      if (path === '/api/keys') return []
      return {}
    })
    mount()
    await flush()
    expect(container.textContent).toContain('No bonus grants configured')
  })


  it('shows active allowance details and cancel button when allowance exists', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return {
        grants: [makeGrant({
          allowance: {
            id: 100, quantity: 2_000_000, used: 50_000, reserved: 0, remaining: 1_950_000,
            startsAt: pastDate(1), expiresAt: futureDate(5), status: 'active',
          },
        })],
        observedAt: new Date().toISOString(),
      }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }]
      return {}
    })
    mount()
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('Active')
    expect(text).toContain('window closes in')
  })

  it('shows expired and exhausted statuses without countdowns', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return {
        grants: [
          makeGrant({ id: 1, status: 'expired', expiresAt: pastDate(1) }),
          makeGrant({ id: 2, status: 'exhausted', remaining: 0, expiresAt: pastDate(2) }),
        ],
        observedAt: new Date().toISOString(),
      }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }]
      return {}
    })
    mount()
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('Expired')
    expect(text).toContain('Exhausted')
  })

  it('opens create form on New grant click', async () => {
    mount()
    await flush()
    const newBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('New grant'))
    expect(newBtn).toBeDefined()
    act(() => newBtn!.click())
    await flush()
    expect(container.textContent).toContain('Create bonus grant')
  })

  it('sends POST /api/quota/bonuses on create form submit with correct payload shape', async () => {
    mount()
    await flush()
    const newBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('New grant'))!
    act(() => newBtn.click())
    await flush()

    const keySelect = [...container.querySelectorAll('select')].find(s => s.multiple)!
    act(() => {
      keySelect.querySelector<HTMLOptionElement>('option[value="10"]')!.selected = true
      keySelect.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const createBtn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Create grant')!
    act(() => createBtn.click())
    await flush()
    const postCall = vi.mocked(apiFetch).mock.calls.find(([path, opts]) => path === '/api/quota/bonuses' && opts?.method === 'POST')
    expect(postCall).toBeDefined()
    expect(JSON.parse(postCall![1]!.body as string)).toEqual({
      platform: 'xkiro', keyIds: [10], metric: 'total_tokens',
      quantity: 30_000_000, durationHours: 720, normalLimit: 1_000_000, timezone: 'UTC',
    })
  })

  it('offers only request and token grants', async () => {
    mount()
    await flush()
    const newBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('New grant'))!
    act(() => newBtn.click())
    await flush()
    const metricSelect = [...container.querySelectorAll('select')].find(s => !s.multiple && s.querySelector('option[value="requests"]'))!
    expect([...metricSelect.options].map(o => o.value)).toEqual(['requests', 'total_tokens'])
  })

  it('distinguishes grant pool from spending window labels', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return {
        grants: [makeGrant({
          allowance: {
            id: 100, quantity: 2_000_000, used: 0, reserved: 0, remaining: 2_000_000,
            startsAt: pastDate(1), expiresAt: futureDate(5), status: 'active',
          },
        })],
        observedAt: new Date().toISOString(),
      }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }]
      return {}
    })
    mount()
    await flush()
    const text = container.textContent ?? ''
    // Pool shows total 30M, window shows 2M — both present
    expect(text).toContain('Grant pool')
    expect(text).toContain('Spending window')
    expect(text).toContain('30,000,000')
    expect(text).toContain('2,000,000')
  })

  it('handles API errors gracefully with visible message', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') throw new Error('Server unavailable')
      if (path === '/api/keys') return []
      return {}
    })
    mount()
    await flush()
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('Server unavailable')
  })

  it('shows pool quantity field on edit form populated from existing grant', async () => {
    mount()
    await flush()
    const editBtn = container.querySelector('button[aria-label="Edit"]') as HTMLButtonElement | null
    expect(editBtn).not.toBeNull()
    act(() => editBtn!.click())
    await flush()
    expect(container.textContent).toContain('Edit bonus grant')
    const qtyInput = container.querySelector('input[inputmode="numeric"]') as HTMLInputElement | null
    expect(qtyInput).not.toBeNull()
    expect(qtyInput!.value).toBe('30000000')
  })

  it('sends PATCH then POST allowance sequentially on edit save, closing only after both succeed', async () => {
    const callOrder: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/quota/bonuses' && !opts?.method) return { grants: [makeGrant()], observedAt: new Date().toISOString() }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }]
      if (path.startsWith('/api/quota/bonuses/') && path.endsWith('/allowance') && opts?.method === 'POST') {
        callOrder.push('allowance')
        return { grant: makeGrant() }
      }
      if (path.startsWith('/api/quota/bonuses/') && opts?.method === 'PATCH') {
        callOrder.push('update')
        return { grant: makeGrant() }
      }
      return {}
    })
    mount()
    await flush()
    const editBtn = container.querySelector('button[aria-label="Edit"]') as HTMLButtonElement | null
    act(() => editBtn!.click())
    await flush()
    // Change label to trigger update, add allowance values
    const inputs = container.querySelectorAll('input')
    const labelInput = [...inputs].find(i => i.placeholder === 'Optional label') as HTMLInputElement | undefined
    if (labelInput) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(labelInput, 'Updated label')
        labelInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const numericInputs = [...inputs].filter(i => i.inputMode === 'numeric')
    // allowanceQuantity is first numeric in edit mode after pool qty, allowanceDuration second
    const allowQtyInput = numericInputs.find(i => i.placeholder === 'Leave empty to keep the current window') as HTMLInputElement | undefined
    const allowDurInput = numericInputs.find(i => i.placeholder === 'hours') as HTMLInputElement | undefined
    if (allowQtyInput) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(allowQtyInput, '500000')
        allowQtyInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    if (allowDurInput) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(allowDurInput, '6')
        allowDurInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const saveBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Save changes'))
    if (saveBtn) {
      act(() => saveBtn.click())
      await flush()
      await flush()
    }
    expect(callOrder).toEqual(['update', 'allowance'])
  })

  it('keeps form open and shows error when allowance mutation fails after successful update', async () => {
    let callCount = 0
    vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: RequestInit) => {
      if (path === '/api/quota/bonuses' && !opts?.method) return { grants: [makeGrant()], observedAt: new Date().toISOString() }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }]
      if (path.startsWith('/api/quota/bonuses/') && path.endsWith('/allowance') && opts?.method === 'POST') {
        throw new Error('Allowance rejected')
      }
      if (path.startsWith('/api/quota/bonuses/') && opts?.method === 'PATCH') {
        callCount++
        return { grant: makeGrant() }
      }
      return {}
    })
    mount()
    await flush()
    const editBtn = container.querySelector('button[aria-label="Edit"]') as HTMLButtonElement | null
    act(() => editBtn!.click())
    await flush()
    const inputs = container.querySelectorAll('input')
    const labelInput = [...inputs].find(i => i.placeholder === 'Optional label') as HTMLInputElement | undefined
    if (labelInput) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(labelInput, 'New')
        labelInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const allowQtyInput = [...inputs].find(i => i.placeholder === 'Leave empty to keep the current window') as HTMLInputElement | undefined
    const allowDurInput = [...inputs].find(i => i.placeholder === 'hours') as HTMLInputElement | undefined
    if (allowQtyInput) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(allowQtyInput, '100')
        allowQtyInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    if (allowDurInput) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(allowDurInput, '1')
        allowDurInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const saveBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Save changes'))
    if (saveBtn) {
      act(() => saveBtn.click())
      await flush()
      await flush()
    }
    expect(callCount).toBe(1)
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('Allowance rejected')
    expect(container.textContent).toContain('Edit bonus grant')
  })

  it('defaults to xkiro platform when available and applies Xkiro defaults', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return { grants: [], observedAt: new Date().toISOString() }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'Key' }, { id: 11, platform: 'groq', label: 'G' }]
      return {}
    })
    mount()
    await flush()
    const newBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('New grant'))!
    act(() => newBtn.click())
    await flush()
    const providerSelect = container.querySelector('select:not([multiple])') as HTMLSelectElement | null
    expect(providerSelect?.value).toBe('xkiro')
    const numericInputs = container.querySelectorAll('input[inputmode="numeric"]')
    const qtyInput = numericInputs[0] as HTMLInputElement | undefined
    expect(qtyInput?.value).toBe('30000000')
  })

  it('clears Xkiro defaults and key selection when switching to non-xkiro provider', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/quota/bonuses') return { grants: [], observedAt: new Date().toISOString() }
      if (path === '/api/keys') return [{ id: 10, platform: 'xkiro', label: 'XK' }, { id: 11, platform: 'groq', label: 'GQ' }]
      return {}
    })
    mount()
    await flush()
    const newBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('New grant'))!
    act(() => newBtn.click())
    await flush()
    const providerSelect = container.querySelector('select:not([multiple])') as HTMLSelectElement | null
    expect(providerSelect).not.toBeNull()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(providerSelect!, 'groq')
      providerSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    const numericInputs = container.querySelectorAll('input[inputmode="numeric"]')
    const qtyInput = numericInputs[0] as HTMLInputElement | undefined
    expect(qtyInput?.value).toBe('')
    const keySelect = container.querySelector('select[multiple]') as HTMLSelectElement | null
    expect(keySelect?.selectedOptions.length ?? 0).toBe(0)
  })
})
