import { describe, it, expect } from 'vitest';
import { deriveEstimates, fitLine, MIN_CALIBRATION, type EstimateInput } from '../../services/aa-derive.js';

// Derived Coding/Agentic estimates (ADR ARCH-20261030): a straight-line fit
// from a score AA still publishes to the archived target, refused whenever it
// would not carry information, and choosing per model the input that misses
// least on models it has not seen.

/** n points on y = 2x + 5, with a deterministic wobble of ±noise. */
const line = (n: number, noise: number, from = 10): [number, number][] =>
  Array.from({ length: n }, (_, i) => [from + i, 2 * (from + i) + 5 + (i % 2 === 0 ? noise : -noise)] as [number, number]);

describe('fitLine', () => {
  it('recovers the line and reports a leave-one-out error near the noise', () => {
    const fit = fitLine(line(40, 1))!;
    expect(fit.b).toBeCloseTo(2, 1);
    expect(fit.a).toBeCloseTo(5, 0);
    expect(fit.error).toBeGreaterThan(0.9);
    expect(fit.error).toBeLessThan(1.3);
    expect([fit.xMin, fit.xMax]).toEqual([10, 49]);
  });

  it('refuses too few models, no spread, and a fit no better than the mean', () => {
    expect(fitLine(line(MIN_CALIBRATION - 1, 1))).toBeNull();
    expect(fitLine(Array.from({ length: 30 }, (_, i) => [5, i] as [number, number]))).toBeNull();
    // y alternates with no relation to x: the line predicts nothing.
    expect(fitLine(Array.from({ length: 30 }, (_, i) => [i, i % 2 === 0 ? 10 : 50] as [number, number]))).toBeNull();
  });
});

describe('deriveEstimates', () => {
  const targets = new Map(line(30, 1).map(([x, y]) => [`m${x}`, y]));
  const noisy: EstimateInput = {
    basis: { kind: 'intelligence', version: 'v5.0' },
    values: new Map([...targets.keys()].map((slug, i) => [slug, Number(slug.slice(1)) + (i % 3) * 4])),
  };
  const tight: EstimateInput = {
    basis: { kind: 'capability', capability: 'strategyOps' },
    values: new Map([...targets.keys()].map(slug => [slug, Number(slug.slice(1))])),
  };

  it('uses the input that misses least, per model, and only for models without a value', () => {
    noisy.values.set('new-a', 20);
    tight.values.set('new-a', 20);
    noisy.values.set('new-b', 20); // only the noisier input known
    const out = deriveEstimates(['m15', 'new-a', 'new-b', 'new-c'], targets, [noisy, tight], 'v4.3');

    expect(out.has('m15')).toBe(false); // has a real value
    expect(out.has('new-c')).toBe(false); // no input at all
    const a = out.get('new-a')!;
    expect(a.basis).toEqual({ kind: 'capability', capability: 'strategyOps' });
    expect(a.value).toBeCloseTo(45, 0);
    expect(a.targetVersion).toBe('v4.3');
    const b = out.get('new-b')!;
    expect(b.basis).toEqual({ kind: 'intelligence', version: 'v5.0' });
    expect(b.error).toBeGreaterThan(a.error);
  });

  it('flags a model outside the fitted range and clamps to the index scale', () => {
    tight.values.set('frontier', 90);
    const est = deriveEstimates(['frontier'], targets, [tight], 'v4.3').get('frontier')!;
    expect(est.extrapolated).toBe(true);
    expect(est.value).toBe(100);
  });
});
