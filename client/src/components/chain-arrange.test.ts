import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Auto-arrange (ARCH-20261026) surfaces: every string the new components
// render has to exist in all 60 locales, or an operator reads a raw key.
const here = path.dirname(fileURLToPath(import.meta.url))
const localeDir = path.join(here, '../i18n/locales')
const panel = readFileSync(path.join(here, 'chain-arrange-panel.tsx'), 'utf8')
const preview = readFileSync(path.join(here, 'chain-arrange-preview.tsx'), 'utf8')
const runs = readFileSync(path.join(here, 'chain-arrange-runs.tsx'), 'utf8')
const history = readFileSync(path.join(here, 'keys/route-history-dialog.tsx'), 'utf8')
const providerPanel = readFileSync(path.join(here, 'keys/provider-models-panel.tsx'), 'utf8')

function locale(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(localeDir, `${name}.json`), 'utf8'))
}

function lookup(dictionary: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    dictionary,
  )
}

const locales = readdirSync(localeDir)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))

// Every chainArrange.* / routeHistory.* key the components name — t('...')
// calls and the literal-key lookup maps alike. A key with a typo here would
// render the raw key at the operator. The provider panel counts too: it
// names the routeHistory.open action on its rows.
const sources = [panel, preview, runs, history, providerPanel].join('\n')
const usedKeys = [...sources.matchAll(/['"](chainArrange|routeHistory)\.[A-Za-z0-9_.]+['"]/g)]
  .map(match => match[0].slice(1, -1))


describe('chain auto-arrange UI', () => {
  it('calls only keys that exist in every locale', () => {
    expect(usedKeys.length).toBeGreaterThan(50)
    expect(usedKeys).toContain('chainArrange.title')
    expect(usedKeys).toContain('chainArrange.pinHere')
    expect(usedKeys).toContain('routeHistory.title')
    expect(locales.length).toBeGreaterThan(50)

    for (const name of locales) {
      const dictionary = locale(name)
      for (const key of usedKeys) {
        expect(typeof lookup(dictionary, key), `${name} is missing ${key}`).toBe('string')
      }
    }
  })

  it('keeps the {count} placeholders in every locale', () => {
    for (const name of locales) {
      const dictionary = locale(name)
      expect(lookup(dictionary, 'chainArrange.reasons'), `${name}.chainArrange.reasons`)
        .toContain('{count}')
      expect(lookup(dictionary, 'routeHistory.probesTitle'), `${name}.routeHistory.probesTitle`)
        .toContain('{count}')
    }
  })

})
