import { describe, expect, it } from 'vitest';
import { isPublicAddress, isPublicHostname, isPublicWebUrl, resolvesOnlyToPublicAddresses } from './url-safety';
import { isEvidenceBackedExternalRedirect, normalizeAuditDomain } from './audit-runner';

describe('scanner URL safety', () => {
  it('rejects internal, metadata, non-web, and credential-bearing destinations', () => {
    for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', 'service.internal', 'host.local']) {
      expect(isPublicHostname(host)).toBe(false);
      expect(normalizeAuditDomain(host)).toBeNull();
    }
    expect(isPublicWebUrl('file:///etc/passwd')).toBe(false);
    expect(isPublicWebUrl('data:text/html,hi')).toBe(false);
    expect(isPublicWebUrl('javascript:alert(1)')).toBe(false);
    expect(normalizeAuditDomain('ftp://store.example')).toBeNull();
    expect(isPublicWebUrl('https://user:pass@store.example')).toBe(false);
    expect(isPublicWebUrl('https://store.example/product')).toBe(true);
    expect(normalizeAuditDomain('HTTPS://WWW.Store.Example/a')).toBe('www.store.example');
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('::1')).toBe(false);
  });

  it('rejects DNS rebinding answers with any private address and DNS failure', async () => {
    const lookupPrivate = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.2', family: 4 }];
    const lookupPublic = async () => [{ address: '8.8.8.8', family: 4 }];
    const lookupFailure = async () => { throw new Error('DNS unavailable'); };
    expect(await resolvesOnlyToPublicAddresses('store.example', lookupPrivate as never)).toBe(false);
    expect(await resolvesOnlyToPublicAddresses('store.example', lookupPublic as never)).toBe(true);
    expect(await resolvesOnlyToPublicAddresses('store.example', lookupFailure as never)).toBe(false);
  });

  it('does not certify a redirect chain to an internal host', () => {
    expect(isEvidenceBackedExternalRedirect('store.example', 'https://169.254.169.254/', 200, [
      { status: 302, host: 'store.example', path: '/' },
      { status: 200, host: '169.254.169.254', path: '/' }
    ])).toBe(false);
  });
});
