import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { RadeonProvider } from '../providers/radeon.js';
import { isExtensionEnabled } from './extension-state.js';
import type { Scheduler } from '../lib/scheduler.js';

const REFRESH_DELAY_MS = 20_000;

/** One startup-owned observer. Pages and routing only read its cached facts. */
export function startRadeonPressurePolling(scheduler: Scheduler): () => void {
  let stopped = false;
  let cancelNext: (() => void) | undefined;

  const poll = async () => {
    if (stopped) return;
    try {
      const enabled = isExtensionEnabled('quota-capacity-dashboard') || isExtensionEnabled('amd-capacity-routing');
      if (enabled && getDb().prepare("SELECT 1 FROM api_keys WHERE platform = 'radeon' AND id > 0 LIMIT 1").get()) {
        const provider = getProvider('radeon');
        if (!(provider instanceof RadeonProvider)) throw new Error('AMD pressure provider is not registered');
        await provider.fetchModelPressure();
      }
    } catch (error) {
      console.warn('[amd-capacity] Background observation failed:', error instanceof Error ? error.message : 'unknown error');
    } finally {
      // Completion-spaced attempts: a slow response never accumulates timers.
      if (!stopped) cancelNext = scheduler.after(REFRESH_DELAY_MS, poll);
    }
  };

  void poll();
  return () => {
    if (stopped) return;
    stopped = true;
    cancelNext?.();
    cancelNext = undefined;
  };
}
