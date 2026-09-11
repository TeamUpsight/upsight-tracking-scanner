import type { StorefrontAudit } from '../types';

/** Session-scoped, passive cache: it does no work until the UI explicitly opens an audit. */
export class AuditDetailCache {
  private readonly entries = new Map<string, StorefrontAudit>();
  private readonly inFlight = new Map<string, Promise<StorefrontAudit>>();

  async load(auditId: string | number, fetchAudit: () => Promise<StorefrontAudit>, force = false) {
    const key = String(auditId);
    if (!force) {
      const cached = this.entries.get(key);
      if (cached) return cached;
    }
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = fetchAudit().then((audit) => {
        this.entries.set(key, audit);
        return audit;
      }).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  invalidate(auditId: string | number) {
    this.entries.delete(String(auditId));
  }
}
