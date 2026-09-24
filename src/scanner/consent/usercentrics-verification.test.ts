import { describe, expect, it } from 'vitest';
import type { ConsentState } from './domain-types';
import type { ConsentFrameworkObservations } from './framework-observers';
import { collectRejectVerificationSignals } from './verification-evidence';
import { verifyRequestedConsentAction } from './reject-verification-engine';

const frameworks: ConsentFrameworkObservations = {
  tcf: { present: false, lifecycle: 'absent', ping: null, latest_event: null, event_count: 0, reason_codes: [] },
  gpp: { present: false, lifecycle: 'absent', ping: null, structure: null, event_count: 0, reason_codes: [] },
  usp: { present: false, mode: 'absent', reason_codes: [] }
};
const state = (decision: ConsentState['decision'], categories: ConsentState['categories'] = []): ConsentState =>
  ({ decision, categories, evidence: [], reason_codes: [] });
const rejectedCategories: ConsentState['categories'] = [
  { category: 'analytics', decision: 'rejected', evidence: [] },
  { category: 'marketing', decision: 'rejected', evidence: [] }
];
function signals(providerState: ConsentState, event?: 'matches_requested' | 'contradicts_requested', observedFrameworks = frameworks) {
  return collectRejectVerificationSignals({ timestamp: 1_000, interactionExecuted: true, navigationInterrupted: false,
    providerState, providerStateIndependenceGroup: 'usercentrics_runtime', providerEventObserved: false,
    providerEventRelation: event, providerActionCompleted: false, frameworks: observedFrameworks });
}
const verify = (evidence: ReturnType<typeof signals>) => verifyRequestedConsentAction({ requested_action: 'reject_all', action_timestamp: 1_000, signals: evidence });

describe('Usercentrics semantic verification contracts', () => {
  it('UC-VERIFY-A conditionally verifies rejected runtime plus an independent semantic Reject event', () => {
    // The current browser bridge has no validated Usercentrics Reject event;
    // this is the verifier contract for a future documented event reader.
    expect(verify(signals(state('rejected'), 'matches_requested'))).toMatchObject({ status: 'verified',
      strong_evidence: ['provider_state'], corroborating_evidence: ['provider_event'] });
  });

  it('UC-VERIFY-B groups runtime state and its category projection as one source', () => {
    const evidence = signals(state('rejected', rejectedCategories));
    expect(evidence.filter((item) => item.rank === 'strong').map((item) => item.independence_group)).toEqual(['usercentrics_runtime', 'usercentrics_runtime']);
    expect(verify(evidence).status).toBe('inconclusive');
  });

  it('UC-VERIFY-C/D leaves click, banner removal, and FIRST_LAYER to NONE inconclusive', () => {
    const click = signals(state('ambiguous'));
    expect(verify([...click, { family: 'banner_surface', rank: 'weak', relation: 'unknown', observed_at: 1_001 }]).status).toBe('inconclusive');
    expect(verify([...click, { family: 'ui_feedback', rank: 'weak', relation: 'unknown', observed_at: 1_001 }]).status).toBe('inconclusive');
  });

  it('UC-VERIFY-E/F distinguishes accepted contradiction from unanswered state', () => {
    expect(verify(signals(state('accepted')))).toMatchObject({ status: 'not_verified', reason_codes: expect.arrayContaining(['STATE_CONTRADICTION']) });
    expect(verify(signals(state('unanswered'))).status).toBe('inconclusive');
  });

  it('UC-VERIFY-G conditionally verifies a valid rejected TCF useractioncomplete with rejected runtime', () => {
    const tcf: ConsentFrameworkObservations = { ...frameworks, tcf: { present: true, lifecycle: 'ready',
      ping: { cmp_loaded: true, cmp_status: 'loaded', api_version: '2.2', gdpr_applies: true },
      latest_event: { event_status: 'useractioncomplete', cmp_status: 'loaded', gdpr_applies: true,
        purpose_consents: { known: true, total_count: 2, granted_count: 0, denied_count: 2 },
        vendor_consents: { known: true, total_count: 2, granted_count: 0, denied_count: 2 } },
      listener_registered: true, listener_event_observed: true, listener_registration_failed: false, event_count: 1, reason_codes: [] } };
    expect(verify(signals(state('rejected'), undefined, tcf))).toMatchObject({ status: 'verified',
      strong_evidence: ['framework_tcf', 'provider_state'] });
  });

  it('UC-VERIFY-CHRONOLOGY excludes an earlier semantic event and includes a synchronous event at activation', () => {
    const baseline = signals(state('rejected'));
    const event = { family: 'provider_event' as const, rank: 'supporting' as const, relation: 'matches_requested' as const };
    expect(verify([...baseline, { ...event, observed_at: 999 }]).status).toBe('inconclusive');
    expect(verify([...baseline, { ...event, observed_at: 1_000 }]).status).toBe('verified');
  });
});
