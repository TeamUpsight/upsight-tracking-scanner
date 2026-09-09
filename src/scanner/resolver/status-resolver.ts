import type {
  CollectionType,
  Confidence,
  ConsentStatus,
  ProductPayloadStatus,
  ServerSideStatus,
  AuditModule,
  TrackingRequestEvidence
} from '../../types';

export interface StatusDecision<T> {
  status: T;
  confidence: Confidence;
  reason_code: string;
  evidence: string[];
}

export function resolveConsentStatus(input: {
  executed: boolean;
  page_valid: boolean | null;
  geo: 'USA' | 'EU' | 'UK';
  cmp_provider: string | null;
  /** Limited/denied Consent Mode pings do not establish a pre-choice violation. */
  tracking_before_interaction: boolean | 'full_measurement' | 'limited_measurement' | 'unknown';
  rejection_attempted: boolean;
  rejection_verified: boolean;
  post_reject_observation_completed?: boolean;
  tracking_after_verified_rejection: boolean;
  technical_blocker_reason?: string;
}): StatusDecision<ConsentStatus> {
  if (input.page_valid !== true) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'ACCESS_BLOCKED', evidence: ['page_invalid'] };
  }
  if (!input.executed) {
    return { status: 'not_tested', confidence: 'low', reason_code: 'CONSENT_NOT_TESTED', evidence: [] };
  }
  const fullMeasurementBeforeInteraction = input.tracking_before_interaction === true || input.tracking_before_interaction === 'full_measurement';
  // A full pre-choice collection is a complete, higher-priority semantic fact.
  // It must not be hidden by an incomplete later Reject interaction.
  if ((input.geo === 'EU' || input.geo === 'UK') && fullMeasurementBeforeInteraction && input.cmp_provider && input.cmp_provider !== 'Not Found') {
    return { status: 'prior_consent_violation', confidence: 'high', reason_code: 'CMP_TRACKING_BEFORE_INTERACTION', evidence: ['cmp_detected', 'pre_interaction_collection'] };
  }
  if ((input.geo === 'EU' || input.geo === 'UK') && fullMeasurementBeforeInteraction && input.cmp_provider === 'Not Found') {
    return { status: 'missing', confidence: 'medium', reason_code: 'CMP_NOT_DETECTED_WITH_TRACKING', evidence: ['pre_interaction_collection'] };
  }
  if (input.technical_blocker_reason) {
    return { status: 'inconclusive', confidence: 'low', reason_code: input.technical_blocker_reason, evidence: ['consent_v2_technical_blocker'] };
  }
  if (input.tracking_before_interaction === 'limited_measurement' || input.tracking_before_interaction === 'unknown') {
    // Evidence is intentionally preserved by callers; this only prevents an
    // ambiguous Consent Mode request becoming a definitive compliance finding.
    if (input.rejection_attempted && !input.rejection_verified) {
      return { status: 'inconclusive', confidence: 'low', reason_code: 'CMP_REJECT_NOT_VERIFIED', evidence: ['rejection_attempted'] };
    }
  }
  if (input.rejection_verified && input.tracking_after_verified_rejection) {
    return { status: 'consent_leakage', confidence: 'high', reason_code: 'CMP_REJECT_TRACKING_OBSERVED', evidence: ['verified_rejection', 'post_reject_collection'] };
  }
  if (input.rejection_verified && input.post_reject_observation_completed === false) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'CMP_POST_REJECT_OBSERVATION_FAILED', evidence: ['verified_rejection'] };
  }
  if (input.rejection_attempted && !input.rejection_verified) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'CMP_REJECT_NOT_VERIFIED', evidence: ['rejection_attempted'] };
  }
  if (!input.cmp_provider || input.cmp_provider === 'Unknown') {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'CMP_UNKNOWN', evidence: [] };
  }
  if (input.cmp_provider === 'Not Found') {
    return { status: 'not_detected', confidence: fullMeasurementBeforeInteraction ? 'low' : 'medium', reason_code: 'CMP_NOT_DETECTED', evidence: [] };
  }
  // Provider recognition is evidence of identity, never evidence that the
  // selected Reject audit actually happened.
  if (!input.rejection_attempted || !input.rejection_verified || input.post_reject_observation_completed !== true) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'CMP_BEHAVIOR_NOT_VERIFIED', evidence: ['cmp_detected'] };
  }
  return { status: 'pass', confidence: 'high', reason_code: 'CMP_BEHAVIOR_OBSERVED', evidence: ['cmp_detected', 'reject_verified', 'post_reject_observation_complete'] };
}

