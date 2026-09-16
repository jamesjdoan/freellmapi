/**
 * A duration in seconds, as a human reads it: "9h 24m", "90s", "—".
 *
 * Shared because two surfaces now answer the same question — the Quota page's
 * reset column and the Keys panel's per-provider header — and two formatters
 * would drift into two vocabularies for one fact.
 *
 * Null and non-positive both render as an em dash rather than "0s": a window
 * with no known reset and a window that has already turned over are both
 * "nothing to wait for", and a bare 0 reads as a countdown that finished
 * moments ago.
 */
export function formatCountdown(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}
