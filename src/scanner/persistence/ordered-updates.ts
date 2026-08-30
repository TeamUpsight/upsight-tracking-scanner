export class OrderedAuditUpdates<T> {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private updateFailure: unknown = null;

  constructor(private readonly write: (update: T) => Promise<void>) {}

  enqueue(update: T) {
    if (this.closed) return false;
    this.tail = this.tail
      .then(() => this.write(update))
      .catch((error) => {
        this.updateFailure = error;
      });
    return true;
  }

  get failure() {
    return this.updateFailure;
  }

  async finalize(update: T) {
    this.closed = true;
    await this.tail;
    await this.write(update);
  }
}
