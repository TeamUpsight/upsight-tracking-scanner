import { describe, expect, it } from 'vitest';
import { buildUnknownCmpFingerprint, normalizeStableDomHint } from './unknown-cmp-fingerprint';

function input(overrides: Record<string, unknown> = {}) {
  return {
    mechanism_score: 85,
    provider_attribution: 'unknown_candidate' as const,
    geo: 'EU' as const,
    stable_dom_hints: ['#cookie-banner', '[data-consent="visible"]', '.random-a4f9c2d1'],
    script_hosts: ['https://cdn.custom-cmp.example/sdk.js?session=private', 'static.example.net'],
    consent_network_hosts: ['https://api.custom-cmp.example/v1/choice?token=private'],
    storage_key_names: ['custom-consent', 'consent-user-123456789'],
    candidate_global_names: ['window.CustomConsent', '__cmp_abcdef0123456789'],
    available_actions: [
      { action: 'accept_all' as const, availability: 'direct' as const, category: null, evidence: [], reason_codes: [] },
      { action: 'reject_all' as const, availability: 'direct' as const, category: null, evidence: [], reason_codes: [] }
    ],
    tcf: { presence: 'present' as const, readiness: 'ready' as const, event_status: 'tcloaded' as const },
    gpp: { presence: 'absent' as const },
    provider_candidate_evidence: ['dom', 'dom', 'network'] as const,
    failure_reason_codes: ['CMP_PROVIDER_UNKNOWN', 'not-a-code'],
    ...overrides
  };
}

describe('unknown CMP fingerprint telemetry', () => {
  it('produces a stable fingerprint for the same CMP variant', () => {
    const first = buildUnknownCmpFingerprint(input());
    const second = buildUnknownCmpFingerprint(input({ geo: 'UK', failure_reason_codes: ['ACTION_INCONCLUSIVE'] }));
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first).toMatchObject({ geo: 'EU', provider_candidate_evidence: { dom: 2, network: 1 }, failure_reason_codes: ['CMP_PROVIDER_UNKNOWN'] });
  });

  it('drops volatile class changes while retaining stable DOM structure', () => {
    const first = buildUnknownCmpFingerprint(input({ stable_dom_hints: ['#cookie-banner', '.generated-a1b2c3d4'] }));
    const second = buildUnknownCmpFingerprint(input({ stable_dom_hints: ['.generated-f9e8d7c6', '#cookie-banner'] }));
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(normalizeStableDomHint('.generated-a1b2c3d4')).toBeNull();
  });

  it('produces a different fingerprint for a different unknown CMP shape', () => {
    const first = buildUnknownCmpFingerprint(input());
    const second = buildUnknownCmpFingerprint(input({ script_hosts: ['cmp.other.example'], stable_dom_hints: ['#privacy-panel'] }));
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it('does not retain raw sensitive values, query strings, or consent ids', () => {
    const telemetry = buildUnknownCmpFingerprint(input());
    const serialized = JSON.stringify(telemetry);
    expect(serialized).not.toContain('session=private');
    expect(serialized).not.toContain('token=private');
    expect(serialized).not.toContain('123456789');
    expect(serialized).not.toContain('abcdef0123456789');
    expect(serialized).not.toContain('visible');
  });

  it('does not capture attribution-ready or low-confidence candidates', () => {
    expect(buildUnknownCmpFingerprint(input({ provider_attribution: 'identified' }))).toBeNull();
    expect(buildUnknownCmpFingerprint(input({ mechanism_score: 69 }))).toBeNull();
  });
});
