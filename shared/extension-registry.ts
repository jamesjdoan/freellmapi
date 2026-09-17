/**
 * TYPES ONLY.
 *
 * `@freellmapi/shared` is a types-only package: it ships `types.ts` and no
 * JavaScript, and every existing import of it across the server is
 * `import type`, which TypeScript erases at compile time. Nothing here may
 * therefore be a runtime VALUE -- a value import from this package resolves to
 * `/app/node_modules/@freellmapi/shared/<name>.js` inside the image, which does
 * not exist, and the container fails at module load. That is exactly how the
 * first v0.11.0 deploy attempt died, after every local test, typecheck and
 * build had passed: only the built image can catch it.
 *
 * The registry DATA and its constants live in
 * `server/src/data/extension-registry.ts`, which compiles into `server/dist`.
 * The client needs no value from either: it reads rows from
 * `GET /api/extensions`, identifies the guarded entry by
 * `disableConfirmation === 'paid-spend'`, and is told the confirmation phrase
 * by that same payload.
 */

export type ExtensionCategory =
  /** Changes what is shown. Off = upstream's UI, with no loss of stored data. */
  | 'presentation'
  /** Changes which physical route a request gets. Off = upstream's routing. */
  | 'routing'
  /** Prevents a class of harm. Off needs an explicit, recorded decision. */
  | 'safety'
  /** Operator tooling outside the request path. Off = the command refuses. */
  | 'tooling';

export type ExtensionDestination = {
  kind: 'internal' | 'external';
  label: string;
  href: string;
};

export type ImperiumExtension = {
  /** Stable id. One independently toggleable extension per id, and the key
   *  used in the persisted `enabled` map - never renamed once shipped. */
  id: string;
  title: string;
  summary: string;
  /** Where its own parameters live. Human-readable, not a route to parse. */
  settingsLocation: string;
  destinations: ExtensionDestination[];
  category: ExtensionCategory;
  /** Initialisation default for an id absent from the persisted document.
   *  The paid-balance guard is always true and may not ship otherwise. */
  defaultEnabled: boolean;
  /** Exactly what stops happening, and what is retained, when off. */
  offBehaviour: string;
  /** The boundary at which a change applies: next request, next job, next
   *  page load, next invocation - including anything already in flight. */
  takesEffect: string;
  /** Files and symbols that implement it, including its gate. Maintenance
   *  metadata for a reader; never resolved or executed. */
  codeLocations: string[];
  /** Dangerous transitions need a fixed, named confirmation policy. */
  disableConfirmation: 'none' | 'paid-spend';
};

/** The one mutable document, stored as JSON in `settings.imperium_extensions`. */
export interface ExtensionState {
  version: 1;
  /** Monotonic, for compare-and-set writes and client refresh. */
  revision: number;
  enabled: Record<string, boolean>;
  /** Required before the paid-balance guard may be off. Cleared when the
   *  guard returns on, so a second disable must be acknowledged again. An
   *  off guard with no acknowledgement is rejected at load. */
  paidSpendAcknowledgement: null | { policyVersion: 1; confirmedAt: string };
}
