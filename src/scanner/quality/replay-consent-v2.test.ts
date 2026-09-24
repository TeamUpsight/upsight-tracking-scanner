import { describe, expect, it } from 'vitest';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { replayEvidence } from './replay';
import type { EvidenceBundle } from '../../types';

function consentEvidence(trackingConsistency: 'consistent' | 'contradiction' | 'insufficient_evidence' | 'not_applicable', postRejectComplete = true) {
  const evidence = new EvidenceCollector({
    auditId: `replay-v2-${trackingConsistency}`,
    domain: 'www.velux.de',
    geo: 'EU',
    mode: 'diagnostic',
    selectedModules: ['consent']
  }).bundle;
  evidence.page.valid = true;
  evidence.page.status_code = 200;
  evidence.page.final_url = 'https://www.velux.de/';
  evidence.page.access_category = 'none';
  evidence.consent.executed = true;
  evidence.consent.resolved_provider = 'Cookiebot';
  evidence.consent.resolved_provider_confidence = 'high';
  evidence.consent.interaction_attempted = true;
  evidence.consent.rejection_verified = true;
  evidence.consent.post_reject_observation_completed = postRejectComplete;
  evidence.runtime.consent_v2 = { tracking_consistency: trackingConsistency } as EvidenceBundle['runtime']['consent_v2'];
  // Audit 545's V2 request buffer records consent_v2 chronology. No global
  // request carries the legacy post_reject phase expected by old replay.
  evidence.network.relevant_requests = [];
  return evidence;
}

describe('Consent V2 canonical replay tracking consistency', () => {
  it('REPLAY-CONSENT-V2-545 reproduces the Audit 545 contradiction without a legacy post_reject phase', () => {
    const evidence = consentEvidence('contradiction');
    const replayed = replayEvidence(evidence);

    expect(evidence.network.relevant_requests.some((request) => request.phase.includes('post_reject'))).toBe(false);
    expect(replayed).toMatchObject({
      consent_status: 'consent_leakage',
      cmp_provider: 'Cookiebot',
      overall_status: 'fail',
      finding_confidence: { consent: { status: 'consent_leakage', confidence: 'high', reason_code: 'CMP_REJECT_TRACKING_OBSERVED' } }
    });
    expect(replayed.evidence_bundle?.decision_summary?.find((decision) => decision.decision_name === 'consent')).toMatchObject({
      status: 'consent_leakage', reason_code: 'CMP_REJECT_TRACKING_OBSERVED', observation_complete: true, blocking_uncertainty: []
    });
  });

  it('keeps a completed consistent V2 result as pass', () => {
    const evidence = consentEvidence('consistent');
    evidence.network.relevant_requests = [{
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect', method: 'POST',
      phase: 'legacy_post_reject', timestamp: 1
    }];
    expect(replayEvidence(evidence)).toMatchObject({ consent_status: 'pass', overall_status: 'pass' });
  });

  it('does not let a V2 contradiction create leakage before verified Reject and completed observation', () => {
    const incomplete = consentEvidence('contradiction', false);
    expect(replayEvidence(incomplete)).toMatchObject({ consent_status: 'inconclusive', overall_status: 'inconclusive' });

    const unverified = consentEvidence('contradiction');
    unverified.consent.rejection_verified = false;
    expect(replayEvidence(unverified)).toMatchObject({ consent_status: 'inconclusive', overall_status: 'inconclusive' });
  });

  it('keeps an incomplete insufficient-evidence result inconclusive', () => {
    expect(replayEvidence(consentEvidence('insufficient_evidence', false))).toMatchObject({ consent_status: 'inconclusive', overall_status: 'inconclusive' });
  });

  it('does not treat insufficient V2 tracking evidence as a clean negative even when observation completed', () => {
    expect(replayEvidence(consentEvidence('insufficient_evidence', true))).toMatchObject({ consent_status: 'inconclusive', overall_status: 'inconclusive' });
  });

  it('does not create leakage for an unverified Reject with not-applicable tracking', () => {
    const evidence = consentEvidence('not_applicable');
    evidence.consent.rejection_verified = false;
    expect(replayEvidence(evidence)).toMatchObject({ consent_status: 'inconclusive', overall_status: 'inconclusive' });
  });

  it('retains legacy post_reject phase inference when V2 tracking consistency is absent', () => {
    const evidence = consentEvidence('consistent');
    evidence.runtime.consent_v2 = undefined;
    evidence.network.relevant_requests = [{
      vendor: 'ga4', kind: 'collection', collector: 'third_party', host: 'analytics.google.com', path: '/g/collect', method: 'POST',
      phase: 'legacy_post_reject', timestamp: 1
    }];
    expect(replayEvidence(evidence)).toMatchObject({ consent_status: 'consent_leakage', overall_status: 'fail' });
  });
});
