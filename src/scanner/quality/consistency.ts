import type { EvidenceBundle, StorefrontAudit } from '../../types';
import { includesAuditModule } from '../../audit-modules';

function normalizedUrl(value: string | null) {
  try {
    if (!value) return null;
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return value;
  }
}

/** Access observations are facts, not replay corrections. */
export function accessEvidenceViolations(evidence: EvidenceBundle): string[] {
  const access = evidence.access;
  const violations: string[] = [];
  if (access.valid_storefront !== null && evidence.page.valid !== null && access.valid_storefront !== evidence.page.valid) {
    violations.push('ACCESS_VALIDITY_CONTRADICTION');
  }
  if (access.http_status !== null && evidence.page.status_code !== null && access.http_status !== evidence.page.status_code) {
    violations.push('ACCESS_HTTP_STATUS_CONTRADICTION');
  }
  if (access.final_url && evidence.page.final_url && normalizedUrl(access.final_url) !== normalizedUrl(evidence.page.final_url)) {
    violations.push('ACCESS_FINAL_URL_CONTRADICTION');
  }
  if (access.valid_storefront === true && evidence.page.access_category !== 'none') {
    violations.push('ACCESS_SUCCESS_CATEGORY_CONTRADICTION');
  }
  return violations;
}

export interface ConsistencyResult {
  audit: Partial<StorefrontAudit>;
  violations: string[];
  qa_priority_delta: number;
}

