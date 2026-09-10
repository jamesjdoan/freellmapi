// Matching our catalogue model ids to Artificial Analysis slugs.
//
// The two namespaces disagree in every way they can:
//
//   ours                                          theirs
//   openai/gpt-oss-120b            (groq)         gpt-oss-120b
//   nvidia/nemotron-3-ultra-550b-a55b:free        nemotron-3-ultra-550b
//   moonshotai/kimi-k3             (nvidia)       kimi-k3
//   @cf/meta/llama-3.3-70b-instruct-fp8-fast      llama-3.3-70b
//
// So: strip the vendor prefix our providers add, strip the `:free` and similar
// route suffixes, strip serving-detail suffixes that are not part of the model
// (quantisation, speed variants), then compare what remains.
//
// Deliberately conservative. A wrong match is worse than no match: it puts
// another model's benchmark scores next to a model and invites a decision on
// them. Everything here either matches exactly on a normalised form or does
// not match at all — no fuzzy distance, no "closest" candidate. What cannot be
// matched is reported for the operator to map by hand, which is a surface that
// exists precisely so this code does not have to guess.

/** Route and serving suffixes that are not part of the model's identity. */
const ROUTE_SUFFIXES = [
  ':free', '-free', ':nitro', ':floor', ':extended', ':online', ':thinking',
  '-fp8', '-fp8-fast', '-fast', '-instruct', '-it', '-chat', '-preview', '-latest',
];

/** Cloudflare prefixes its whole catalogue; ours keep the marker. */
const PATH_PREFIXES = ['@cf/', '@hf/', 'accounts/'];

/**
 * A comparable form of a model identifier.
 *
 * Lowercased, vendor path removed, route suffixes removed, and every remaining
 * separator dropped so `gpt-oss-120b`, `gpt_oss_120b` and `gptoss120b` are one
 * key. Digits and letters survive: `3.5` and `35` collapse together, which is
 * intended - `qwen3.5` and `qwen-35` are the same model written twice - while
 * `llama-3.3-70b` and `llama-3.1-70b` stay distinct.
 */
export function normalizeModelKey(raw: string): string {
  let s = raw.trim().toLowerCase();
  for (const prefix of PATH_PREFIXES) {
    if (s.startsWith(prefix)) s = s.slice(prefix.length);
  }
  // The vendor path our providers prepend (`openai/`, `moonshotai/`, ...).
  // Only the LAST segment is the model, and only when a slash is present -
  // a slug like `gpt-oss-120b` must survive untouched.
  const slash = s.lastIndexOf('/');
  if (slash !== -1) s = s.slice(slash + 1);
  // Repeatedly, because these stack: `-instruct-fp8-fast`.
  let trimming = true;
  while (trimming) {
    trimming = false;
    for (const suffix of ROUTE_SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        trimming = true;
      }
    }
  }
  // Mixture-of-experts active-parameter tails: `-a55b` on
  // `nemotron-3-ultra-550b-a55b`, which AA publishes as
  // `nemotron-3-ultra-550b`. It describes how the model runs, not which model
  // it is, and only ever appears after the total parameter count.
  s = s.replace(/-a\d+(?:\.\d+)?b$/, '');
  return s.replace(/[^a-z0-9]/g, '');
}

export interface AaCandidate {
  slug: string;
  name: string;
}

export interface MatchResult {
  slug: string;
  /** Which comparison succeeded, so a reader can judge whether to trust it. */
  reason: 'slug' | 'name';
}

/**
 * The AA model our (platform, modelId) row corresponds to, or null.
 *
 * Tries the slug first and the display name second. Name matching earns its
 * place because some providers publish a marketing name where AA publishes a
 * slug (`Kimi K3 (NVIDIA NIM)` against `kimi-k3`), and normalisation reduces
 * both to the same key.
 *
 * An ambiguous key - two AA models normalising identically - matches NOTHING.
 * Picking one would be a coin toss presented as data.
 */
export function matchAaModel(
  modelId: string,
  displayName: string | null,
  candidates: readonly AaCandidate[],
): MatchResult | null {
  const bySlug = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const c of candidates) {
    push(bySlug, normalizeModelKey(c.slug), c.slug);
    push(byName, normalizeModelKey(c.name), c.slug);
  }

  const modelKey = normalizeModelKey(modelId);
  // An ambiguous slug key ends it. Falling through to the name map would let
  // one AA model win a collision it should have lost, which is the coin toss
  // this function exists to refuse.
  if (isAmbiguous(bySlug.get(modelKey))) return null;

  const slugHit = unique(bySlug.get(modelKey));
  if (slugHit) return { slug: slugHit, reason: 'slug' };

  const nameHit = unique(byName.get(modelKey));
  if (nameHit) return { slug: nameHit, reason: 'name' };

  if (displayName) {
    // Our display names carry the provider in brackets - "Kimi K3 (NVIDIA
    // NIM)" - which is serving detail, not identity.
    const cleaned = displayName.replace(/\s*\([^)]*\)\s*$/, '');
    const nameKey = normalizeModelKey(cleaned);
    const bySlugFromName = unique(bySlug.get(nameKey));
    if (bySlugFromName) return { slug: bySlugFromName, reason: 'name' };
    const byNameFromName = unique(byName.get(nameKey));
    if (byNameFromName) return { slug: byNameFromName, reason: 'name' };
  }

  return null;
}

function push(map: Map<string, string[]>, key: string, slug: string): void {
  if (!key) return;
  const found = map.get(key);
  if (found) {
    if (!found.includes(slug)) found.push(slug);
  } else {
    map.set(key, [slug]);
  }
}

/** The single slug for this key, or null when absent or ambiguous. */
function unique(slugs: string[] | undefined): string | null {
  return slugs && slugs.length === 1 ? slugs[0] : null;
}

function isAmbiguous(slugs: string[] | undefined): boolean {
  return (slugs?.length ?? 0) > 1;
}
