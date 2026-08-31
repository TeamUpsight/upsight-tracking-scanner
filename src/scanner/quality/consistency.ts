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
