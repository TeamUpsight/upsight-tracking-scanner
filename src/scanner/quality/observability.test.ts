import { describe, expect, it } from 'vitest';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { buildDebugPackageFiles } from './debug-package';
import { buildDecisionProvenance, buildObservabilityConsistency } from './observability';
import { replayEvidence } from './replay';
import type { StorefrontAudit } from '../../types';

function fixture(mode: 'normal' | 'diagnostic' = 'diagnostic') {
  const evidence = new EvidenceCollector({ auditId: 'obs', domain: 'example.com', geo: 'USA', mode }).bundle;
  evidence.consent.executed = true;
  evidence.consent.resolved_provider = 'OneTrust';
  evidence.consent.banner_visible = true;
  evidence.consent.accept_action_available = true;
  evidence.consent.pre_choice_measurement = 'limited_measurement';
  evidence.runtime.consent_v2 = {
    enabled: true, observation_only: true, provider: 'onetrust', provider_confidence: 'high', provider_conflict: false,
    banner_visibility: 'visible', reject_availability: 'direct', interaction_outcome: 'not_attempted', verification: 'inconclusive', persistence: 'inconclusive', generic_fallback: false, selector_or_action_failure: false,
    tcf_present: true, gpp_present: false, tcf_lifecycle: 'ready', gpp_lifecycle: 'absent', usp_present: false, action_status: 'not_attempted', consent_mode_classification: 'limited_measurement', tracking_consistency: 'consistent', unknown_cmp_fingerprint: null, geo_unverified: false, blocked_or_challenged: false,
    measurement: { state: 'limited_measurement', tracking_requests_observed: 0, tracking_requests_retained: 0, tracking_signals_classified: 0, pre_choice_event_hits: 0, pre_choice_conversion_hits: 0, pre_choice_script_loads: 0, limited_measurement_count: 1, full_measurement_count: 0, unknown_measurement_count: 0, gcm_network_observations: 0, gcm_commands: 0, contradiction: false, truncated: false, sources: [] }
  };
  evidence.product.final_pdp_url = 'https://example.com/products/one';
  evidence.product.pdp_url = 'https://example.com/products/one';
  evidence.diagnostic_observability = {
    consent_observations: [{
      capture_id: 'shared-1', context: 'shared', phase: 'homepage_shared_observation', captured_at_ms: 1, observation_complete: true,
      provider_selection: { selected_provider: 'onetrust', provider_conflict: false, candidates: [{ provider: 'onetrust', detection_status: 'identified', confidence: 'high', independent_evidence_families: ['provider_asset'], evidence_codes: ['unique_provider_script_or_config'] }] },
      banner: { visibility: 'visible', surface: 'banner' }, visible_surfaces: [{ surface_type: 'banner', provider_specific: true, visible: true, privacy_or_cookie_semantics: true, intent: 'consent', strong_presentation: true, location: 'main_frame' }],
      visible_controls: [{ accessible_name: 'Accept all', semantic_action: 'accept_all', visible: true, enabled: true, actionable: true, provider_specific: true, location: 'main_frame' }], frameworks: { tcf: true, gpp: false, consent_mode: 'limited_measurement' }
    }],
    diagnostic_captures: [{ capture_id: 'shared-1', phase: 'homepage_shared_observation', context: 'shared', screenshot_name: 'homepage.jpg', consent_snapshot_id: 'shared-1', captured_at_ms: 1, observation_complete: true, screenshot_captured_at_ms: 2 }],
    product_rejections: { observed_count: 14, truncated: true, candidates: Array.from({ length: 12 }, (_, index) => ({ sanitized_url: `https://example.com/image-${index}.jpg`, source: 'homepage_link', sources: ['homepage_link'], stage: 'non_page_resource', score: -1, reason_code: 'LOW_PRODUCT_RELEVANCE' })) }
  };
  evidence.decision_summary = ['consent', 'cmp', 'product_payload', 'ga4', 'meta', 'server_side'].map((decision_name) => ({ decision_name, status: decision_name === 'cmp' ? 'OneTrust' : decision_name === 'consent' ? 'pass' : null, confidence: 'high' as const, reason_code: 'FIXTURE', applicable: true, observation_complete: true, evidence_codes: ['fixture'], blocking_uncertainty: [] }));
  return evidence;
}

const audit = (evidence = fixture()): StorefrontAudit => ({ audit_id: 'obs', domain: 'example.com', group_label: null, scan_started_at: evidence.runtime.started_at, scan_completed_at: null, scan_status: 'completed', error_category: 'none', tested_geos: 'USA', cms_platform_detected: 'Unknown', overall_status: 'pass', overall_confidence: 'high', consent_status: 'pass', cmp_provider: 'OneTrust', product_payload_status: 'not_tested', pdp_url_tested: 'https://example.com/products/one', server_side_status: 'not_tested', ss_collection_type: 'not_tested', trace_steps: '[]', evidence_bundle: evidence });

