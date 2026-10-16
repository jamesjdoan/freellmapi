import { z } from 'zod';
import { OpenAICompatProvider } from './openai-compat.js';
import type { CapacityFreshness } from '@freellmapi/shared/types.js';

const PRESSURE_URL = 'https://developer.amd.com.cn/radeon/api/tokenfactory/load';
const PRESSURE_REFRESH_MS = 20_000;
const PRESSURE_FRESH_MS = 60_000;
const PressureBody = z.object({
  scope: z.literal('fleet'),
  models: z.record(z.object({
    state: z.enum(['idle', 'busy', 'full']),
    utilization: z.number().finite().min(0).max(100),
  })),
});
type PressureModels = Readonly<Record<string, Readonly<z.infer<typeof PressureBody>['models'][string]>>>;
const NO_PRESSURES: PressureModels = Object.freeze({});

export interface RadeonPressureSnapshot {
  models: PressureModels;
  observedAt: string | null;
  freshness: CapacityFreshness;
}

/** Shared inference and its public fleet-pressure feed use no instance credits. */
export class RadeonProvider extends OpenAICompatProvider {
  private pressureModels: PressureModels = NO_PRESSURES;
  private pressureObservedAt: number | null = null;
  private pressureCompletedAt = Number.NEGATIVE_INFINITY;
  private pressureFailed = false;
  private pressurePending: Promise<RadeonPressureSnapshot> | null = null;
  /** Cached facts only: never block a page or inference request on AMD. */
  getModelPressure(): RadeonPressureSnapshot {
    return this.pressureView();
  }

  constructor() {
    super({
      platform: 'radeon',
      name: 'AMD Radeon Cloud',
      baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
      forceSingleToolCall: true,
      timeoutMs: 600_000,
    });
  }

  /** One public, credential-free fetch per server/window, shared by all rows. */
  async fetchModelPressure(): Promise<RadeonPressureSnapshot> {
    if (this.pressurePending) return this.pressurePending;
    if (Date.now() - this.pressureCompletedAt < PRESSURE_REFRESH_MS) return this.pressureView();
    this.pressurePending = this.refreshModelPressure();
    try {
      return await this.pressurePending;
    } finally {
      this.pressurePending = null;
      this.pressureCompletedAt = Date.now();
    }
  }

  private async refreshModelPressure(): Promise<RadeonPressureSnapshot> {
    try {
      const response = await this.fetchWithTimeout(PRESSURE_URL, { method: 'GET' }, 40_000, { timeoutBounds: 'request' });
      if (!response.ok) throw new Error(`AMD pressure source returned ${response.status}`);
      const body = PressureBody.parse(await response.json());
      for (const pressure of Object.values(body.models)) Object.freeze(pressure);
      this.pressureModels = Object.freeze(body.models);
      this.pressureObservedAt = Date.now();
      this.pressureFailed = false;
    } catch {
      // Collection failure is visible as stale/unknown, never a key-health verdict.
      this.pressureFailed = true;
    }
    return this.pressureView();
  }

  private pressureView(): RadeonPressureSnapshot {
    const freshness: CapacityFreshness = this.pressureObservedAt == null
      ? 'unknown'
      : this.pressureFailed || Date.now() - this.pressureObservedAt >= PRESSURE_FRESH_MS ? 'stale' : 'fresh';
    return {
      models: this.pressureModels,
      observedAt: this.pressureObservedAt == null ? null : new Date(this.pressureObservedAt).toISOString(),
      freshness,
    };
  }
}
