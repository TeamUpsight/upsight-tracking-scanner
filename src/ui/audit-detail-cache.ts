import type { StorefrontAudit } from '../types';

/** Session-scoped, passive cache: it does no work until the UI explicitly opens an audit. */
export class AuditDetailCache {
  private readonly entries = new Map<string, StorefrontAudit>();
  private readonly inFlight = new Map<string, { promise: Promise<StorefrontAudit>; force: boolean }>();

  async load(auditId: string | number, fetchAudit: () => Promise<StorefrontAudit>, force = false) {
    const key = String(auditId);
    if (!force) {
      const cached = this.entries.get(key);
      if (cached) return cached;
    }
    let pending = this.inFlight.get(key);
    // A terminal lifecycle update must fetch after any already-running active
    // detail request. Later terminal polls share that one forced refresh.
    if (!pending || (force && !pending.force)) {
      const previous = pending?.promise;
      const entry = {
        force,
        promise: (previous ? previous.catch(() => undefined).then(fetchAudit) : fetchAudit()).then((audit) => {
        this.entries.set(key, audit);
        return audit;
      })
      };
      entry.promise.finally(() => {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      }).catch(() => undefined);
      this.inFlight.set(key, entry);
      pending = entry;
    }
    return pending.promise;
  }

  invalidate(auditId: string | number) {
    this.entries.delete(String(auditId));
  }
}