export function enforceConsistency(audit: Partial<StorefrontAudit>, evidence: EvidenceBundle): ConsistencyResult {
  const corrected = { ...audit };
  const violations: string[] = accessEvidenceViolations(evidence);
  let priority = 0;
  const networkObservationComplete = evidence.network.observation?.request_listener_active === true &&
    evidence.network.observation?.request_capture_completed === true &&
    evidence.network.observation?.data_layer_capture_completed === true &&
    evidence.network.observation?.performance_capture_completed === true;
  const candidateObservationComplete = (evidence.product.candidate_outcomes || []).length > 0
    ? (evidence.product.candidate_outcomes || []).every((candidate) => candidate.observation_complete === true &&
      ['VALID_PRODUCT_WITH_VIEW_ITEM', 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM'].includes(candidate.outcome))
    : evidence.product.observation?.minimum_observation_satisfied === true &&
      evidence.product.observation.transport_failure !== true && evidence.product.observation.timeout !== true;
  const confidence = { ...(corrected.finding_confidence || {}) };

  const makeUnknown = (key: 'ga4' | 'meta', field: 'site_ga4_detected' | 'site_meta_detected', collectionField: 'site_ga4_collection_hit_detected' | 'site_meta_collection_hit_detected') => {
    if (corrected[field] === false || corrected[collectionField] === false || confidence[key]?.detected === false) {
      corrected[field] = null;
      corrected[collectionField] = null;
      confidence[key] = { ...(confidence[key] || { confidence: 'low', evidence: [] }), detected: null, confidence: 'low', reason_code: `${key.toUpperCase()}_OBSERVATION_INCOMPLETE` };
      violations.push(`${key.toUpperCase()}_FALSE_WITH_INCOMPLETE_OBSERVATION`);
      priority += 35;
    }
  };

  if (includesAuditModule(evidence.selected_modules, 'tracking') && !networkObservationComplete) {
    makeUnknown('ga4', 'site_ga4_detected', 'site_ga4_collection_hit_detected');
    makeUnknown('meta', 'site_meta_detected', 'site_meta_collection_hit_detected');
  }

  if (includesAuditModule(evidence.selected_modules, 'tracking') &&
    ['missing_view_item', 'ga4_not_detected', 'pdp_not_found'].includes(String(corrected.product_payload_status)) &&
    (candidateObservationComplete !== true || evidence.product.applicability !== 'applicable')) {
    corrected.product_payload_status = 'inconclusive';
    confidence.product = { ...(confidence.product || { confidence: 'low', evidence: [] }), status: 'inconclusive', confidence: 'low', reason_code: 'PDP_OBSERVATION_INCOMPLETE' };
    violations.push('PRODUCT_NEGATIVE_WITH_INCOMPLETE_CANDIDATE');
    priority += 40;
  }

  if (includesAuditModule(evidence.selected_modules, 'server_side') && corrected.server_side_status === 'not_detected' &&
    !(evidence.server_side.passive_classification_completed === true && networkObservationComplete)) {
    corrected.server_side_status = 'inconclusive';
    corrected.ss_collection_type = 'inconclusive';
    confidence.server_side = { ...(confidence.server_side || { confidence: 'low', evidence: [] }), status: 'inconclusive', confidence: 'low', reason_code: 'SERVER_OBSERVATION_INCOMPLETE' };
    violations.push('SERVER_NOT_DETECTED_WITH_INCOMPLETE_CAPTURE');
    priority += 35;
  }

  if (includesAuditModule(evidence.selected_modules, 'consent') && corrected.consent_status === 'pass' &&
    (!evidence.consent.interaction_attempted || !evidence.consent.rejection_verified || evidence.consent.post_reject_observation_completed !== true)) {
    corrected.consent_status = 'inconclusive';
    confidence.consent = { ...(confidence.consent || { confidence: 'low', evidence: [] }), status: 'inconclusive', confidence: 'low', reason_code: 'CMP_BEHAVIOR_NOT_VERIFIED' };
    violations.push('CONSENT_PASS_WITHOUT_VERIFIED_BEHAVIOR');
    priority += 40;
  }

  if (corrected.cmp_provider && corrected.cmp_provider !== 'Not Found' && confidence.cmp?.detected === false) {
    confidence.cmp = { ...confidence.cmp, detected: true, reason_code: confidence.cmp.reason_code === 'CMP_NOT_DETECTED' ? 'CMP_PROVIDER_IDENTIFIED' : confidence.cmp.reason_code };
    violations.push('CMP_PROVIDER_CONTRADICTION');
    priority += 35;
  }
  corrected.finding_confidence = confidence;

  if (includesAuditModule(evidence.selected_modules, 'tracking') && corrected.site_ga4_detected === true && corrected.product_payload_status === 'ga4_not_detected') {
    corrected.product_payload_status = corrected.consent_status === 'inconclusive' ? 'inconclusive' : 'missing_view_item';
    violations.push('SITE_GA4_PRODUCT_STATUS_CONTRADICTION');
    priority += 35;
  }

  const metaCollectionSeen = evidence.network.relevant_requests.some((hit) => hit.vendor === 'meta' && hit.kind === 'collection');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && metaCollectionSeen && corrected.site_meta_detected === false) {
    corrected.site_meta_detected = true;
    corrected.site_meta_collection_hit_detected = true;
    violations.push('META_COLLECTION_SUMMARY_CONTRADICTION');
    priority += 35;
  }

  if (includesAuditModule(evidence.selected_modules, 'server_side') && evidence.server_side.first_party_collection_count === 0 && evidence.server_side.collector_cookie_persistence_checked) {
    violations.push('COLLECTOR_COOKIE_CHECK_WITHOUT_COLLECTOR');
    priority += 20;
  }

  if (evidence.page.valid !== true) {
    let absenceConclusion = false;
    if (includesAuditModule(evidence.selected_modules, 'consent') && corrected.consent_status !== 'inconclusive') {
      absenceConclusion ||= corrected.consent_status === 'not_detected' || corrected.cmp_provider === 'Not Found';
      corrected.consent_status = 'inconclusive';
      violations.push('INVALID_PAGE_CONSENT_CONCLUSION');
    }
    if (includesAuditModule(evidence.selected_modules, 'tracking') && corrected.product_payload_status !== 'not_tested') {
      corrected.product_payload_status = 'not_tested';
      violations.push('INVALID_PAGE_PRODUCT_CONCLUSION');
    }
    if (includesAuditModule(evidence.selected_modules, 'server_side') && (corrected.server_side_status !== 'not_tested' || corrected.ss_collection_type !== 'not_tested')) {
      corrected.server_side_status = 'not_tested';
      corrected.ss_collection_type = 'not_tested';
      violations.push('INVALID_PAGE_SERVER_CONCLUSION');
    }
    if (includesAuditModule(evidence.selected_modules, 'tracking')) {
      const findingConfidence = { ...(corrected.finding_confidence || {}) };
      for (const key of ['ga4', 'meta'] as const) {
        const finding = findingConfidence[key];
        if (corrected[key === 'ga4' ? 'site_ga4_detected' : 'site_meta_detected'] === false || finding?.detected === false) {
          absenceConclusion = true;
          if (key === 'ga4') corrected.site_ga4_detected = null;
          else corrected.site_meta_detected = null;
          if (finding) findingConfidence[key] = { ...finding, detected: null, confidence: 'low', reason_code: `${key.toUpperCase()}_NOT_TESTED` };
        }
      }
      if (absenceConclusion) corrected.finding_confidence = findingConfidence;
    }
    if (absenceConclusion) violations.push('INVALID_PAGE_ABSENCE_CONCLUSION');
    corrected.overall_status = 'inconclusive';
    corrected.overall_confidence = 'low';
    priority += 30;
  }

  const productViewItems = [
    ...evidence.product.ga4_view_item_hits,
    ...(evidence.product.data_layer_view_item_hits || [])
  ];
  if (includesAuditModule(evidence.selected_modules, 'tracking') && corrected.product_payload_status === 'pass' && productViewItems.every((hit) => !hit.has_product)) {
    corrected.product_payload_status = 'inconclusive';
    violations.push('PRODUCT_PASS_WITHOUT_PRODUCT_EVIDENCE');
    priority += 40;
  }

  return { audit: corrected, violations, qa_priority_delta: Math.min(priority, 100) };
}
