import { describe, expect, it } from 'vitest';
import { ConsentEvidenceLedger, normalizePrivacySafeDescriptor } from './evidence-ledger';

describe('ConsentEvidenceLedger', () => {
  it('preserves append order and retrieves observations by the supported dimensions', () => {
    const ledger = new ConsentEvidenceLedger(3);
    ledger.append({
      phase: 'baseline', source: 'page', family: 'dom', kind: 'presence', specificity: 'generic', stability: 'stable', provenance: 'dom_snapshot',
      timestamp: 100, provider_candidate: 'OneTrust', descriptor: { exists: true }
    });
    ledger.append({
      phase: 'detected', source: 'network', family: 'asset', kind: 'network_endpoint', specificity: 'provider_specific', stability: 'stable', provenance: 'network_metadata',
      timestamp: 200, provider_candidate: 'OneTrust', descriptor: { url: 'https://cdn.example.test/consent/sdk.js?account=secret' }
    });
    ledger.append({
      phase: 'post_action', source: 'browser_context', family: 'storage', kind: 'storage_key', specificity: 'generic', stability: 'unknown', provenance: 'browser_api',
      timestamp: 300, descriptor: { key_name: 'consent_state', value: 'rejected' }
    });

    expect(ledger.timeline().map((observation) => observation.sequence)).toEqual([1, 2, 3]);
    expect(ledger.byPhase('detected')).toHaveLength(1);
    expect(ledger.byFamily('storage')).toHaveLength(1);
    expect(ledger.byProviderCandidate('OneTrust')).toHaveLength(2);
    expect(ledger.byTimeRange(150, 300).map((observation) => observation.timestamp)).toEqual([200, 300]);
    expect(ledger.append({
      phase: 'post_reload', source: 'page', family: 'dom', kind: 'visibility', specificity: 'generic', stability: 'unknown', provenance: 'dom_snapshot'
    })).toBeNull();
    expect(ledger.truncated).toBe(true);
  });

  it('stores bounded privacy-safe descriptors rather than raw browser values', () => {
    const rawCookie = 'OptanonConsent=customer%40example.test&groups=C0001';
    const rawTc = 'CPXxRfAPXxRfAAHABBENB-CgAAAAAAAAAAYgAAAAAAAA';
    const rawHtml = '<html><body>customer@example.test</body></html>';
    const rawDescriptor = {
      key_name: 'OptanonConsent',
      value: rawCookie,
      html: rawHtml,
      tc_string: rawTc,
      url: `https://cmp.example.test/consent/customer-id?tc=${rawTc}&gpp=DBABLA~BUoAAABA.QA`,
      cookie_attributes: { domain: '.example.test', secure: true, http_only: true, same_site: 'Lax', partitioned: false },
      parsed_shape: { version: 2, purposes: ['analytics'], unallowlisted_raw_value: rawCookie }
    };
    const descriptor = normalizePrivacySafeDescriptor(rawDescriptor);
    const ledger = new ConsentEvidenceLedger();
    ledger.append({
      phase: 'baseline', source: 'browser_context', family: 'storage', kind: 'storage_key', specificity: 'framework_specific', stability: 'stable', provenance: 'browser_api',
      descriptor: rawDescriptor
    });
    const serialized = JSON.stringify(ledger.timeline());

    expect(descriptor).toEqual({
      key_name: 'OptanonConsent',
      value_length: rawCookie.length,
      hostname: 'cmp.example.test',
      path_pattern: '/consent/:segment',
      parameter_presence: ['gpp', 'tc'],
      cookie_attributes: { domain: 'example.test', secure: true, http_only: true, same_site: 'lax', partitioned: false },
      parsed_shape: { version: 'number', purposes: 'array' }
    });
    expect(serialized).not.toContain(rawCookie);
    expect(serialized).not.toContain(rawTc);
    expect(serialized).not.toContain(rawHtml);
    expect(serialized).not.toContain('customer@example.test');
  });
});
