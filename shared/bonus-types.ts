// Temporary bonus grants (ADR ARCH-20261016-xkiro-allowance-and-temporary-bonus).
//
// A grant is extra provider capacity on top of a normal daily allowance. It is
// spent only through an operator-opened spending window, and only after the
// normal allowance for the current day is used up. Accounting is local: the
// provider does not report bonus consumption, so every figure here is what this
// install attributed, not what the provider measured.
//
// Only countable metrics are supported. Credits and money need the actual cost
// of each request, which this install does not meter, so they are refused
// rather than tracked as zero.

export type BonusMetric = 'requests' | 'total_tokens';
export type BonusPoolStatus = 'active' | 'expired' | 'exhausted';
export type BonusAllowanceStatus = 'active' | 'expired' | 'exhausted' | 'cancelled';

export interface BonusNormalView {
  /** Effective normal allowance: the provider's reported limit when one is
   *  observed for this window, otherwise the operator-entered limit. */
  limit: number;
  limitSource: 'provider' | 'operator';
  used: number;
  remaining: number;
  resetAt: string;
  timezone: string;
}

export interface BonusAllowanceView {
  id: number;
  quantity: number;
  used: number;
  /** Excess held by requests still in flight. */
  reserved: number;
  remaining: number;
  startsAt: string;
  expiresAt: string;
  status: BonusAllowanceStatus;
}

export interface BonusGrantView {
  id: number;
  label: string;
  platform: string;
  keyIds: number[];
  metric: BonusMetric;
  quantity: number;
  used: number;
  reserved: number;
  remaining: number;
  startsAt: string;
  expiresAt: string;
  status: BonusPoolStatus;
  normal: BonusNormalView;
  /** The most recent spending window, whatever its state. */
  allowance: BonusAllowanceView | null;
  accounting: 'local';
}

export interface BonusGrantListResponse {
  grants: BonusGrantView[];
  observedAt: string;
}

export interface BonusGrantResponse {
  grant: BonusGrantView;
}

export interface CreateBonusGrantInput {
  platform: string;
  keyIds: number[];
  metric: BonusMetric;
  quantity: number;
  durationHours: number;
  /** Normal per-day allowance the grant sits on top of. */
  normalLimit: number;
  /** IANA zone whose midnight resets the normal allowance. */
  timezone: string;
  label?: string;
}

export interface UpdateBonusGrantInput {
  label?: string;
  quantity?: number;
  /** Measured from the grant's original start, never from now. */
  durationHours?: number;
  normalLimit?: number;
}

export interface CreateBonusAllowanceInput {
  quantity: number;
  durationHours: number;
}
