import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ExtensionFeatureList } from '../components/extensions-dialog'
import { IMPERIUM_EXTENSIONS } from './extension-registry'

describe('Imperium extension registry', () => {
  it('keeps every feature addressable and links settings into the dashboard', () => {
    expect(IMPERIUM_EXTENSIONS.map(feature => feature.id)).toEqual([
      'provider-preference',
      'models-hide-disabled',
      'provider-model-access',
      'provider-row-summary',
      'provider-account-limits',
      'provider-quota-guidance',
      'free-catalogue-copy',
      'quota-pool-routing',
      'quota-capacity-dashboard',
      'nav-playground-agents-menu',
      'catalogue-log',
      'provider-churn',
      'model-benchmarks',
      'benchmark-mapping',
      'benchmark-proxy',
      'logical-model-merge',
      'provider-models-panel',
      'key-reachability',
      'separate-extension-branch',
    ])
    expect(new Set(IMPERIUM_EXTENSIONS.map(feature => feature.id)).size).toBe(IMPERIUM_EXTENSIONS.length)

    for (const feature of IMPERIUM_EXTENSIONS) {
      expect(feature.destinations.length).toBeGreaterThan(0)
      for (const destination of feature.destinations) {
        if (destination.kind === 'internal') expect(destination.href).toMatch(/^\//)
        else expect(destination.href).toMatch(/^https:\/\//)
      }
    }
  })

  it('renders installed status and direct destinations for every feature', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExtensionFeatureList />
      </MemoryRouter>,
    )

    for (const feature of IMPERIUM_EXTENSIONS) {
      expect(html).toContain(feature.title)
      expect(html).toContain(feature.settingsLocation.replaceAll('&', '&amp;'))
      for (const destination of feature.destinations) expect(html).toContain(`href="${destination.href}"`)
    }
    expect(html.match(/Installed/g)).toHaveLength(IMPERIUM_EXTENSIONS.length)
  })
})
