// @vitest-environment jsdom
//
// The export tests next door prove the Markdown is right, and a
// renderToStaticMarkup check proves the trigger is visible. Neither could
// prove the *menu* works: Base UI mounts popup content only once the menu
// opens, so a first cut of this control shipped `DropdownMenuLabel` outside a
// `DropdownMenuGroup` and passed every test while crashing the whole dialog
// with "MenuGroupContext is missing" the moment the trigger was clicked.
//
// So this file opens the menu for real and reads what comes out.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { FreeCatalogCopyAction } from './free-catalog-copy-action'
import type { FreeCatalogScope } from '@/lib/provider-model-details-export'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLElement | null = null
let root: Root | null = null

afterEach(async () => {
  // The menu popup is portaled outside `container`, so unmounting the root is
  // what actually clears it — otherwise the next test's document-wide item
  // query still finds this test's menu.
  if (root) await act(async () => { root!.unmount() })
  root = null
  container?.remove()
  container = null
})

async function openMenu(buildText: (scope: FreeCatalogScope) => string) {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => { root!.render(<FreeCatalogCopyAction buildText={buildText} />) })

  const trigger = container.querySelector<HTMLElement>('[data-slot=dropdown-menu-trigger]')
  expect(trigger).not.toBeNull()
  await act(async () => { trigger!.click() })

  return {
    trigger: trigger!,
    items: Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]')),
  }
}

describe('free catalogue copy action', () => {
  it('opens one menu offering both catalogue scopes', async () => {
    const { items } = await openMenu(() => 'ignored')

    expect(items.map(item => item.textContent?.trim())).toEqual([
      'All providers and models',
      'Active providers and models',
    ])
    // The group label the crash was hiding in.
    expect(document.querySelector('[role=group]')?.textContent).toContain('Every provider, not just this one')
  })

  it('copies the scope the chosen item names', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { written.push(text) } },
    })

    const { items } = await openMenu(scope => `export for ${scope}`)
    await act(async () => { items[1].click() })

    expect(written).toEqual(['export for active'])
  })
})
