import { describe, expect, it } from 'vitest';
import { ConsentAuditCodes, type ConsentState } from './domain-types';
import type { ConsentFrameworkObservations } from './framework-observers';
import { assessRejectVerificationCapability } from './verification-capability';

const ambiguous: ConsentState = { decision: 'ambiguous', categories: [], evidence: [], reason_codes: [] };
const absent: ConsentFrameworkObservations = {
  tcf: { present: false, lifecycle: 'absent', ping: null, latest_event: null, event_count: 0, reason_codes: [] },
  gpp: { present: false, lifecycle: 'absent', ping: null, structure: null, event_count: 0, reason_codes: [] },
  usp: { present: false, mode: 'absent', reason_codes: [] }
};

describe('Reject verification capability preflight', () => {
  it('admits a ready TCF semantic path for OneTrust', () => {
    const capability = assessRejectVerificationCapability({
      providerState: ambiguous,
      frameworks: {
        ...absent,
        tcf: {
          present: true, lifecycle: 'ready', ping: { cmp_loaded: true, api_version: '2.2', gdpr_applies: true },
          listener_registered: true, listener_event_observed: true, listener_registration_failed: false,
          latest_event: {
            event_status: 'tcloaded', gdpr_applies: true,
            purpose_consents: { known: true, total_count: 2, granted_count: 1, denied_count: 1 },
            vendor_consents: { known: true, total_count: 2, granted_count: 1, denied_count: 1 }
          }, event_count: 1, reason_codes: []
        }
      }
    });
    expect(capability).toEqual({ status: 'available', strong_families: ['framework_tcf'], reason_codes: [] });
  });

  it('blocks OneTrust with absent TCF and ambiguous provider state', () => {
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: absent })).toEqual({
      status: 'unavailable', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_UNAVAILABLE]
    });
  });

  it('does not treat a provider event or storage-like facts as a semantic verifier', () => {
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: absent })).toMatchObject({ status: 'unavailable', strong_families: [] });
  });

  it('admits an already readable provider decision or fully normalized category state', () => {
    expect(assessRejectVerificationCapability({
      providerState: { decision: 'accepted', categories: [], evidence: [], reason_codes: [] }, frameworks: absent
    }).strong_families).toEqual(['provider_state']);
    expect(assessRejectVerificationCapability({
      providerState: {
        decision: 'ambiguous', categories: [
          { category: 'analytics', decision: 'rejected', evidence: [] },
          { category: 'marketing', decision: 'rejected', evidence: [] }
        ], evidence: [], reason_codes: []
      }, frameworks: absent
    }).strong_families).toEqual(['provider_category_state']);
  });

  it('admits an unresolved but normalized category channel as capability without treating it as evidence', () => {
    expect(assessRejectVerificationCapability({
      providerState: {
        decision: 'ambiguous', categories: [
          { category: 'analytics', decision: 'unanswered', evidence: [] },
          { category: 'marketing', decision: 'unanswered', evidence: [] }
        ], evidence: [], reason_codes: []
      }, frameworks: absent
    })).toEqual({ status: 'available', strong_families: ['provider_category_state'], reason_codes: [] });
  });

  it('does not use necessary-only or US sale/share state to verify cookie Reject', () => {
    for (const category of ['necessary', 'sale_or_share'] as const) {
      expect(assessRejectVerificationCapability({
        providerState: {
          decision: 'ambiguous', categories: [{ category, decision: 'unanswered', evidence: [] }], evidence: [], reason_codes: []
        }, frameworks: absent
      }).status).toBe('unavailable');
    }
  });

  it('leaves a loading TCF observer inconclusive rather than asserting absence', () => {
    expect(assessRejectVerificationCapability({
      providerState: ambiguous,
      frameworks: { ...absent, tcf: { ...absent.tcf, present: true, lifecycle: 'loading' } }
    })).toMatchObject({ status: 'inconclusive', reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_PENDING] });
  });

  it('accepts a populated cmpuishown callback as capability while lifecycle remains loading', () => {
    const tcf: ConsentFrameworkObservations['tcf'] = {
      present: true, lifecycle: 'loading', ping: { cmp_loaded: null, cmp_status: null, api_version: '2.2', gdpr_applies: true },
      listener_registered: true, listener_event_observed: true, listener_registration_failed: false,
      latest_event: {
        event_status: 'cmpuishown', cmp_status: 'loaded', gdpr_applies: true,
        purpose_consents: { known: true, total_count: 5, granted_count: 0, denied_count: 5 },
        vendor_consents: { known: true, total_count: 4, granted_count: 0, denied_count: 4 }
      }, event_count: 1, reason_codes: []
    };
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: { ...absent, tcf } }))
      .toEqual({ status: 'available', strong_families: ['framework_tcf'], reason_codes: [] });
    expect(tcf.lifecycle).toBe('loading');
  });

  it('accepts an operational semantic listener when ping has no reply', () => {
    const tcf: ConsentFrameworkObservations['tcf'] = {
      present: true, lifecycle: 'stub_present', ping: null,
      listener_registered: true, listener_event_observed: true, listener_registration_failed: false,
      latest_event: {
        event_status: 'cmpuishown', cmp_status: 'loaded', gdpr_applies: true,
        purpose_consents: { known: true, total_count: 2, granted_count: 0, denied_count: 2 },
        vendor_consents: { known: true, total_count: 1, granted_count: 0, denied_count: 1 }
      }, event_count: 1, reason_codes: []
    };
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: { ...absent, tcf } }))
      .toMatchObject({ status: 'available', strong_families: ['framework_tcf'] });
  });

  it('requires the TCF API itself to be present before accepting listener evidence', () => {
    const tcf: ConsentFrameworkObservations['tcf'] = {
      present: false, lifecycle: 'loading', ping: null,
      listener_registered: true, listener_event_observed: true, listener_registration_failed: false,
      latest_event: {
        event_status: 'cmpuishown', cmp_status: 'loaded', gdpr_applies: true,
        purpose_consents: { known: true, total_count: 1, granted_count: 0, denied_count: 1 },
        vendor_consents: { known: true, total_count: 1, granted_count: 0, denied_count: 1 }
      }, event_count: 1, reason_codes: []
    };
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: { ...absent, tcf } }).status)
      .toBe('unavailable');
  });

  it('keeps cmpuishown capability pending without a listener, semantic aggregate, or recognized state', () => {
    const event = {
      event_status: 'cmpuishown' as const, cmp_status: 'loaded' as const, gdpr_applies: true,
      purpose_consents: { known: true, total_count: 1, granted_count: 0, denied_count: 1 },
      vendor_consents: { known: false, total_count: 0, granted_count: 0, denied_count: 0 }
    };
    const base: ConsentFrameworkObservations['tcf'] = {
      present: true, lifecycle: 'loading', ping: { cmp_loaded: null, cmp_status: null, api_version: '2.2', gdpr_applies: true },
      listener_registered: true, listener_event_observed: true, listener_registration_failed: false,
      latest_event: event, event_count: 1, reason_codes: []
    };
    const emptyEvent = { ...event, purpose_consents: { known: false, total_count: 0, granted_count: 0, denied_count: 0 }, vendor_consents: { known: false, total_count: 0, granted_count: 0, denied_count: 0 } };
    const unknownEvent = { ...event, event_status: 'unknown' as const };
    const cases: ConsentFrameworkObservations['tcf'][] = [
      { ...base, listener_registered: false, listener_event_observed: false },
      { ...base, latest_event: emptyEvent },
      { ...base, latest_event: unknownEvent }
    ];
    for (const tcf of cases) {
      expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: { ...absent, tcf } }))
        .toMatchObject({ status: 'inconclusive', reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_PENDING] });
    }
  });

  it('does not let a cmpuishown callback overrule cmpLoaded false or a TCF error', () => {
    const goodEvent: NonNullable<ConsentFrameworkObservations['tcf']['latest_event']> = {
      event_status: 'cmpuishown', cmp_status: 'loaded', gdpr_applies: true,
      purpose_consents: { known: true, total_count: 1, granted_count: 0, denied_count: 1 },
      vendor_consents: { known: true, total_count: 1, granted_count: 0, denied_count: 1 }
    };
    const base: ConsentFrameworkObservations['tcf'] = {
      present: true, lifecycle: 'loading', ping: { cmp_loaded: false, cmp_status: 'stub', api_version: '2.2', gdpr_applies: true },
      listener_registered: true, listener_event_observed: true, listener_registration_failed: false,
      latest_event: goodEvent, event_count: 1, reason_codes: []
    };
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: { ...absent, tcf: base } }).status).toBe('inconclusive');
    expect(assessRejectVerificationCapability({ providerState: ambiguous, frameworks: { ...absent, tcf: { ...base, lifecycle: 'error', ping: { ...base.ping!, cmp_loaded: true, cmp_status: 'error' } } } }).status).toBe('unavailable');
  });
});
