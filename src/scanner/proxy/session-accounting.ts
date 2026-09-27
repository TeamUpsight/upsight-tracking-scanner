/** CDP connection accounting. Each completed connection incurs its own 30-second rounding. */
export class BrowserlessSessionAccounting {
  private active = new Map<number, number>();
  private nextId = 0;
  private durations: number[] = [];
  private count = 0;
  private totalMs = 0;
  private timeUnits = 0;
  private latestMs: number | null = null;

  start(now = Date.now()) {
    const id = ++this.nextId;
    this.active.set(id, now);
    return id;
  }

  finish(id: number, now = Date.now()) {
    const startedAt = this.active.get(id);
    if (startedAt === undefined) return;
    const duration = Math.max(0, Math.min(now - startedAt, 300_000));
    this.count += 1;
    this.totalMs += duration;
    this.timeUnits += Math.ceil(duration / 30_000);
    this.latestMs = duration;
    if (this.durations.length < 32) this.durations.push(duration);
    this.active.delete(id);
  }

  finishAll(now = Date.now()) {
    for (const id of this.active.keys()) this.finish(id, now);
  }

  snapshot() {
    return {
      browserless_session_ms: this.latestMs,
      browserless_session_count: this.count,
      browserless_session_total_ms: this.totalMs,
      browserless_session_durations_ms: [...this.durations],
      browserless_estimated_time_units: this.timeUnits
    };
  }
}
