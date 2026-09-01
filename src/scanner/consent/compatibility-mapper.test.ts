import { describe, expect, it } from 'vitest';
import type { FinalConsentAuditResult, MechanismResult } from './domain-types';
import { mapConsentV2ToExisting } from './compatibility-mapper';

function mechanism(kind: MechanismResult['mechanism'], providerName: string, attribution: 'identified' | 'unknown_candidate' = 'identified'): MechanismResult {
  return {
    mechanism: kind,
    detection: { status: 'verified', evidence: [], reason_codes: ['CMP_DETECTED'] },
    provider: {
      attribution, confidence: attribution === 'identified' ? 'high' : 'medium',
      candidates: [{ provider_name: providerName, attribution, confidence: attribution === 'identified' ? 'high' : 'medium', evidence: [], reason_codes: attribution === 'identified' ? ['CMP_PROVIDER_IDENTIFIED'] : ['CMP_PROVIDER_UNKNOWN'] }],
      reason_codes: attribution === 'identified' ? ['CMP_PROVIDER_IDENTIFIED'] : ['CMP_PROVIDER_UNKNOWN']
    },
    adapter_maturity: 'verified'
  };
}

function result(overrides: Partial<FinalConsentAuditResult> = {}): FinalConsentAuditResult {
  return {
    context_clean: { status: 'verified', evidence: [], reason_codes: [] },
    geo_verified: { status: 'verified', evidence: [], reason_codes: [] },
    mechanisms: [mechanism('cmp', 'onetrust')],
    banner: { surface: 'banner', visibility: 'visible', evidence: [], reason_codes: ['BANNER_VISIBLE'] },
    available_actions: [{ action: 'reject_all', availability: 'direct', category: null, evidence: [], reason_codes: ['REJECT_AVAILABLE'] }],
    initial_state: { decision: 'unanswered', categories: [], evidence: [], reason_codes: [] },
    resulting_state: { decision: 'rejected', categories: [], evidence: [], reason_codes: [] },
    interactions: [{ action: 'reject_all', origin: 'provider_selector', outcome: 'executed', category: null, reason_codes: ['ACTION_EXECUTED'] }],
    rejection_verification: { status: 'verified', evidence: [], reason_codes: ['ACTION_VERIFIED'] },
    persistence: { status: 'confirmed', evidence: [], reason_codes: ['PERSISTENCE_CONFIRMED'] },
    frameworks: { tcf: 'present', gpp: 'stub_present', usp: 'not_present', evidence: [], reason_codes: ['TCF_PRESENT', 'GPP_STUB_PRESENT'] },
    google_consent_mode: { presence: 'present', defaults_observed: true, updates_observed: true, evidence: [], reason_codes: ['CONSENT_MODE_PRESENT'] },
    storage_changes: [], network_signals: [], reason_codes: [],
    ...overrides
  };
}

const context = { geo: 'EU' as const, page_valid: true, tracking_before_interaction: false, trace_steps: JSON.stringify([{ step: 'existing_trace' }]) };

describe('Consent V2 compatibility mapper', () => {
  it('maps a verified named CMP and appends bounded legacy trace events', () => {
    const mapped = mapConsentV2ToExisting(result(), context, { status: 'consistent', signals: [], reason_codes: [] });
    expect(mapped).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'pass' });
    expect(JSON.parse(mapped.trace_steps).map((entry: { step: string }) => entry.step)).toEqual(expect.arrayContaining([
      'existing_trace', 'consent_context_started', 'cmp_provider_identified', 'cmp_reject_verified', 'tcf_detected', 'gpp_stub_detected', 'consent_audit_completed'
    ]));
  });

  it('does not let Shopify Customer Privacy overwrite a visible CMP', () => {
    const mapped = mapConsentV2ToExisting(result({ mechanisms: [mechanism('commerce_privacy_runtime', 'shopify'), mechanism('cmp', 'cookiebot')] }), context);
    expect(mapped.cmp_provider).toBe('Cookiebot');
  });

  it('maps only the Shopify privacy runtime to the existing frontend provider value', () => {
    const mapped = mapConsentV2ToExisting(result({ mechanisms: [mechanism('commerce_privacy_runtime', 'shopify')] }), context);
    expect(mapped.cmp_provider).toBe('Shopify Privacy');
  });

  it('keeps an unknown custom CMP distinct from Shopify and maps it as Unknown', () => {
    const mapped = mapConsentV2ToExisting(result({ mechanisms: [mechanism('commerce_privacy_runtime', 'shopify'), mechanism('custom', 'unknown', 'unknown_candidate')] }), context);
    expect(mapped.cmp_provider).toBe('Unknown');
  });

  it('maps Sourcepoint to the supported generic frontend provider field', () => {
    const mapped = mapConsentV2ToExisting(result({ mechanisms: [mechanism('cmp', 'sourcepoint')] }), context);
    expect(mapped.cmp_provider).toBe('Sourcepoint');
  });

  it('keeps challenge and geo failures inconclusive rather than mapping a false Not Found CMP', () => {
    const blocked = result({
      context_clean: { status: 'inconclusive', evidence: [], reason_codes: ['BLOCKED_OR_CHALLENGED'] },
      geo_verified: { status: 'inconclusive', evidence: [], reason_codes: ['GEO_UNVERIFIED'] },
      mechanisms: [], reason_codes: ['NO_CMP_DETECTED', 'BLOCKED_OR_CHALLENGED', 'GEO_UNVERIFIED']
    });
    const mapped = mapConsentV2ToExisting(blocked, context);
    expect(mapped).toMatchObject({ cmp_provider: null, consent_status: 'inconclusive' });
    expect(mapped.trace_events).toContain('consent_geo_unverified');
    expect(mapped.trace_events).not.toContain('cmp_provider_identified');
  });

  it('keeps unsupported interaction inconclusive rather than reporting no CMP', () => {
    const unsupported = result({ interactions: [{ action: 'reject_all', origin: 'semantic_ui', outcome: 'unsupported', category: null, reason_codes: ['INTERACTION_UNSUPPORTED'] }] });
    expect(mapConsentV2ToExisting(unsupported, context)).toMatchObject({ cmp_provider: null, consent_status: 'inconclusive' });
  });

  it('maps an explicit clean no-CMP technical result through the existing business resolver', () => {
    const noCmp = result({ mechanisms: [], interactions: [], reason_codes: ['NO_CMP_DETECTED'] });
    expect(mapConsentV2ToExisting(noCmp, context)).toMatchObject({ cmp_provider: 'Not Found', consent_status: 'not_detected' });
  });

  it('maps a tracking contradiction without changing the verified Reject technical state', () => {
    const v2 = result();
    const mapped = mapConsentV2ToExisting(v2, context, { status: 'contradiction', signals: [], reason_codes: ['POST_REJECT_EVENT_HIT'] });
    expect(mapped).toMatchObject({ consent_status: 'consent_leakage' });
    expect(mapped.trace_events).toContain('consent_tracking_contradiction');
    expect(v2.rejection_verification.status).toBe('verified');
  });

  it('maps deterministically and respects the existing bounded trace format', () => {
    const boundedContext = { ...context, max_trace_steps: 2 };
    const first = mapConsentV2ToExisting(result(), boundedContext);
    const second = mapConsentV2ToExisting(result(), boundedContext);
    expect(first).toEqual(second);
    expect(JSON.parse(first.trace_steps)).toHaveLength(2);
  });
});
