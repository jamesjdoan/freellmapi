import type { CapabilityMetric } from './analysis-fetch.js';

// Estimating a Coding or Agentic score AA no longer publishes, from a score it
// does (ADR ARCH-20261030, "Derived estimates").
//
// Since 2026-10-29 AA publishes neither index, so the archive holds them only
// for models scored before then. For any other model this fits a straight
// line from one published score to the archived target, over the models that
// have both, and reads the estimate off the line. The inputs it can fit from
// are intelligence (the pinned version, and the current version when they
// differ) and each capability index.
//
// Per model it uses the input with the smallest leave-one-out error, so the
// choice between the intelligence and capability-index routes is measured
// every time, not fixed in advance. The fit is redone on every read, so a
// refresh or a scoring-version switch refits it automatically.
//
// It is an estimate, and it is labelled one everywhere. It never counts toward
// a chain minimum unless that chain accepts estimates.

export type EstimateBasis =
  | { kind: 'intelligence'; version: string }
  | { kind: 'capability'; capability: CapabilityMetric };

export interface AaEstimate {
  value: number;
  basis: EstimateBasis;
  /** The input's own value for this model. */
  basisValue: number;
  /** Models the line was fitted on. */
  n: number;
  /** Leave-one-out RMS error in index points: the typical miss on a model
   *  the fit has not seen. */
  error: number;
  r: number;
  /** The input lies outside the range the line was fitted on. */
  extrapolated: boolean;
  /** Index version of the archived values the estimate is on the scale of. */
  targetVersion: string | null;
}

/** Fewer calibration models than this and the error itself is too noisy to
 *  report, so no estimate is made. */
export const MIN_CALIBRATION = 20;

export interface LineFit {
  a: number;
  b: number;
  n: number;
  r: number;
  error: number;
  xMin: number;
  xMax: number;
}

/**
 * Least-squares line y = a + b·x, with its leave-one-out RMS error.
 *
 * Returns null when there are too few points or no spread in x. It also
 * returns null when the line predicts no better than the mean of y: such a
 * line adds a number without adding information.
 */
export function fitLine(points: readonly (readonly [number, number])[]): LineFit | null {
  const n = points.length;
  if (n < MIN_CALIBRATION) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxx = 0, sxy = 0, syy = 0, xMin = Infinity, xMax = -Infinity;
  for (const [x, y] of points) {
    sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2;
    xMin = Math.min(xMin, x); xMax = Math.max(xMax, x);
  }
  if (sxx === 0 || syy === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  // Leave-one-out residual of a least-squares line, without refitting n times:
  // e_i / (1 - h_i), where h_i is the point's leverage.
  let press = 0;
  for (const [x, y] of points) {
    const h = 1 / n + (x - mx) ** 2 / sxx;
    press += ((y - (a + b * x)) / (1 - h)) ** 2;
  }
  const error = Math.sqrt(press / n);
  if (error >= Math.sqrt(syy / n)) return null;
  return { a, b, n, r: sxy / Math.sqrt(sxx * syy), error, xMin, xMax };
}

export interface EstimateInput {
  basis: EstimateBasis;
  /** This input's value per slug. */
  values: Map<string, number>;
}

/**
 * Estimates for every slug in `slugs` that has no target value, using the best
 * input that slug has. `targets` holds the known values to calibrate on.
 */
export function deriveEstimates(
  slugs: Iterable<string>,
  targets: Map<string, number>,
  inputs: readonly EstimateInput[],
  targetVersion: string | null,
): Map<string, AaEstimate> {
  const fits = inputs.flatMap(input => {
    const points: [number, number][] = [];
    for (const [slug, y] of targets) {
      const x = input.values.get(slug);
      if (x != null) points.push([x, y]);
    }
    const fit = fitLine(points);
    return fit ? [{ input, fit }] : [];
  });
  const out = new Map<string, AaEstimate>();
  if (fits.length === 0) return out;
  for (const slug of slugs) {
    if (targets.has(slug)) continue;
    let best: { input: EstimateInput; fit: LineFit; x: number } | null = null;
    for (const { input, fit } of fits) {
      const x = input.values.get(slug);
      if (x != null && (best == null || fit.error < best.fit.error)) best = { input, fit, x };
    }
    if (!best) continue;
    const { fit, x } = best;
    out.set(slug, {
      value: Math.round(Math.min(100, Math.max(0, fit.a + fit.b * x)) * 10) / 10,
      basis: best.input.basis,
      basisValue: x,
      n: fit.n,
      error: Math.round(fit.error * 10) / 10,
      r: Math.round(fit.r * 100) / 100,
      extrapolated: x < fit.xMin || x > fit.xMax,
      targetVersion,
    });
  }
  return out;
}
