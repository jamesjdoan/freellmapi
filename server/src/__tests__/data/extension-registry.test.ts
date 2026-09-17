/**
 * The registry's own contract.
 *
 * Server-side because the data lives server-side: `@freellmapi/shared` ships no
 * JavaScript, so the rows and constants cannot live there. The client asserts
 * the panel; this asserts the inventory.
 */
import { describe, it, expect } from 'vitest';
import {
  IMPERIUM_EXTENSIONS,
  EXTENSION_IDS,
  PAID_BALANCE_GUARD_ID,
  defaultExtensionEnabled,
} from '../../data/extension-registry.js';

describe('the extension registry', () => {
  // Deliberately NOT pinning the id list: it grew from 19 to 32 and would fail
  // on every addition without telling anyone anything. What matters is that
  // each entry is addressable and documents its own off-behaviour.
  it('gives every entry a unique id and a reachable destination', () => {
    expect(new Set(EXTENSION_IDS).size).toBe(EXTENSION_IDS.length);
    for (const feature of IMPERIUM_EXTENSIONS) {
      expect(feature.destinations.length).toBeGreaterThan(0);
      for (const destination of feature.destinations) {
        if (destination.kind === 'internal') expect(destination.href).toMatch(/^\//);
        else expect(destination.href).toMatch(/^https:\/\//);
      }
    }
  });

  it('documents what switching each one off actually does', () => {
    // The whole point of the registry: an operator about to disable something
    // can read what stops and what is retained before they do it.
    for (const feature of IMPERIUM_EXTENSIONS) {
      expect(feature.offBehaviour.length).toBeGreaterThan(20);
      expect(feature.takesEffect.length).toBeGreaterThan(5);
      expect(feature.codeLocations.length).toBeGreaterThan(0);
      expect(feature.settingsLocation.length).toBeGreaterThan(0);
    }
  });

  it('guards paid spend, and only paid spend, behind a typed confirmation', () => {
    const needConfirmation = IMPERIUM_EXTENSIONS.filter(f => f.disableConfirmation === 'paid-spend');
    expect(needConfirmation.map(f => f.id)).toEqual([PAID_BALANCE_GUARD_ID]);
    // It must also default to ON, or a fresh install routes paid by omission.
    expect(defaultExtensionEnabled()[PAID_BALANCE_GUARD_ID]).toBe(true);
  });

  it('claims a real file for every extension it lists', () => {
    // A codeLocations entry that names nothing is documentation rot; the
    // registry is the map an operator uses to find the behaviour.
    for (const feature of IMPERIUM_EXTENSIONS) {
      for (const location of feature.codeLocations) {
        expect(location).toMatch(/\.(ts|tsx|mjs|sh|md|json)\b|\//);
      }
    }
  });
});
