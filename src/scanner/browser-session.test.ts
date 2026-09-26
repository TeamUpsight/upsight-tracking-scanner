import { describe, expect, it } from 'vitest';
import { closeWithDeadline } from './browser-session';

describe('browser resource cleanup', () => {
  it('does not strand finalization when a remote close never settles', async () => {
    const started = Date.now();
    expect(await closeWithDeadline(() => new Promise(() => {}), 20)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('reports a completed close', async () => {
    expect(await closeWithDeadline(async () => {}, 20)).toBe(true);
  });
});
