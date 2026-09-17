/**
 * Enablement state for the fork's extensions.
 *
 * ONE JSON document in `settings.imperium_extensions`, loaded once into an
 * immutable snapshot. `isExtensionEnabled()` is called on the request path, so
 * it must not touch SQLite: `getSetting` is a SELECT, and a gate per candidate
 * per attempt would add queries to every request.
 *
 * Writes go through `setExtensionEnabled()`, which commits the document and
 * swaps the snapshot synchronously, so the next dispatch sees the new value.
 *
 * The paid-balance guard is deliberately asymmetric. Turning it OFF requires a
 * typed confirmation and records an acknowledgement; an off state that reaches
 * `load()` WITHOUT a valid acknowledgement is repaired to ON rather than
 * honoured. A dropped table, a hand-edited settings row or a restored backup
 * from before the acknowledgement therefore fails safe.
 */
import { getSetting, setSetting } from '../db/index.js';
import type { ExtensionState } from '@freellmapi/shared/extension-registry.js';
import {
  EXTENSION_STATE_KEY,
  EXTENSION_IDS,
  PAID_BALANCE_GUARD_ID,
  PAID_SPEND_CONFIRMATION,
  defaultExtensionEnabled,
} from '../data/extension-registry.js';

export class ExtensionStateError extends Error {
  constructor(message: string, readonly code: 'unknown_extension' | 'revision_conflict' | 'confirmation_required') {
    super(message);
  }
}

let snapshot: Readonly<ExtensionState> | null = null;

function freshState(): ExtensionState {
  return { version: 1, revision: 0, enabled: defaultExtensionEnabled(), paidSpendAcknowledgement: null };
}

function parse(raw: string | undefined): ExtensionState {
  if (!raw?.trim()) return freshState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt document must not silently disable safety. Start clean.
    return freshState();
  }
  const doc = (parsed ?? {}) as Partial<ExtensionState>;
  const enabled = defaultExtensionEnabled();
  for (const [id, value] of Object.entries(doc.enabled ?? {})) {
    // Unknown ids are dropped rather than retained: an id only exists if the
    // registry declares it, and a stale one would be invisible in the UI.
    if (id in enabled && typeof value === 'boolean') enabled[id] = value;
  }
  const ack = doc.paidSpendAcknowledgement ?? null;
  const ackValid = !!ack && ack.policyVersion === 1 && typeof ack.confirmedAt === 'string' && !!ack.confirmedAt;

  // Fail safe: guard off is only honoured with a valid acknowledgement.
  if (enabled[PAID_BALANCE_GUARD_ID] === false && !ackValid) enabled[PAID_BALANCE_GUARD_ID] = true;

  return {
    version: 1,
    revision: typeof doc.revision === 'number' && doc.revision >= 0 ? doc.revision : 0,
    enabled,
    paidSpendAcknowledgement: ackValid ? { policyVersion: 1, confirmedAt: ack!.confirmedAt } : null,
  };
}

/** Load the document into the snapshot. Call once after migrations, before
 *  listeners and jobs start. Safe to call again; it simply re-reads. */
export function loadExtensionState(): Readonly<ExtensionState> {
  snapshot = Object.freeze(parse(getSetting(EXTENSION_STATE_KEY)));
  return snapshot;
}

export function getExtensionState(): Readonly<ExtensionState> {
  return snapshot ?? loadExtensionState();
}

/**
 * The request-path gate. A map lookup against the frozen snapshot.
 *
 * An unknown id returns false rather than true: a typo in a gate must not
 * silently enable a behaviour that was never declared.
 */
export function isExtensionEnabled(id: string): boolean {
  return getExtensionState().enabled[id] === true;
}

/**
 * Commit one toggle.
 *
 * `expectedRevision` is compare-and-set: a second tab holding a stale view
 * gets a conflict rather than clobbering the newer document.
 */
export function setExtensionEnabled(
  id: string,
  enabled: boolean,
  options: { expectedRevision?: number; confirmation?: string } = {},
): Readonly<ExtensionState> {
  if (!EXTENSION_IDS.includes(id)) {
    throw new ExtensionStateError(`unknown extension '${id}'`, 'unknown_extension');
  }
  const current = getExtensionState();
  if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
    throw new ExtensionStateError(
      `state moved on: expected revision ${options.expectedRevision}, current is ${current.revision}`,
      'revision_conflict',
    );
  }

  let acknowledgement = current.paidSpendAcknowledgement;
  if (id === PAID_BALANCE_GUARD_ID) {
    if (!enabled) {
      // Disabling the guard IS the authorisation to spend money. A plain flag
      // write cannot do it.
      if (options.confirmation !== PAID_SPEND_CONFIRMATION) {
        throw new ExtensionStateError(
          `disabling the paid-balance guard requires confirmation '${PAID_SPEND_CONFIRMATION}'`,
          'confirmation_required',
        );
      }
      acknowledgement = { policyVersion: 1, confirmedAt: new Date().toISOString() };
    } else {
      // Back on: the acknowledgement is spent, so a later disable must be
      // acknowledged again rather than inheriting this one.
      acknowledgement = null;
    }
  }

  const next: ExtensionState = {
    version: 1,
    revision: current.revision + 1,
    enabled: { ...current.enabled, [id]: enabled },
    paidSpendAcknowledgement: acknowledgement,
  };
  setSetting(EXTENSION_STATE_KEY, JSON.stringify(next));
  snapshot = Object.freeze(next);
  return snapshot;
}

/** Test seam only: drop the snapshot so the next read re-parses. */
export function resetExtensionStateCache(): void {
  snapshot = null;
}
