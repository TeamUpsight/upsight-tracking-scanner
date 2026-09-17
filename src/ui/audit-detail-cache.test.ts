import { describe, expect, it, vi } from 'vitest';
import { AuditDetailCache } from './audit-detail-cache';
import type { StorefrontAudit } from '../types';

const detail = { audit_id: '42', domain: 'example.com' } as StorefrontAudit;

describe('AuditDetailCache', () => {
  it('does not fetch until an audit is explicitly opened, then deduplicates and caches that detail', async () => {
    const cache = new AuditDetailCache();
    const fetchAudit = vi.fn(async () => detail);

    expect(fetchAudit).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      cache.load('42', fetchAudit),
      cache.load('42', fetchAudit)
    ]);
    expect(fetchAudit).toHaveBeenCalledTimes(1);
    expect(first).toBe(detail);
    expect(second).toBe(detail);

    await cache.load('42', fetchAudit);
    expect(fetchAudit).toHaveBeenCalledTimes(1);

    cache.invalidate('42');
    await cache.load('42', fetchAudit);
    expect(fetchAudit).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent forced terminal-detail refreshes after invalidation', async () => {
    const cache = new AuditDetailCache();
    const fetchAudit = vi.fn(async () => detail);
    await cache.load('42', fetchAudit);
    cache.invalidate('42');

    await Promise.all([
      cache.load('42', fetchAudit, true),
      cache.load('42', fetchAudit, true)
    ]);

    expect(fetchAudit).toHaveBeenCalledTimes(2);
  });

  it('fetches terminal detail after an in-flight active detail response', async () => {
    const cache = new AuditDetailCache();
    let resolveActive: ((audit: StorefrontAudit) => void) | undefined;
    const fetchAudit = vi.fn()
      .mockImplementationOnce(() => new Promise<StorefrontAudit>((resolve) => { resolveActive = resolve; }))
      .mockResolvedValue(detail);

    const active = cache.load('42', fetchAudit);
    const terminal = cache.load('42', fetchAudit, true);
    resolveActive?.(detail);
    await Promise.all([active, terminal]);

    expect(fetchAudit).toHaveBeenCalledTimes(2);
  });
});
