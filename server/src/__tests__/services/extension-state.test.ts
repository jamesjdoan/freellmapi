import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, getSetting, setSetting } from '../../db/index.js';
import {
  loadExtensionState,
  getExtensionState,
  isExtensionEnabled,
  setExtensionEnabled,
  resetExtensionStateCache,
  ExtensionStateError,
} from '../../services/extension-state.js';
import {
  EXTENSION_STATE_KEY,
  PAID_BALANCE_GUARD_ID,
  PAID_SPEND_CONFIRMATION,
} from '@freellmapi/shared/extension-registry.js';

describe('extension state', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(EXTENSION_STATE_KEY);
    resetExtensionStateCache();
  });

  it('defaults every extension on, and the paid guard with them', () => {
    expect(isExtensionEnabled(PAID_BALANCE_GUARD_ID)).toBe(true);
    expect(isExtensionEnabled('catalogue-log')).toBe(true);
  });

  it('treats an id it has never heard of as off, not on', () => {
    // A typo in a gate must not silently enable an undeclared behaviour.
    expect(isExtensionEnabled('no-such-extension')).toBe(false);
  });

  it('persists a toggle and serves it from the snapshot', () => {
    setExtensionEnabled('catalogue-log', false);
    expect(isExtensionEnabled('catalogue-log')).toBe(false);
    // Survives a reload from the settings row, not just the in-memory copy.
    resetExtensionStateCache();
    expect(loadExtensionState().enabled['catalogue-log']).toBe(false);
  });

  it('rejects a write against a stale revision instead of clobbering it', () => {
    const stale = getExtensionState().revision;
    setExtensionEnabled('catalogue-log', false);
    expect(() => setExtensionEnabled('provider-churn', false, { expectedRevision: stale }))
      .toThrow(ExtensionStateError);
    // The newer value stands.
    expect(isExtensionEnabled('catalogue-log')).toBe(false);
    expect(isExtensionEnabled('provider-churn')).toBe(true);
  });

  describe('the paid-balance guard', () => {
    it('refuses to switch off without the typed confirmation', () => {
      expect(() => setExtensionEnabled(PAID_BALANCE_GUARD_ID, false)).toThrow(/confirmation/i);
      expect(() => setExtensionEnabled(PAID_BALANCE_GUARD_ID, false, { confirmation: 'yes' }))
        .toThrow(/confirmation/i);
      // Still guarding after both refusals.
      expect(isExtensionEnabled(PAID_BALANCE_GUARD_ID)).toBe(true);
    });

    it('switches off with the confirmation, and records when that was authorised', () => {
      const state = setExtensionEnabled(PAID_BALANCE_GUARD_ID, false, { confirmation: PAID_SPEND_CONFIRMATION });
      expect(isExtensionEnabled(PAID_BALANCE_GUARD_ID)).toBe(false);
      expect(state.paidSpendAcknowledgement?.policyVersion).toBe(1);
      expect(Date.parse(state.paidSpendAcknowledgement!.confirmedAt)).toBeLessThanOrEqual(Date.now());
    });

    it('spends the acknowledgement when re-enabled, so a second disable is authorised again', () => {
      setExtensionEnabled(PAID_BALANCE_GUARD_ID, false, { confirmation: PAID_SPEND_CONFIRMATION });
      setExtensionEnabled(PAID_BALANCE_GUARD_ID, true);
      expect(getExtensionState().paidSpendAcknowledgement).toBeNull();
      expect(() => setExtensionEnabled(PAID_BALANCE_GUARD_ID, false)).toThrow(/confirmation/i);
    });

    it('repairs an off guard that carries no acknowledgement, rather than honouring it', () => {
      // How this happens for real: a hand-edited settings row, a restored
      // backup from before the acknowledgement, or a partial write. Failing
      // open here would spend real credit on evidence nobody produced.
      setSetting(EXTENSION_STATE_KEY, JSON.stringify({
        version: 1, revision: 9,
        enabled: { [PAID_BALANCE_GUARD_ID]: false },
        paidSpendAcknowledgement: null,
      }));
      resetExtensionStateCache();
      expect(isExtensionEnabled(PAID_BALANCE_GUARD_ID)).toBe(true);
    });

    it('falls back to guarding when the document is corrupt', () => {
      setSetting(EXTENSION_STATE_KEY, '{not json');
      resetExtensionStateCache();
      expect(isExtensionEnabled(PAID_BALANCE_GUARD_ID)).toBe(true);
      expect(getSetting(EXTENSION_STATE_KEY)).toBe('{not json'); // read-only repair
    });
  });
});
