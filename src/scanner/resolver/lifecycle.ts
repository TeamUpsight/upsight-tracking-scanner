export class FinalizeOnce {
  private finalized = false;

  get isFinalized() {
    return this.finalized;
  }

  async run(action: () => Promise<void>) {
    if (this.finalized) return false;
    this.finalized = true;
    await action();
    return true;
  }
}
