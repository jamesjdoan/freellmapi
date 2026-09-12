import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import {
  recordQuotaProbe,
  listQuotaProbes,
  deriveFindingAndRecommendation,
  type QuotaProbeRun,
} from '../../services/quota-probe-log.js';

// The schema comes from the migration, never from a copy of it pasted in here:
// a hand-written CREATE TABLE tests a table that does not ship.
function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  getDb().prepare('DELETE FROM quota_probe_run').run();
}

const probe = (over: Partial<Omit<QuotaProbeRun, 'id' | 'ran_at'>> = {}): Omit<QuotaProbeRun, 'id' | 'ran_at'> => ({
  platform: 'google',
  model_id: 'gemini-3.7-flash',
  method: 'burst',
  concurrency: 40,
  served: 6,
  refused: 34,
  status_codes_json: '{"200":6,"429":34}',
  measured_rpm: 5,
  measured_rpd: null,
  catalogue_rpm: 10,
  catalogue_rpd: null,
  retry_hint_ms: 38_000,
  quota_bucket: 'gemini-3.7-flash',
  verbatim: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 5',
  notes: null,
  ...over,
});

describe('quota probe records', () => {
  beforeEach(reset);

  it('stores the provider text whole, however long it is', () => {
    // The reason this table exists. `requests.error` caps at 240 characters and
    // Google names its limit past that, so the one channel that states a number
    // was being cut before storage.
    const verbatim = `Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, model: gemini-3.7-flash. ${'detail '.repeat(300)}`;
    expect(verbatim.length).toBeGreaterThan(1024);

    recordQuotaProbe(probe({ verbatim }));

    expect(listQuotaProbes()[0]!.verbatim).toBe(verbatim);
  });

  it('parses the status breakdown back into counts a caller can read', () => {
    recordQuotaProbe(probe());
    expect(listQuotaProbes()[0]!.statusCodes).toEqual({ '200': 6, '429': 34 });
  });

  it('returns newest first, and honours platform and limit', () => {
    recordQuotaProbe(probe({ model_id: 'first' }));
    recordQuotaProbe(probe({ model_id: 'second' }));
    recordQuotaProbe(probe({ platform: 'groq', model_id: 'other' }));

    expect(listQuotaProbes().map(p => p.modelId)).toEqual(['other', 'second', 'first']);
    expect(listQuotaProbes({ platform: 'google' }).map(p => p.modelId)).toEqual(['second', 'first']);
    expect(listQuotaProbes({ limit: 1 }).map(p => p.modelId)).toEqual(['other']);
    // A model id on its own: the same id is probed on several platforms, and the
    // model's own page wants every one of them.
    recordQuotaProbe(probe({ platform: 'openrouter', model_id: 'second' }));
    expect(listQuotaProbes({ modelId: 'second' }).map(p => p.platform)).toEqual(['openrouter', 'google']);
  });

  it('stops recommending a correction once the catalogue has been corrected', () => {
    // The claim as it stood is history and stays readable. The recommendation
    // is outstanding work, so it has to follow the catalogue: a panel still
    // saying "correct this" after someone did reads as a broken feature.
    const db = getDb();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                                    size_label, context_window, rpm_limit, enabled, supports_tools, supports_vision)
                VALUES ('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', 1, 1, 'Frontier', 1048576, 5, 1, 1, 1)`).run();
    recordQuotaProbe(probe({ catalogue_rpm: 10, measured_rpm: 5 }));

    const row = listQuotaProbes()[0]!;
    expect([row.catalogueRpm, row.currentRpm]).toEqual([10, 5]);
    expect(row.recommendation).toBeNull();
  });

  it('reads the measured limit, not the shipped one, when both describe the model', () => {
    // The catalogue ships 20/day and an operator policy records the measured
    // 500/day. Taking the smaller would report a corrected limit as still
    // wrong forever; the model page showed exactly that.
    const db = getDb();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                                    size_label, context_window, rpm_limit, rpd_limit, enabled, supports_tools, supports_vision)
                VALUES ('google', 'gemini-3.5-flash-lite', 'Flash-Lite', 1, 1, 'Large', 1048576, 15, 20, 1, 1, 1)`).run();
    upsertQuotaPolicy({
      platform: 'google', modelId: 'gemini-3.5-flash-lite', endpointScope: null, scope: 'model',
      metric: 'requests', limit: 500, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    recordQuotaProbe(probe({ model_id: 'gemini-3.5-flash-lite', measured_rpm: 15, catalogue_rpm: 15, measured_rpd: 500 }));

    const row = listQuotaProbes({ modelId: 'gemini-3.5-flash-lite' })[0]!;
    expect(row.currentRpd).toBe(500);
    expect(row.recommendation).toBeNull();
  });

  it('still recommends a correction while the catalogue disagrees', () => {
    const db = getDb();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                                    size_label, context_window, rpm_limit, enabled, supports_tools, supports_vision)
                VALUES ('google', 'gemini-3.7-flash', 'Gemini 3.7 Flash', 1, 1, 'Frontier', 1048576, 10, 1, 1, 1)`).run();
    recordQuotaProbe(probe({ catalogue_rpm: 10, measured_rpm: 5 }));

    const row = listQuotaProbes()[0]!;
    expect(row.recommendation).toContain('10/min');
    expect(row.recommendation).toContain('5/min');
  });
});

describe('what a probe means', () => {
  const derive = (over: Partial<QuotaProbeRun> = {}) =>
    deriveFindingAndRecommendation({ ...probe(), id: 1, ran_at: '2026-09-11 09:00:00', ...over } as QuotaProbeRun);

  it('says nothing when the catalogue is already right', () => {
    expect(derive({ measured_rpm: 10, catalogue_rpm: 10 }).recommendation).toBeNull();
  });

  it('names both numbers when the catalogue overstates the allowance', () => {
    const { recommendation } = derive({ measured_rpm: 5, catalogue_rpm: 10 });
    expect(recommendation).toContain('10/min');
    expect(recommendation).toContain('5/min');
    expect(recommendation).toContain('paces too fast');
  });

  it('flags unspent capacity when the catalogue understates it', () => {
    expect(derive({ measured_rpm: 30, catalogue_rpm: 15 }).recommendation).toContain('unspent');
  });

  it('compares the daily allowance too, not only the per-minute one', () => {
    // Gemma measured 1000/day against a catalogue that named none of it; a
    // per-minute-only comparison would have reported nothing to fix.
    const { recommendation } = derive({
      measured_rpm: 30, catalogue_rpm: 30, measured_rpd: 1000, catalogue_rpd: 20,
    });
    expect(recommendation).toContain('1000/day');
    expect(recommendation).toContain('20/day');
  });

  it('recommends removal when the provider says the model is gone and it still routes', () => {
    const { recommendation } = derive({
      served: 0, refused: 40, status_codes_json: '{"404":40}', measured_rpm: null, routed: true,
    });
    expect(recommendation).toContain('Delisted upstream');
  });

  it('stops instructing removal once the route is already switched off', () => {
    // The finding stays — it is the record of why the model went. The
    // instruction goes, because there is nothing left to do and a panel that
    // repeats undoable work teaches the reader to ignore it.
    const { finding, recommendation } = derive({
      served: 0, refused: 40, status_codes_json: '{"404":40}', measured_rpm: null, routed: false,
    });
    expect(finding).toContain('no longer serves this model');
    expect(recommendation).toBeNull();
  });

  it('does not call an exhausted model dead', () => {
    // A model at its daily ceiling refuses everything, exactly like a delisted
    // one. Recommending removal there would delete a route that works again
    // after the reset — gemini-3.8-flash served 2 of 40 on the day it was
    // measured and would have served 0 of 40 minutes later.
    const { recommendation } = derive({
      served: 0, refused: 40, status_codes_json: '{"429":40}', measured_rpm: 5, catalogue_rpm: 5,
    });
    expect(recommendation).toBeNull();
  });

  it('reports a ceiling above the burst when nothing refused', () => {
    const { finding } = derive({
      served: 40, refused: 0, status_codes_json: '{"200":40}', measured_rpm: null, catalogue_rpm: 10,
    });
    expect(finding).toContain('No limit reached');
  });

  it('words an observed ceiling without a sent/refused split it never had', () => {
    // The daily caps were read off traffic that stopped at 20, not provoked.
    // Printing "0 refused" there would claim nothing was ever refused, when a
    // refusal is how the ceiling became visible.
    const { finding } = derive({
      method: 'observed', concurrency: null, served: 20, refused: 0,
      measured_rpm: null, measured_rpd: 20, status_codes_json: '{}',
    });
    expect(finding).toContain('20/day');
    expect(finding).not.toContain('refused');
  });

  it('survives a corrupt status breakdown', () => {
    expect(derive({ status_codes_json: 'not json' }).finding).toContain('measured');
  });
});
