import type { AuditModule } from '../types';

/**
 * A single deadline policy for the orchestration layer. Reservations protect
 * required evidence/finalization from optional consent and persistence work.
 */
export class AuditRuntimeBudget {
  readonly deadline: number;
  readonly finalizationReserveMs: number;
  readonly pdpReserveMs: number;
  readonly serverPassiveReserveMs: number;

  constructor(startedAt: number, timeoutMs: number, modules: AuditModule[]) {
    this.deadline = startedAt + timeoutMs;
    this.finalizationReserveMs = 2_000;
    this.pdpReserveMs = modules.includes('tracking') ? 8_000 : 0;
    this.serverPassiveReserveMs = modules.includes('server_side') ? 750 : 0;
  }

  remaining(now = Date.now()) { return Math.max(0, this.deadline - now); }

  /** Optional work may not borrow from a selected downstream requirement. */
  optionalAllowance(now = Date.now()) {
    return Math.max(0, this.remaining(now) - this.finalizationReserveMs - this.pdpReserveMs - this.serverPassiveReserveMs);
  }

  requiredAllowance(reserveMs: number, now = Date.now()) {
    return Math.max(0, this.remaining(now) - this.finalizationReserveMs - this.serverPassiveReserveMs - Math.max(0, this.pdpReserveMs - reserveMs));
  }

  canRunOptional(costMs: number, now = Date.now()) { return this.optionalAllowance(now) >= costMs; }
}
