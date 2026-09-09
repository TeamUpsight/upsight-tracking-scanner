import type { CmpProvider, CmsPlatform, EvidenceBundle, StorefrontAudit } from '../../types';
import { detectCMP } from '../consent/detect-cmp';
import { classifyCollection } from '../server-side/classify-collection';
import { resolveConsentStatus, resolveOverallStatus, resolveProductPayloadStatus } from '../resolver/status-resolver';
import { accessEvidenceViolations, enforceConsistency } from './consistency';
import { calculateQaPriority, generateFailureFingerprints } from './fingerprints';
import { selectedAuditModules } from '../../audit-modules';

function cmsFromSignals(signals: string[]): CmsPlatform {
  const text = signals.join(' ').toLowerCase();
  if (text.includes('shopify')) return 'Shopify';
  if (text.includes('woocommerce') || text.includes('wp-content')) return 'WooCommerce';
  if (text.includes('magento') || text.includes('mage.cookies')) return 'Magento';
  if (text.includes('bigcommerce')) return 'BigCommerce';
  if (text.includes('webflow')) return 'Webflow';
  return signals.length > 0 ? 'Custom' : 'Unknown';
}

/**
 * Replay only consumes the normalized, bounded EvidenceBundle contract produced
 * by EvidenceCollector.  Copy the mutable leaves that quality rules may need to
 * canonicalize so an API replay/review can never mutate stored evidence in
 * memory.  Older evidence omitted selected_modules; that remains equivalent to
 * explicitly selecting every module.
 */
export function normalizeReplayEvidence(source: EvidenceBundle): EvidenceBundle {
  const access = source.access || {
    valid_storefront: source.page.valid,
    final_url: source.page.final_url,
    http_status: source.page.status_code,
    access_attempt_count: source.runtime.proxy_attempts?.length || 0,
    initial_provider: source.runtime.proxy_initial_provider || 'decodo',
    final_provider: source.runtime.proxy_final_provider || 'decodo',
    proxy_fallback_used: Boolean(source.runtime.proxy_fallback_used),
    proxy_fallback_recovered: Boolean(source.runtime.proxy_fallback_recovered),
    challenge_detected: Boolean(source.page.bot_provider),
    challenge_type: source.page.access_category === 'rate_limited' ? 'rate_limit' as const : null,
    challenge_solver_used: Boolean(source.runtime.bql_escalation_attempted),
    challenge_solver_result: source.runtime.bql_escalation_succeeded ? 'succeeded' as const : 'not_used' as const,
    time_to_valid_storefront_ms: null,
    proxy_attempts: []
  };
  return {
    ...source,
    decision_summary: source.decision_summary ? source.decision_summary.map((decision) => ({ ...decision, evidence_codes: [...decision.evidence_codes], blocking_uncertainty: [...decision.blocking_uncertainty] })) : undefined,
    selected_modules: selectedAuditModules(source.selected_modules),
    access: { ...access, proxy_attempts: [...access.proxy_attempts] },
    page: { ...source.page, cms_signals: [...source.page.cms_signals] },
    network: {
      ...source.network,
      relevant_requests: [...source.network.relevant_requests],
      installation_signals: [...(source.network.installation_signals || [])],
      observation: source.network.observation ? { ...source.network.observation, capture_channel_errors: [...source.network.observation.capture_channel_errors] } : undefined,
      novel_endpoints: [...source.network.novel_endpoints]
    },
    consent: { ...source.consent },
    product: {
      ...source.product,
      pdp_candidates: [...source.product.pdp_candidates],
      ga4_view_item_hits: [...source.product.ga4_view_item_hits],
      data_layer_view_item_hits: [...(source.product.data_layer_view_item_hits || [])],
      meta_view_content_hits: [...source.product.meta_view_content_hits],
      candidate_outcomes: [...(source.product.candidate_outcomes || [])],
      observation: source.product.observation ? { ...source.product.observation } : undefined
    },
    server_side: { ...source.server_side },
    runtime: {
      ...source.runtime,
      proxy_attempts: [...(source.runtime.proxy_attempts || [])],
      module_durations_ms: { ...source.runtime.module_durations_ms },
      screenshots: [...source.runtime.screenshots]
    }
  };
}

