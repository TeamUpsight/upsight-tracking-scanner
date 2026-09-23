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
      frameworks: { ...absent, tcf: { ...absent.tcf, lifecycle: 'loading' } }
    })).toMatchObject({ status: 'inconclusive', reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_PENDING] });
  });
});
