/**
 * The registry's own contract.
 *
 * Server-side because the data lives server-side: `@freellmapi/shared` ships no
 * JavaScript, so the rows and constants cannot live there. The client asserts
 * the panel; this asserts the inventory.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IMPERIUM_EXTENSIONS,
  EXTENSION_IDS,
  PAID_BALANCE_GUARD_ID,
  defaultExtensionEnabled,
} from '../../data/extension-registry.js';

/** Repo root: this file sits at server/src/__tests__/data/. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

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

  it('ships chain capability verification as an enforcement-only switch, on by default', () => {
    // The ruling this entry records: OFF disables the 409 and nothing else.
    // A registry entry claiming the audit or the stored evidence disappears
    // would be describing a toggle that hides a measurement, which is the one
    // thing it must never do.
    const entry = IMPERIUM_EXTENSIONS.find(f => f.id === 'chain-capability-verification');
    expect(entry).toBeDefined();
    expect(entry!.defaultEnabled).toBe(true);
    expect(entry!.disableConfirmation).toBe('none');
    expect(entry!.offBehaviour).toMatch(/remain/i);
    expect(entry!.offBehaviour).toMatch(/membership/i);
    expect(defaultExtensionEnabled()['chain-capability-verification']).toBe(true);
  });

  it('claims a real file, and a real symbol, for every extension it lists', () => {
    // A codeLocations entry that names nothing is documentation rot; the
    // registry is the map an operator uses to find the behaviour.
    //
    // TWO checks, because the shape-match this replaces caught neither of the
    // dead references found on 2026-09-19, and existence alone catches only
    // one of them:
    //
    //   quota-routing.ts (evaluateShadowDecision)  file lives, SYMBOL deleted
    //   20260905_000002_routing_decision.ts        file lives, its table dropped
    //
    // The first is what the symbol assertion below exists for. The second is
    // not mechanically detectable at all — the migration file is still on disk
    // and still correct as a migration; only its RELEVANCE to this extension
    // died. No test finds that; a reader removing the last consumer has to.
    for (const feature of IMPERIUM_EXTENSIONS) {
      for (const location of feature.codeLocations) {
        // Entries may carry a ' (symbol, note)' annotation after the path.
        const [relPath, annotation] = location.split(/ \((.*)\)$/);
        const abs = join(REPO_ROOT, relPath.trim());
        expect(existsSync(abs), `${feature.id} cites missing ${relPath}`).toBe(true);
        if (!annotation) continue;
        // Only bare identifiers are claims about code. Prose like
        // 'score path gate' or 'automatic-chain filter' describes a location
        // and asserts nothing greppable.
        const symbols = annotation.split(',').map(s => s.trim())
          .filter(s => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s));
        if (!symbols.length) continue;
        const source = readFileSync(abs, 'utf8');
        for (const symbol of symbols) {
          expect(source.includes(symbol), `${feature.id} cites ${symbol}, absent from ${relPath}`).toBe(true);
        }
      }
    }
  });
});