export function replayEvidence(source: EvidenceBundle): Partial<StorefrontAudit> {
  const evidence = normalizeReplayEvidence(source);
  // Older bundles did not have the access section.  Their normalized fallback
  // mirrors the recorded page fields.  New bundles retain both fact sets so
  // replay can flag contradictions instead of replacing browser observations.
  if (!source.access) {
    if (evidence.access.valid_storefront !== null) evidence.page.valid = evidence.access.valid_storefront;
    if (evidence.access.final_url) evidence.page.final_url = evidence.access.final_url;
    if (evidence.access.http_status !== null) evidence.page.status_code = evidence.access.http_status;
  }
  const selected_modules = selectedAuditModules(evidence.selected_modules);
  const consentSelected = selected_modules.includes('consent');
  const trackingSelected = selected_modules.includes('tracking');
  const serverSelected = selected_modules.includes('server_side');
  const requests = evidence.network.relevant_requests;
  const requestObservationComplete = evidence.network.observation?.request_listener_active === true &&
    evidence.network.observation?.request_capture_completed === true;
  const networkObservationComplete = requestObservationComplete &&
    evidence.network.observation?.request_capture_completed === true &&
    evidence.network.observation?.data_layer_capture_completed === true &&
    evidence.network.observation?.performance_capture_completed === true;
  const ga4 = requests.filter((request) => request.vendor === 'ga4');
  const ga4Collections = ga4.filter((request) => request.kind === 'collection');
  const dataLayerViewItems = evidence.product.data_layer_view_item_hits || [];
  // Installation, collection, and product semantics intentionally remain
  // separate: a script does not prove collection, and collection does not
  // prove view_item.
  const ga4Installed = ga4.some((request) => request.kind === 'script' || request.kind === 'collection') || dataLayerViewItems.length > 0;
  const meta = requests.filter((request) => request.vendor === 'meta');
  const metaCollections = meta.filter((request) => request.kind === 'collection');
  const metaInstallationSignals = (evidence.network.installation_signals || []).filter((signal) => signal.vendor === 'meta');
  const metaInstalled = meta.length > 0 || metaInstallationSignals.length > 0;
  const measurementIds = [...new Set([...ga4, ...dataLayerViewItems].map((hit) => hit.measurement_id).filter(Boolean))] as string[];
  const pdpPaths = [evidence.product.final_pdp_url, evidence.product.pdp_url, evidence.product.candidate_url]
    .flatMap((url) => {
      try { return url ? [new URL(url).pathname.replace(/\/+$/, '')] : []; } catch { return []; }
    });
  const pdpGa4CollectionObserved = ga4Collections.some((request) => {
    if (!request.phase.includes('product_pdp')) return false;
    if (!request.page_url || !pdpPaths.length) return true;
    try { return pdpPaths.includes(new URL(request.page_url).pathname.replace(/\/+$/, '')); } catch { return false; }
  });
  const trackingEnablement = evidence.consent.tracking_enablement || 'not_needed';
  const legacyEnablementInconclusive = evidence.consent.acceptance_attempted === true && evidence.consent.acceptance_verified !== true;
  const trackingEnablementValid = !legacyEnablementInconclusive && ['not_needed', 'already_enabled', 'accepted'].includes(trackingEnablement) || pdpGa4CollectionObserved;
  const trackingObservationEligible = networkObservationComplete && trackingEnablementValid;

  const detectedCmp = consentSelected && evidence.consent.executed
    ? detectCMP({
      dom_selectors: evidence.consent.dom_selectors,
      script_urls: evidence.consent.script_hosts,
      network_hosts: evidence.consent.network_signals || [],
      cookie_names: evidence.consent.cookie_names,
      window_globals: evidence.consent.window_globals,
      iframe_urls: evidence.consent.iframe_hosts,
      banner_visible: evidence.consent.banner_visible
    })
    : { provider: null as CmpProvider | null, confidence: 'low' as const, evidence: [], banner_visible: null, reason_code: 'CMP_NOT_TESTED' };
  const cmp = evidence.consent.resolved_provider !== undefined
    ? { provider: evidence.consent.resolved_provider, confidence: evidence.consent.resolved_provider_confidence || 'medium' as const, evidence: evidence.consent.resolved_provider_evidence || detectedCmp.evidence, banner_visible: detectedCmp.banner_visible, reason_code: evidence.consent.resolved_provider === 'Unknown' ? 'CMP_PROVIDER_UNKNOWN' : 'CMP_PROVIDER_IDENTIFIED' }
    : detectedCmp;

  const preChoiceCollections = requests.filter((request) => request.kind === 'collection' && request.phase.includes('consent_initial'));
  const before = evidence.consent.pre_choice_measurement ?? (preChoiceCollections.some((request) => request.consent_measurement === 'full_measurement')
    ? 'full_measurement' as const
    : preChoiceCollections.some((request) => request.consent_measurement === 'limited_measurement') || evidence.network.observation?.limited_measurement_observed
      ? 'limited_measurement' as const
      : preChoiceCollections.length > 0 ? 'unknown' as const : false);
  const afterReject = requests.some((request) => request.kind === 'collection' && request.phase.includes('post_reject'));
  const consent = consentSelected ? resolveConsentStatus({
    executed: evidence.consent.executed,
    page_valid: evidence.page.valid,
    geo: evidence.geo,
    cmp_provider: cmp.provider,
    tracking_before_interaction: before,
    rejection_attempted: evidence.consent.interaction_attempted,
    rejection_verified: evidence.consent.rejection_verified,
    post_reject_observation_completed: evidence.consent.post_reject_observation_completed,
    tracking_after_verified_rejection: evidence.consent.rejection_verified && afterReject,
    technical_blocker_reason: evidence.consent.technical_blocker_reason
  }) : { status: 'not_tested' as const, confidence: 'low' as const, evidence: [], reason_code: 'CONSENT_NOT_TESTED' };
  const candidateOutcomes = evidence.product.candidate_outcomes || [];
  const positiveProductEvidence = [...evidence.product.ga4_view_item_hits, ...dataLayerViewItems].some((hit) => hit.event === 'view_item' && hit.has_product) ||
    candidateOutcomes.some((candidate) => candidate.semantic_result === 'VALID_PRODUCT' || candidate.outcome === 'VALID_PRODUCT_WITH_VIEW_ITEM' || candidate.outcome === 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM');
  const productApplicability = positiveProductEvidence ? 'applicable' : evidence.product.applicability || (evidence.product.pdp_candidates.length > 0 || evidence.product.pdp_url ? 'applicable' : 'inconclusive');
  evidence.product.applicability = productApplicability;
  const relevantCandidates = candidateOutcomes.filter((candidate) => !(candidate.outcome === 'INVALID_PRODUCT' && candidate.semantic_result === 'INVALID_PRODUCT' && candidate.observation_complete === true) && candidate.page_role !== 'PRODUCT_LISTING' && candidate.outcome !== 'PRODUCT_LISTING');
  const candidateObservationComplete = relevantCandidates.length > 0
    ? relevantCandidates.every((candidate) => candidate.observation_complete === true &&
      ['VALID_PRODUCT_WITH_VIEW_ITEM', 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM'].includes(candidate.outcome))
    : candidateOutcomes.length === 0 && evidence.product.observation?.minimum_observation_satisfied === true &&
      evidence.product.observation.transport_failure !== true && evidence.product.observation.timeout !== true;
  const completeNegativeCandidateCount = relevantCandidates.filter((candidate) =>
    candidate.outcome === 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM' && candidate.observation_complete === true
  ).length;
  const product = trackingSelected ? resolveProductPayloadStatus({
    executed: evidence.product.executed,
    page_valid: evidence.page.valid,
    pdp_found: evidence.product.pdp_candidates.length > 0 || Boolean(evidence.product.pdp_url),
    pdp_navigation_succeeded: evidence.product.navigation_succeeded,
    consent_status: trackingEnablementValid ? consent.status : 'inconclusive',
    site_ga4_detected: ga4Installed ? true : trackingObservationEligible ? false : null,
    site_ga4_collection_hit_detected: ga4Collections.length > 0 ? true : trackingObservationEligible ? false : null,
    view_item_hits: [...evidence.product.ga4_view_item_hits, ...dataLayerViewItems],
    runtime_failure: evidence.runtime.failed_phase?.startsWith('product_') === true,
    pdp_discovery_completed: evidence.product.discovery_inconclusive === true ? false : evidence.product.discovery_completed === true ? true : undefined,
    pdp_observation_complete: candidateObservationComplete,
    // Two complete, candidate-local negative checkpoints are sufficient
    // product evidence even when an optional consent comparison is unresolved.
    ga4_observation_complete: (trackingObservationEligible || completeNegativeCandidateCount >= 2) && candidateObservationComplete,
    product_applicability: productApplicability,
    candidate_outcomes: candidateOutcomes
  }) : { status: 'not_tested' as const, confidence: 'low' as const, evidence: [], reason_code: 'PRODUCT_NOT_TESTED' };
  const server = serverSelected ? classifyCollection({
    executed: evidence.server_side.executed,
    page_valid: evidence.page.valid,
    requests,
    collector_cookie_detected: evidence.server_side.collector_cookie_names.length > 0,
    collector_cookie_persisted: evidence.server_side.collector_cookie_persisted,
    observation_complete: evidence.server_side.passive_classification_completed === true && requestObservationComplete
  }) : { status: 'not_tested' as const, collection_type: 'not_tested' as const, reason_code: 'SERVER_NOT_TESTED' };
  const base: Partial<StorefrontAudit> = {
    audit_id: evidence.audit_id,
    domain: evidence.domain,
    tested_geos: evidence.geo,
    scan_mode: evidence.mode,
    selected_modules,
    scan_status: evidence.page.access_category === 'cancelled'
      ? 'cancelled'
      : evidence.page.access_category !== 'none' || evidence.page.valid !== true ? 'failed' : 'completed',
    error_category: evidence.page.access_category,
    cms_platform_detected: cmsFromSignals(evidence.page.cms_signals),
    consent_status: consent.status,
    cmp_provider: consentSelected ? cmp.provider : null,
    product_payload_status: product.status,
    pdp_url_tested: trackingSelected ? evidence.product.final_pdp_url || evidence.product.pdp_url : null,
    server_side_status: server.status,
    ss_collection_type: server.collection_type,
    site_ga4_detected: trackingSelected && evidence.page.valid === true ? ga4Installed ? true : trackingObservationEligible ? false : null : null,
    site_ga4_measurement_ids: trackingSelected ? measurementIds : [],
    site_ga4_collection_hit_detected: trackingSelected && evidence.page.valid === true ? ga4Collections.length > 0 ? true : trackingObservationEligible ? false : null : null,
    site_meta_detected: trackingSelected && evidence.page.valid === true ? metaInstalled ? true : trackingObservationEligible ? false : null : null,
    site_meta_collection_hit_detected: trackingSelected && evidence.page.valid === true ? metaCollections.length > 0 ? true : trackingObservationEligible ? false : null : null,
    finding_confidence: {
      cmp: { detected: consentSelected && evidence.consent.executed ? cmp.provider === 'Not Found' ? false : cmp.provider ? true : null : null, confidence: cmp.confidence, evidence: cmp.evidence, reason_code: cmp.reason_code },
      consent: { status: consent.status, confidence: consent.confidence, evidence: consent.evidence, reason_code: consent.reason_code },
      ga4: {
        detected: trackingSelected && evidence.page.valid === true ? ga4Installed ? true : trackingObservationEligible ? false : null : null,
        confidence: ga4Collections.length > 0 || dataLayerViewItems.length > 0 ? 'high' : ga4.length > 0 ? 'medium' : 'low',
        evidence: ga4Collections.length > 0 ? ['network_hit'] : dataLayerViewItems.length > 0 ? ['data_layer'] : ga4.length > 0 ? ['script'] : [],
        reason_code: evidence.page.valid !== true || !trackingEnablementValid ? 'GA4_NOT_TESTED' : ga4Collections.length > 0 ? 'GA4_COLLECTION_DETECTED' : dataLayerViewItems.length > 0 ? 'GA4_DATALAYER_EVENT' : ga4.length > 0 ? 'GA4_SCRIPT_ONLY' : trackingObservationEligible ? 'GA4_NOT_DETECTED' : 'GA4_OBSERVATION_INCOMPLETE'
      },
      product: { status: product.status, confidence: product.confidence, evidence: product.evidence, reason_code: product.reason_code },
      meta: {
        detected: trackingSelected && evidence.page.valid === true ? metaInstalled ? true : trackingObservationEligible ? false : null : null,
        confidence: metaCollections.length > 0 ? 'high' : metaInstalled ? 'medium' : 'low',
        evidence: metaCollections.length > 0 ? ['network_hit'] : meta.length > 0 ? ['script'] : metaInstallationSignals.map((signal) => signal.source),
        reason_code: evidence.page.valid !== true || !trackingEnablementValid ? 'META_NOT_TESTED' : metaCollections.length > 0 ? 'META_COLLECTION_DETECTED' : metaInstalled ? 'META_SCRIPT_ONLY' : trackingObservationEligible ? 'META_NOT_DETECTED' : 'META_OBSERVATION_INCOMPLETE'
      },
      server_side: { status: server.status, confidence: server.status === 'strong_server_side_evidence' ? 'high' : server.status === 'inconclusive' ? 'low' : 'medium', evidence: [server.reason_code], reason_code: server.reason_code }
    },
    reason_codes: [consentSelected ? cmp.reason_code : null, consentSelected ? consent.reason_code : null, trackingSelected ? product.reason_code : null, serverSelected ? server.reason_code : null].filter(Boolean) as string[]
  };
  const overall = resolveOverallStatus({
    consent_status: consent.status,
    product_status: product.status,
    server_status: server.status,
    collection_type: server.collection_type,
    error_category: base.error_category || 'none',
    selected_modules
  });
  base.overall_status = overall.status;
  base.overall_confidence = overall.confidence;
  const accessViolations = accessEvidenceViolations(evidence);
  const consistency = enforceConsistency(base, evidence);
  const corrected = { ...base, ...consistency.audit };
  // Consistency may conservatively downgrade a correlated decision. Re-resolve
  // the aggregate and the exported reason list from that final object only.
  const finalOverall = resolveOverallStatus({
    consent_status: corrected.consent_status ?? null,
    product_status: corrected.product_payload_status ?? null,
    server_status: corrected.server_side_status ?? null,
    collection_type: corrected.ss_collection_type ?? null,
    error_category: corrected.error_category || 'none',
    selected_modules
  });
  corrected.overall_status = finalOverall.status;
  corrected.overall_confidence = finalOverall.confidence;
  corrected.reason_codes = [...new Set([
    ...(corrected.reason_codes || []),
    ...Object.entries(corrected.finding_confidence || {})
      .filter(([name]) => (name === 'cmp' || name === 'consent') ? consentSelected : (name === 'ga4' || name === 'meta' || name === 'product') ? trackingSelected : name === 'server_side' ? serverSelected : false)
      .map(([, finding]) => finding.reason_code).filter(Boolean)
  ])];
  const decision = (decision_name: string, status: string | boolean | null, finding: StorefrontAudit['finding_confidence'][keyof StorefrontAudit['finding_confidence']] | undefined, applicable: boolean | null, observation_complete: boolean | null) => {
    const positiveProof = status === true || ['pass', 'prior_consent_violation', 'strong_server_side_evidence', 'likely_server_side', 'first_party_collection_detected'].includes(String(status));
    const uncertaintyByDecision: Record<string, string> = { consent: 'CONSENT_OBSERVATION_INCOMPLETE', cmp: 'CMP_OBSERVATION_INCOMPLETE', product_payload: 'PDP_OBSERVATION_INCOMPLETE', ga4: 'GA4_OBSERVATION_INCOMPLETE', meta: 'META_OBSERVATION_INCOMPLETE', server_side: 'SERVER_OBSERVATION_INCOMPLETE' };
    return {
    decision_name, status, confidence: finding?.confidence || 'low', reason_code: finding?.reason_code || 'NOT_TESTED', applicable, observation_complete,
    evidence_codes: finding?.evidence || [], blocking_uncertainty: observation_complete === false && !positiveProof ? [uncertaintyByDecision[decision_name] || 'OBSERVATION_INCOMPLETE'] : [],
    ...(decision_name === 'product_payload' ? { candidate_counters: {
      discovered: evidence.product.candidate_discovered_count ?? 0,
      queued: evidence.product.candidate_queued_count ?? 0,
      promoted: evidence.product.candidate_promoted_count ?? 0,
      attempted: evidence.product.candidate_attempted_count ?? 0,
      completed: evidence.product.candidate_completed_count ?? 0
    } } : {})
    };
  };
  evidence.decision_summary = [
    decision('consent', corrected.consent_status ?? null, corrected.finding_confidence?.consent, consentSelected, evidence.consent.post_reject_observation_completed),
    decision('cmp', corrected.cmp_provider ?? null, corrected.finding_confidence?.cmp, consentSelected, evidence.consent.executed),
    decision('product_payload', corrected.product_payload_status ?? null, corrected.finding_confidence?.product, evidence.product.applicability === 'applicable', candidateObservationComplete),
    decision('ga4', corrected.site_ga4_detected ?? null, corrected.finding_confidence?.ga4, trackingSelected, trackingObservationEligible),
    decision('meta', corrected.site_meta_detected ?? null, corrected.finding_confidence?.meta, trackingSelected, trackingObservationEligible),
    decision('server_side', corrected.server_side_status ?? null, corrected.finding_confidence?.server_side, serverSelected, evidence.server_side.passive_classification_completed === true && requestObservationComplete)
  ];
  const violations = [...new Set([...accessViolations, ...consistency.violations])];
  corrected.consistency_violations = violations;
  corrected.failure_fingerprints = generateFailureFingerprints(corrected, evidence, violations);
  corrected.qa_priority = calculateQaPriority(corrected, evidence, violations);
  corrected.evidence_bundle = evidence;
  corrected.runtime_metrics = evidence.runtime;
  return corrected;
}

export function compareReplay(previous: Partial<StorefrontAudit> | null, next: Partial<StorefrontAudit>) {
  const fields: Array<keyof StorefrontAudit> = [
    'consent_status', 'cmp_provider', 'site_ga4_detected', 'site_ga4_collection_hit_detected',
    'product_payload_status', 'server_side_status', 'ss_collection_type', 'overall_status', 'selected_modules'
  ];
  const changes = fields.flatMap((field) => {
    const before = previous?.[field];
    const after = next[field];
    return before === after ? [] : [{ field, previous: before ?? null, next: after ?? null }];
  });
  return { changed: changes.length > 0, changes };
}