export function resolveProductPayloadStatus(input: {
  executed: boolean;
  page_valid: boolean | null;
  pdp_found: boolean;
  pdp_navigation_succeeded: boolean;
  consent_status: ConsentStatus | null;
  site_ga4_detected: boolean | null;
  site_ga4_collection_hit_detected: boolean | null;
  view_item_hits: TrackingRequestEvidence[];
  runtime_failure?: boolean;
  pdp_discovery_completed?: boolean;
  pdp_observation_complete?: boolean;
  ga4_observation_complete?: boolean;
  product_applicability?: 'applicable' | 'not_applicable' | 'inconclusive';
  candidate_outcomes?: Array<{ outcome: string; observation_complete?: boolean; page_role?: string }>;
}): StatusDecision<ProductPayloadStatus> {
  if (!input.executed) {
    return { status: 'not_tested', confidence: 'low', reason_code: 'PRODUCT_NOT_TESTED', evidence: [] };
  }
  if (input.page_valid !== true) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'ACCESS_BLOCKED', evidence: ['page_invalid'] };
  }
  if (input.product_applicability === 'not_applicable') {
    return { status: 'not_tested', confidence: 'medium', reason_code: 'PRODUCT_NOT_APPLICABLE', evidence: ['applicability_completed'] };
  }
  if (input.product_applicability === 'inconclusive') {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'PRODUCT_APPLICABILITY_INCONCLUSIVE', evidence: ['applicability_incomplete'] };
  }
  if (!input.pdp_found && input.pdp_discovery_completed === true && input.product_applicability === 'applicable') {
    return { status: 'pdp_not_found', confidence: 'medium', reason_code: 'PDP_NOT_FOUND', evidence: ['discovery_completed'] };
  }
  if (!input.pdp_found) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'PDP_DISCOVERY_INCONCLUSIVE', evidence: ['discovery_incomplete'] };
  }
  if (!input.pdp_navigation_succeeded) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'PDP_NAV_TIMEOUT', evidence: ['pdp_navigation_failed'] };
  }

  const valid = input.view_item_hits.find((hit) => hit.event === 'view_item' && hit.has_product);
  if (valid) {
    const sourceEvidence = valid.kind === 'data_layer' ? 'data_layer' : 'ga4_collection';
    return {
      status: 'pass',
      confidence: 'high',
      reason_code: 'GA4_VIEW_ITEM_VALID',
      evidence: [sourceEvidence, 'view_item', valid.product_id ? 'product_id' : 'product_data']
    };
  }
  if (input.view_item_hits.some((hit) => hit.event === 'view_item')) {
    return { status: 'incomplete_view_item', confidence: 'high', reason_code: 'GA4_VIEW_ITEM_INCOMPLETE', evidence: ['view_item'] };
  }
  if (input.runtime_failure) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'PRODUCT_RUNTIME_FAILED', evidence: ['runtime_failure'] };
  }
  const productCandidates = input.candidate_outcomes?.filter((candidate) => candidate.page_role !== 'PRODUCT_LISTING' && candidate.outcome !== 'PRODUCT_LISTING') || [];
  const requiredCandidatesComplete = productCandidates.length
    ? productCandidates.every((candidate) => candidate.outcome === 'VALID_PRODUCT_WITH_VIEW_ITEM' || candidate.outcome === 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM') &&
      productCandidates.every((candidate) => candidate.observation_complete === true)
    : input.pdp_observation_complete === true;
  if (input.pdp_observation_complete !== true || !requiredCandidatesComplete) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'PDP_OBSERVATION_INCOMPLETE', evidence: ['observation_incomplete'] };
  }
  if (input.consent_status === 'inconclusive') {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'CONSENT_INCONCLUSIVE', evidence: [] };
  }
  if ((input.site_ga4_detected || input.site_ga4_collection_hit_detected) && input.ga4_observation_complete === true) {
    return {
      status: 'missing_view_item',
      confidence: input.site_ga4_collection_hit_detected ? 'high' : 'medium',
      reason_code: 'GA4_NO_VIEW_ITEM',
      evidence: [input.site_ga4_collection_hit_detected ? 'ga4_collection' : 'ga4_script']
    };
  }
  if (input.ga4_observation_complete !== true) {
    return { status: 'inconclusive', confidence: 'low', reason_code: 'GA4_OBSERVATION_INCOMPLETE', evidence: ['capture_incomplete'] };
  }
  return { status: 'ga4_not_detected', confidence: 'medium', reason_code: 'GA4_NOT_DETECTED', evidence: [] };
}

export function resolveOverallStatus(input: {
  consent_status: ConsentStatus | null;
  product_status: ProductPayloadStatus | null;
  server_status: ServerSideStatus | null;
  collection_type: CollectionType | null;
  error_category: string;
  selected_modules?: AuditModule[];
}): { status: 'pass' | 'warning' | 'fail' | 'inconclusive'; confidence: Confidence } {
  const selected = input.selected_modules || ['consent', 'tracking', 'server_side'];
  if (input.error_category !== 'none') return { status: 'inconclusive', confidence: 'low' };
  const moduleStatuses = [
    selected.includes('consent') ? input.consent_status : undefined,
    selected.includes('tracking') ? input.product_status : undefined,
    selected.includes('server_side') ? input.server_status : undefined
  ];
  if (moduleStatuses.some((value) => value === 'inconclusive' || value === 'not_tested' || value === null)) {
    return { status: 'inconclusive', confidence: 'low' };
  }
  const fail = selected.includes('consent') && (input.consent_status === 'consent_leakage' || input.consent_status === 'prior_consent_violation' || input.consent_status === 'missing') ||
    selected.includes('tracking') && (input.product_status === 'missing_view_item' || input.product_status === 'incomplete_view_item') ||
    selected.includes('server_side') && input.server_status === 'partial_or_misconfigured';
  if (fail) return { status: 'fail', confidence: 'high' };
  const warning = selected.includes('tracking') && (input.product_status === 'ga4_not_detected' || input.product_status === 'pdp_not_found') ||
    selected.includes('server_side') && input.server_status === 'not_detected' ||
    selected.includes('consent') && input.consent_status === 'not_detected';
  return { status: warning ? 'warning' : 'pass', confidence: warning ? 'medium' : 'high' };
}
