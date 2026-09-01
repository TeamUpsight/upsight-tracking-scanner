import { describe, expect, it } from 'vitest';
import type { TrackingRequestEvidence } from '../../types';
import type { VerificationResult } from './domain-types';
import { checkTrackingConsistency, TrackingConsistencyCodes } from './tracking-consistency';

const rejected = { status: 'verified' as const, evidence: ['semantic:provider:persisted'], reason_codes: ['ACTION_VERIFIED' as const] };
const unverified = { status: 'inconclusive' as const, evidence: [], reason_codes: ['ACTION_INCONCLUSIVE' as const] };
const rejectTimestamp = 1_000;

function request(overrides: Partial<TrackingRequestEvidence> = {}): TrackingRequestEvidence {
  return {
    vendor: 'meta', kind: 'collection', collector: 'third_party', host: 'www.facebook.com', path: '/tr', method: 'GET',
    phase: 'post_action', timestamp: rejectTimestamp + 1, event: 'ViewContent', ...overrides
  };
}

function check(requests: TrackingRequestEvidence[], verification: VerificationResult = rejected, complete = true) {
  return checkTrackingConsistency({ rejection_verification: verification, user_choice_at: rejectTimestamp, post_reject_observation_completed: complete, requests });
}

describe('consent versus tracking consistency', () => {
  it('keeps a script load after verified Reject consistent', () => {
    const result = check([request({ kind: 'script', host: 'connect.facebook.net', path: '/en_US/fbevents.js', event: undefined })]);
    expect(result).toMatchObject({ status: 'consistent', signals: [{ kind: 'script_load', timing: 'post_verified_reject' }] });
  });

  it('reports an event hit after verified Reject as a contradiction', () => {
    const result = check([request()]);
    expect(result).toMatchObject({ status: 'contradiction', reason_codes: [TrackingConsistencyCodes.POST_REJECT_EVENT_HIT], signals: [{ kind: 'event_hit' }] });
  });

  it('reports a conversion after verified Reject as a contradiction', () => {
    const result = check([request({ event: 'Purchase' })]);
    expect(result).toMatchObject({ status: 'contradiction', signals: [{ kind: 'conversion_hit' }] });
  });

  it('keeps a Floodlight conversion distinct from generic Google Ads collection', () => {
    const result = check([request({ vendor: 'unknown', host: 'ad.doubleclick.net', path: '/ddm/activity', event: undefined })]);
    expect(result).toMatchObject({ status: 'contradiction', signals: [{ vendor: 'floodlight', kind: 'conversion_hit' }] });
  });

  it('is consistent when a completed post-Reject observation has no activity', () => {
    expect(check([])).toMatchObject({ status: 'consistent', reason_codes: [TrackingConsistencyCodes.NO_POST_REJECT_EVENT_HIT] });
  });

  it('does not treat activity before Reject as leakage after Reject', () => {
    const result = check([request({ timestamp: rejectTimestamp - 1 })]);
    expect(result).toMatchObject({ status: 'consistent', signals: [{ timing: 'pre_choice' }] });
  });

  it('keeps verified Reject intact while separately reporting a contradiction', () => {
    const verification = Object.freeze({ ...rejected });
    const result = check([request({ event: 'Purchase' })], verification);
    expect(result.status).toBe('contradiction');
    expect(verification.status).toBe('verified');
  });

  it('does not call an unverified Reject plus vendor hit a tracking contradiction', () => {
    const result = check([request({ event: 'Purchase' })], unverified);
    expect(result).toMatchObject({ status: 'not_applicable', reason_codes: [TrackingConsistencyCodes.REJECT_NOT_VERIFIED], signals: [{ timing: 'post_action_unverified' }] });
  });

  it('classifies observation-only requests as pre-choice without a Reject timestamp', () => {
    const result = checkTrackingConsistency({ rejection_verification: unverified, user_choice_at: null, post_reject_observation_completed: false, requests: [request()] });
    expect(result).toMatchObject({ status: 'not_applicable', signals: [{ timing: 'pre_choice' }] });
  });
});
