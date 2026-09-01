import { describe, expect, it } from 'vitest';
import { ConsentAuditCodes } from './domain-types';
import { verifyRequestedConsentAction, type RejectVerificationSignal } from './reject-verification-engine';

const actionTimestamp = 1_000;

function signal(overrides: Partial<RejectVerificationSignal> = {}): RejectVerificationSignal {
  return {
    family: 'provider_state', rank: 'strong', relation: 'matches_requested', observed_at: actionTimestamp + 1,
    authoritative: true, ...overrides
  };
}

function verify(signals: RejectVerificationSignal[], extra: { navigation_interrupted?: boolean } = {}) {
  return verifyRequestedConsentAction({ requested_action: 'reject_all', action_timestamp: actionTimestamp, signals, ...extra });
}

describe('reject verification engine', () => {
  it('verifies a direct Reject with authoritative state and an independent provider event', () => {
    const result = verify([signal(), signal({ family: 'provider_event', rank: 'supporting', authoritative: false })]);
    expect(result).toMatchObject({ status: 'verified', reason_codes: [ConsentAuditCodes.ACTION_VERIFIED] });
    expect(result.corroborating_evidence).toEqual(['provider_event']);
  });

  it('verifies preferences Reject with category state and independent persistence evidence', () => {
    const result = verify([
      signal({ family: 'provider_category_state' }),
      signal({ family: 'provider_persistence', rank: 'supporting', authoritative: false })
    ]);
    expect(result.status).toBe('verified');
  });

  it('keeps a click-only outcome inconclusive', () => {
    expect(verify([signal({ family: 'interaction', rank: 'weak', authoritative: false })])).toMatchObject({
      status: 'inconclusive', reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
    });
  });

  it('keeps a disappearing banner inconclusive', () => {
    expect(verify([signal({ family: 'banner_surface', rank: 'weak', authoritative: false })])).toMatchObject({ status: 'inconclusive' });
  });

  it('keeps a provider event alone inconclusive', () => {
    expect(verify([signal({ family: 'provider_event', rank: 'supporting', authoritative: false })])).toMatchObject({ status: 'inconclusive' });
  });

  it('keeps storage creation alone inconclusive', () => {
    expect(verify([signal({ family: 'storage', rank: 'supporting', authoritative: false })])).toMatchObject({ status: 'inconclusive' });
  });

  it('does not treat an unanswered post-action state as rejected', () => {
    const result = verify([signal({ relation: 'unanswered' }), signal({ family: 'provider_event', rank: 'supporting', relation: 'unanswered', authoritative: false })]);
    expect(result).toMatchObject({ status: 'inconclusive', reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  });

  it('reports explicit authoritative state contradiction as not verified', () => {
    const result = verify([signal({ relation: 'contradicts_requested' })]);
    expect(result).toMatchObject({ status: 'not_verified', reason_codes: [ConsentAuditCodes.ACTION_NOT_VERIFIED, ConsentAuditCodes.STATE_CONTRADICTION] });
  });

  it('keeps conflicting non-authoritative strong sources inconclusive', () => {
    const result = verify([
      signal(),
      signal({ family: 'framework_tcf', relation: 'contradicts_requested', authoritative: false })
    ]);
    expect(result).toMatchObject({
      status: 'inconclusive', reason_codes: [ConsentAuditCodes.STATE_CONTRADICTION, ConsentAuditCodes.ACTION_INCONCLUSIVE]
    });
  });

  it('verifies two independent strong semantic signals without supporting evidence', () => {
    const result = verify([signal({ family: 'provider_state' }), signal({ family: 'framework_tcf' })]);
    expect(result).toMatchObject({ status: 'verified', strong_evidence: ['framework_tcf', 'provider_state'] });
  });

  it('does not use framework evidence captured before the action', () => {
    const result = verify([signal({ family: 'framework_tcf', observed_at: actionTimestamp - 1 })]);
    expect(result).toMatchObject({ status: 'inconclusive', evidence: [] });
  });

  it('keeps a navigation interruption inconclusive even when weak post-action evidence remains', () => {
    const result = verify([signal({ family: 'interaction', rank: 'weak', authoritative: false })], { navigation_interrupted: true });
    expect(result).toMatchObject({
      status: 'inconclusive', reason_codes: [ConsentAuditCodes.NAVIGATION_INTERRUPTED, ConsentAuditCodes.ACTION_INCONCLUSIVE]
    });
  });
});
