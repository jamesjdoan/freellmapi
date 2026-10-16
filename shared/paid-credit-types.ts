// Paid credit windows: an operator-authorised, bounded way for automatic
// routing to spend provider credit on paid models it would otherwise never
// pick (the paid-balance guard). Types only; see shared/extension-registry.ts
// for why this package must never export a runtime value.
//
// Spend is MEASURED, never estimated: it is the rise in the provider's own
// reported usage since the window opened. Only providers that report a credit
// balance can hold a window.

export type PaidCreditWindowStatus = 'active' | 'expired' | 'exhausted' | 'cancelled';

export interface PaidCreditBalanceView {
  /** Cumulative usage the provider reports, in `unit`. */
  used: number;
  remaining: number;
  limit: number;
  /** Denomination of every figure, e.g. 'cents'. */
  unit: string;
  observedAt: string;
}

export interface PaidCreditWindowView {
  id: number;
  quantity: number;
  /** Measured: reported usage now minus reported usage when the window opened. */
  spent: number;
  remaining: number;
  unit: string;
  startsAt: string;
  expiresAt: string;
  status: PaidCreditWindowStatus;
  /** A paid attempt finished after the latest balance reading; the next one
   *  waits until a fresh reading has measured it. */
  awaitingReading: boolean;
}

export interface PaidCreditKeyView {
  keyId: number;
  keyLabel: string | null;
  platform: string;
  balance: PaidCreditBalanceView | null;
  /** The most recent window for this key, whatever its state. */
  window: PaidCreditWindowView | null;
  selectedModels: number;
}

export interface PaidCreditOverview {
  keys: PaidCreditKeyView[];
  /** Platforms whose paid models can be routed through a window. */
  platforms: string[];
  /** False while the paid-balance guard is off: paid models then route
   *  without any window, and windows are not consulted. */
  guardActive: boolean;
}

export interface PaidModelOption {
  modelId: string;
  name: string;
  contextLength: number | null;
  /** USD per million tokens, as the provider lists them. */
  promptPerM: number;
  completionPerM: number;
  supportsTools: boolean;
  supportsVision: boolean;
  selected: boolean;
}

export interface PaidModelListResponse {
  platform: string;
  models: PaidModelOption[];
}

export interface OpenPaidCreditWindowInput {
  platform: string;
  keyId: number;
  /** In the balance's unit (cents for OpenRouter). */
  quantity: number;
  durationHours: number;
  /** Must equal the paid-spend confirmation phrase. */
  confirmation: string;
}

export interface SetPaidModelInput {
  platform: string;
  modelId: string;
  selected: boolean;
}
