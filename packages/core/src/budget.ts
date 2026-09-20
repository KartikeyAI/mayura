import { MayuraError, assertPositiveInteger } from './errors.js';

export interface Reservation {
  /** Settle only confirmed cost. Unknown cost deliberately retains the complete reservation. */
  settle(actualMicros: number): void;
}

/** Shared synchronous ledger; reserve before awaits so concurrent children cannot overspend admission. */
export class Budget {
  private reserved = 0;
  private spent = 0n;
  private admissionBlocked = false;
  private calls = 0;
  constructor(readonly maxCostMicros: number, readonly maxCalls: number) {
    if (!Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0) throw new MayuraError('INVALID_CONFIG', 'maxCostMicros must be a non-negative safe integer.');
    assertPositiveInteger(maxCalls, 'maxCalls');
  }
  reserve(maxMicros: number): Reservation {
    if (!Number.isSafeInteger(maxMicros) || maxMicros < 0) throw new MayuraError('INVALID_CONFIG', 'A non-negative safe-integer cost bound is required.');
    if (this.admissionBlocked || this.calls >= this.maxCalls || BigInt(maxMicros) > BigInt(this.maxCostMicros) - this.spent - BigInt(this.reserved)) {
      throw new MayuraError('BUDGET_EXCEEDED', 'Execution budget exhausted; no new call was dispatched.');
    }
    this.calls++;
    this.reserved += maxMicros;
    let settled = false;
    return {
      settle: (actualMicros: number): void => {
        if (settled) throw new MayuraError('CONFLICT', 'Reservation is already settled.');
        if (!Number.isSafeInteger(actualMicros) || actualMicros < 0) {
          throw new MayuraError('BUDGET_EXCEEDED', 'Reported cost is invalid; reservation retained.');
        }
        settled = true;
        this.reserved -= maxMicros;
        this.spent += BigInt(actualMicros);
        if (actualMicros > maxMicros) {
          this.admissionBlocked = true;
          throw new MayuraError('BUDGET_EXCEEDED', 'Reported cost exceeded its bound; full actual usage recorded.');
        }
      },
    };
  }
  /** Very large provider overruns use an exact decimal string instead of a lossy JSON number. */
  snapshot(): Readonly<{ spentMicros: number | string; reservedMicros: number; calls: number }> {
    const spentMicros = this.spent <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(this.spent) : this.spent.toString();
    return Object.freeze({ spentMicros, reservedMicros: this.reserved, calls: this.calls });
  }
}
