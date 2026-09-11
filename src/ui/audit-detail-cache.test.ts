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
});
