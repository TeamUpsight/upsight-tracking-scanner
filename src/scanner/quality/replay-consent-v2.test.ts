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
  evidence.runtime.proxy_country_verified = true;
  evidence.runtime.country_matches_requested_geo = true;
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
  it('replays an incomplete rendered page without projecting CMP absence', () => {
    const evidence = new EvidenceCollector({ auditId: 'render-shell', domain: 'fixture.example', geo: 'EU', mode: 'diagnostic', selectedModules: ['consent'] }).bundle;
    evidence.page.valid = true;
    evidence.page.status_code = 200;
    evidence.page.access_category = 'none';
    evidence.consent.executed = true;
    evidence.consent.resolved_provider = 'Not Found';
    evidence.consent.resolved_provider_evidence = ['NO_CMP_DETECTED'];
    evidence.runtime.consent_v2 = { enabled: true, render_state: 'incomplete' } as EvidenceBundle['runtime']['consent_v2'];
    const replayed = replayEvidence(evidence);
    expect(replayed.cmp_provider).not.toBe('Not Found');
    expect(replayed.consent_status).toBe('inconclusive');
    expect(replayEvidence(replayed.evidence_bundle!)).toMatchObject({ cmp_provider: replayed.cmp_provider, consent_status: replayed.consent_status });
  });

  it('retains AdRoll provider identity and conservative Consent status across replay', () => {
    const evidence = new EvidenceCollector({ auditId: 'adroll-replay', domain: 'fixture.example', geo: 'EU', mode: 'diagnostic', selectedModules: ['consent'] }).bundle;
    evidence.page.valid = true;
    evidence.page.status_code = 200;
    evidence.page.access_category = 'none';
    evidence.runtime.requested_country = 'DE';
    evidence.runtime.actual_egress_country = 'DE';
    evidence.runtime.exact_country_match = true;
    evidence.runtime.proxy_country_verified = true;
    evidence.runtime.country_matches_requested_geo = true;
    evidence.consent.executed = true;
    evidence.consent.resolved_provider = 'AdRoll';
    evidence.consent.resolved_provider_confidence = 'high';
    evidence.consent.banner_visible = false;
    evidence.consent.interaction_attempted = false;
    evidence.consent.rejection_verified = false;
    evidence.consent.post_reject_observation_completed = false;
    evidence.runtime.consent_v2 = {
      enabled: true,
      render_state: 'ready',
      tracking_consistency: 'not_applicable',
      adroll_bootstrap: {
        roundtrip_observed: true, roundtrip_requested_at_ms: 10, roundtrip_completed_at_ms: 100,
        consent_check_observed: true, consent_check_status: 200, consent_check_parsed: true, consent_check_parse_status: 'parsed', consent_check_requested_at_ms: 110, consent_check_completed_at_ms: 150,
        consent_check_body_bytes: 180, consent_check_content_type: 'javascript', consent_check_content_length_bytes: 180, consent_check_body_read_status: 'read',
        consent_check_response_shape: 'set_consent', consent_check_contains_adroll_exp_list: false, consent_check_contains_set_consent: true,
        gdpr_applies: true, user_country: 'LV', advertiser_country: 'AE', banner_mode: 'adroll', ipgeo_country: 'LV', ipgeo_region: 'Riga',
        consent_script_observed: false, consent_script_requested_at_ms: null, consent_script_completed_at_ms: null,
        banner_root_observed: false, banner_visible: false, adroll_banner_expected: true, adroll_country_matches_requested_country: false,
        grace_triggered: true, grace_elapsed_ms: 12_000, grace_max_ms: 12_000, grace_timed_out: true, bootstrap_state: 'timed_out'
      }
    } as EvidenceBundle['runtime']['consent_v2'];
    const replayed = replayEvidence(evidence);
    expect(replayed).toMatchObject({ cmp_provider: 'AdRoll', consent_status: 'inconclusive' });
    expect(replayed.reason_codes).not.toContain('GEO_UNVERIFIED');
    expect(replayed.evidence_bundle?.runtime).toMatchObject({ requested_country: 'DE', actual_egress_country: 'DE', exact_country_match: true, proxy_country_verified: true });
    const replayedAgain = replayEvidence(replayed.evidence_bundle!);
    expect(replayedAgain).toMatchObject({ cmp_provider: 'AdRoll', consent_status: 'inconclusive' });
    expect(replayedAgain.evidence_bundle?.runtime.consent_v2?.adroll_bootstrap).toEqual(replayed.evidence_bundle?.runtime.consent_v2?.adroll_bootstrap);
  });

  it('does not replay unresolved roundtrip-only bootstrap as a confident CMP absence', () => {
    const evidence = new EvidenceCollector({ auditId: 'adroll-roundtrip-replay', domain: 'fixture.example', geo: 'EU', mode: 'diagnostic', selectedModules: ['consent'] }).bundle;
    evidence.page.valid = true;
    evidence.page.status_code = 200;
    evidence.page.access_category = 'none';
    evidence.runtime.proxy_country_verified = true;
    evidence.consent.executed = true;
    evidence.consent.resolved_provider = 'Not Found';
    evidence.consent.resolved_provider_evidence = ['NO_CMP_DETECTED'];
    evidence.runtime.consent_v2 = {
      enabled: true, render_state: 'ready', tracking_consistency: 'not_applicable',
      adroll_bootstrap: {
        roundtrip_observed: true, roundtrip_requested_at_ms: 20, roundtrip_completed_at_ms: 200,
        consent_check_observed: false, consent_check_status: null, consent_check_parsed: false, consent_check_parse_status: 'not_attempted', consent_check_requested_at_ms: null, consent_check_completed_at_ms: null,
        consent_check_body_bytes: null, consent_check_content_type: 'unknown', consent_check_content_length_bytes: null, consent_check_body_read_status: 'not_attempted',
        consent_check_response_shape: 'not_observed', consent_check_contains_adroll_exp_list: false, consent_check_contains_set_consent: false,
        gdpr_applies: null, user_country: null, advertiser_country: null, banner_mode: null, ipgeo_country: null, ipgeo_region: null,
        consent_script_observed: false, consent_script_requested_at_ms: null, consent_script_completed_at_ms: null,
        banner_root_observed: false, banner_visible: false, adroll_banner_expected: false, adroll_country_matches_requested_country: null,
        grace_triggered: true, grace_elapsed_ms: 12_000, grace_max_ms: 12_000, grace_timed_out: true, bootstrap_state: 'timed_out'
      }
    } as EvidenceBundle['runtime']['consent_v2'];
    const replayed = replayEvidence(evidence);
    expect(replayed.cmp_provider).not.toBe('Not Found');
    expect(replayed.consent_status).toBe('inconclusive');
  });

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