describe('WP10 diagnostic observability', () => {
  it('OBS-CONSENT-01 through OBS-CONSENT-04 retain bounded observations and screenshot association', () => {
    const files = buildDebugPackageFiles(audit());
    const observations = JSON.parse(String(files['consent-observations.json']));
    const captures = JSON.parse(String(files['diagnostic-captures.json']));
    expect(observations[0]).toMatchObject({ context: 'shared', observation_complete: true, provider_selection: { selected_provider: 'onetrust' }, banner: { visibility: 'visible' } });
    expect(observations[0].provider_selection.candidates).toHaveLength(1);
    expect(observations[0].visible_controls[0].semantic_action).toBe('accept_all');
    expect(captures[0]).toMatchObject({ screenshot_name: 'homepage.jpg', consent_snapshot_id: 'shared-1', captured_at_ms: expect.any(Number) });
  });

  it('OBS-CONSISTENCY-01 through OBS-CONSISTENCY-05 distinguish normalized and genuine contradictions', () => {
    const evidence = fixture();
    expect(buildObservabilityConsistency(audit(evidence), evidence).status).toBe('consistent');
    evidence.runtime.consent_v2!.provider = 'sourcepoint';
    expect(buildObservabilityConsistency(audit(evidence), evidence).checks.find((check) => check.code === 'OBS_CONSENT_PROVIDER_MISMATCH')?.status).toBe('mismatch');
    evidence.runtime.consent_v2!.provider = 'onetrust'; evidence.consent.banner_visible = false;
    expect(buildObservabilityConsistency(audit(evidence), evidence).checks.find((check) => check.code === 'OBS_CONSENT_BANNER_MISMATCH')?.status).toBe('mismatch');
    evidence.consent.banner_visible = true; evidence.runtime.consent_v2!.measurement!.state = 'full_measurement';
    expect(buildObservabilityConsistency(audit(evidence), evidence).checks.find((check) => check.code === 'OBS_CONSENT_MEASUREMENT_MISMATCH')?.status).toBe('mismatch');
  });

  it('OBS-SURFACE-01 through OBS-SURFACE-05 flag only strong visible consent UI that disagrees with the canonical banner', () => {
    const check = (evidence: ReturnType<typeof fixture>) => buildObservabilityConsistency(audit(evidence), evidence).checks.find((item) => item.code === 'OBS_CONSENT_SURFACE_BANNER_MISMATCH');
    const didomi = fixture();
    didomi.diagnostic_observability!.consent_observations[0].provider_selection = { selected_provider: 'didomi', provider_conflict: false, candidates: [{ provider: 'didomi', detection_status: 'identified', confidence: 'high', independent_evidence_families: ['typed_provider_api'], evidence_codes: ['typed_documented_provider_api'] }] };
    didomi.consent.banner_visible = null;
    expect(check(didomi)?.status).toBe('mismatch');

    const cookiebot = fixture();
    cookiebot.diagnostic_observability!.consent_observations[0].provider_selection = { selected_provider: 'cookiebot', provider_conflict: false, candidates: [{ provider: 'cookiebot', detection_status: 'identified', confidence: 'high', independent_evidence_families: ['provider_asset'], evidence_codes: ['unique_provider_script_or_config'] }] };
    cookiebot.consent.banner_visible = false;
    expect(check(cookiebot)?.status).toBe('mismatch');

    const unknown = fixture();
    unknown.diagnostic_observability!.consent_observations[0].provider_selection.selected_provider = null;
    unknown.diagnostic_observability!.consent_observations[0].provider_selection.candidates[0].confidence = 'low';
    unknown.consent.banner_visible = null;
    expect(check(unknown)?.status).toBe('not_applicable');

    const sharedVisible = fixture();
    sharedVisible.runtime.consent_v2!.banner_visibility = 'unknown';
    sharedVisible.consent.banner_visible = true;
    expect(check(sharedVisible)?.status).toBe('pass');

    const noControl = fixture();
    noControl.diagnostic_observability!.consent_observations[0].visible_controls = [];
    noControl.consent.banner_visible = null;
    expect(check(noControl)?.status).toBe('mismatch');
  });

  it('OBS-CONTROL-GAP-01 through OBS-CONTROL-GAP-03 and OBS-SIGNATURE-01 through OBS-SIGNATURE-02 stay diagnostic only', () => {
    const check = (evidence: ReturnType<typeof fixture>, code: string) => buildObservabilityConsistency(audit(evidence), evidence).checks.find((item) => item.code === code)?.status;
    const gap = fixture(); gap.diagnostic_observability!.consent_observations[0].visible_controls = [];
    expect(check(gap, 'OBS_CONSENT_CONTROL_EXTRACTION_GAP')).toBe('mismatch');
    expect(check(fixture(), 'OBS_CONSENT_CONTROL_EXTRACTION_GAP')).toBe('pass');
    const inline = fixture(); inline.diagnostic_observability!.consent_observations[0].visible_surfaces[0].strong_presentation = false;
    expect(check(inline, 'OBS_CONSENT_CONTROL_EXTRACTION_GAP')).toBe('not_applicable');
    const signature = fixture(); signature.diagnostic_observability!.consent_observations[0].provider_selection.candidates[0] = { provider: 'usercentrics', detection_status: 'identified', confidence: 'high', deterministic_provider_signature: true, independent_evidence_families: ['provider_asset'], evidence_codes: ['unique_provider_script_or_config'] };
    signature.diagnostic_observability!.consent_observations[0].provider_selection.selected_provider = 'usercentrics'; signature.consent.resolved_provider = 'Usercentrics'; signature.decision_summary!.find((item) => item.decision_name === 'cmp')!.status = 'Usercentrics';
    expect(check(signature, 'OBS_CONSENT_PROVIDER_SIGNATURE_MISMATCH')).toBe('pass');
    signature.consent.resolved_provider = null; signature.decision_summary!.find((item) => item.decision_name === 'cmp')!.status = null;
    expect(check(signature, 'OBS_CONSENT_PROVIDER_SIGNATURE_MISMATCH')).toBe('mismatch');
    for (const deterministicProvider of ['cookiebot', 'didomi'] as const) {
      const providerSignature = fixture();
      providerSignature.diagnostic_observability!.consent_observations[0].provider_selection.candidates[0] = { provider: deterministicProvider, detection_status: 'identified', confidence: 'high', deterministic_provider_signature: true, independent_evidence_families: ['provider_asset'], evidence_codes: ['unique_provider_script_or_config'] };
      providerSignature.diagnostic_observability!.consent_observations[0].provider_selection.selected_provider = deterministicProvider;
      const canonicalProvider = deterministicProvider === 'cookiebot' ? 'Cookiebot' : 'Didomi';
      providerSignature.consent.resolved_provider = canonicalProvider;
      providerSignature.decision_summary!.find((item) => item.decision_name === 'cmp')!.status = canonicalProvider;
      expect(check(providerSignature, 'OBS_CONSENT_PROVIDER_SIGNATURE_MISMATCH')).toBe('pass');
    }
  });

  it('OBS-PRODUCT-01 through OBS-PRODUCT-05 expose only capped sanitized rejections', () => {
    const output = JSON.parse(String(buildDebugPackageFiles(audit())['product-rejections.json']));
    expect(output).toMatchObject({ observed_count: 14, retained_count: 12, truncated: true });
    expect(output.candidates.every((candidate: { sanitized_url: string }) => !candidate.sanitized_url.includes('?') && !candidate.sanitized_url.includes('#'))).toBe(true);
  });

  it('OBS-DECISION-01 through OBS-DECISION-03 expose canonical provenance and completeness', () => {
    const evidence = fixture();
    const provenance = buildDecisionProvenance(audit(evidence), evidence);
    expect(provenance).toHaveLength(6);
    expect(provenance.find((item) => item.decision_name === 'consent')).toMatchObject({ reason_code: 'FIXTURE', source: 'canonical_replay', ignored_evidence: 'not_recorded' });
    expect(provenance.find((item) => item.decision_name === 'server_side')?.relevant_observation_state).toHaveProperty('server_passive_classification_complete');
  });

  it('decision-equivalence keeps canonical replay outputs unchanged by diagnostic projections', () => {
    const normal = replayEvidence(fixture('normal'));
    const diagnostic = replayEvidence(fixture('diagnostic'));
    for (const field of ['consent_status', 'cmp_provider', 'product_payload_status', 'pdp_url_tested', 'site_ga4_detected', 'site_meta_detected', 'server_side_status', 'overall_status'] as const) expect(diagnostic[field]).toEqual(normal[field]);
  });

  it('keeps additional structured observability within the 32 KB diagnostic budget', () => {
    const files = buildDebugPackageFiles(audit());
    const names = ['consent-observations.json', 'diagnostic-captures.json', 'observability-consistency.json', 'product-rejections.json', 'decision-provenance.json'];
    const bytes = names.reduce((total, name) => total + Buffer.byteLength(String(files[name]), 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(32 * 1024);
  });
});
