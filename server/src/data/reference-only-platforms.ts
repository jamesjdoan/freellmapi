/**
 * Platforms we catalogue and benchmark but can never route to.
 *
 * OpenCode Zen's free tier answers 403 to any call that did not originate
 * inside the OpenCode CLI -- "OpenCode's free tier can only be used from within
 * OpenCode". The key is valid; the caller is refused. No provider config,
 * catalogue row or new key changes that, so a switch offering to enable one of
 * these models states something false: both the catalogue's `enabled` flag and
 * chain membership are inert for them.
 *
 * They stay in the catalogue on purpose. Their benchmark scores are the reason
 * to keep them -- a ranked place to see what the free tier offers and how it
 * measures against the models we do serve. Reference data, not routes.
 *
 * Lives here rather than in `@freellmapi/shared` because that package ships no
 * JavaScript, so a value import of it fails to resolve at runtime inside the
 * image (see the note at the top of `server/src/data/extension-registry.ts`).
 * The client keeps its own copy in `client/src/lib/routing.ts`; both are one
 * line, and they must name the same platforms.
 */
export const REFERENCE_ONLY_PLATFORMS: Record<string, true> = { opencode: true };
