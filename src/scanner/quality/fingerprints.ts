import type { EvidenceBundle, QaPrioritySignal, StorefrontAudit } from '../../types';
import { includesAuditModule } from '../../audit-modules';

function traceStepNames(trace: unknown) {
  if (typeof trace !== 'string') return [];
  try {
    const parsed = JSON.parse(trace);
    return Array.isArray(parsed) ? parsed.map((step) => String(step?.step || '')) : [];
  } catch {
    return trace.split(/\r?\n/).flatMap((line) => {
      try { return [String(JSON.parse(line)?.step || '')]; } catch { return []; }
    });
  }
}

function hasReason(audit: Partial<StorefrontAudit>, code: string) {
  return audit.terminal_reason_code === code || audit.reason_codes?.includes(code) ||
    Object.values(audit.finding_confidence || {}).some((finding) => finding.reason_code === code);
}

function pathsDiffer(candidate: string | null | undefined, final: string | null | undefined) {
  try {
    if (!candidate || !final) return false;
    const from = new URL(candidate);
    const to = new URL(final);
    return from.hostname !== to.hostname || from.pathname.replace(/\/+$/, '') !== to.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

export function generateFailureFingerprints(audit: Partial<StorefrontAudit>, evidence: EvidenceBundle, consistency: string[] = []) {
  const codes = new Set<string>();
  if (audit.error_category === 'rate_limited') codes.add('HTTP_RATE_LIMITED');
  if (audit.error_category === 'proxy_error') codes.add('PROXY_TUNNEL_FAILED');
  const proxyFailures = (evidence.runtime.proxy_attempts || []).map((attempt) => attempt.failure_reason);
  if (proxyFailures.includes('PROXY_TARGET_TUNNEL_FAILED')) codes.add('PROXY_TARGET_TUNNEL_FAILED');
  if (proxyFailures.includes('PROXY_EXTERNAL_TUNNEL_FAILED')) codes.add('PROXY_EXTERNAL_TUNNEL_FAILED');
  if (audit.error_category === 'dns_error') {
    codes.add(evidence.page.dns_resolution_status === 'not_resolved' ? 'DNS_RESOLUTION_FAILED' : 'DNS_ORIGIN_UNREACHABLE');
  }
  if (evidence.runtime.browser_connection_failure_code === 'BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED') {
    codes.add('BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED');
  }
  if (audit.error_category === 'bot_protection') codes.add('BOT_CLOUDFLARE');
  if (audit.error_category === 'scan_timeout') {
    codes.add('SCAN_TIMEOUT');
    codes.add('SCAN_GLOBAL_TIMEOUT');
  }
  if (audit.error_category === 'access_blocked') codes.add('ACCESS_BLOCKED');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && audit.product_payload_status === 'pdp_not_found') codes.add('PDP_NOT_FOUND');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && hasReason(audit, 'PDP_NAV_TIMEOUT')) codes.add('PDP_NAV_TIMEOUT');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && pathsDiffer(evidence.product.candidate_url, evidence.product.final_pdp_url)) codes.add('PDP_CANONICAL_REDIRECT');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && audit.scan_status === 'partial' && evidence.runtime.failed_phase?.startsWith('product_')) {
    codes.add('PRODUCT_MODULE_BUDGET_EXHAUSTED');
  }
  if (includesAuditModule(evidence.selected_modules, 'tracking') && audit.product_payload_status === 'missing_view_item') codes.add('GA4_NO_VIEW_ITEM');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && audit.site_ga4_detected && !audit.site_ga4_collection_hit_detected) codes.add('GA4_SCRIPT_NO_COLLECT');
  if (includesAuditModule(evidence.selected_modules, 'server_side') && (audit.server_side_status === 'first_party_collection_detected' || audit.server_side_status === 'likely_server_side')) codes.add('SERVER_FP_COLLECTOR');
  if (includesAuditModule(evidence.selected_modules, 'server_side') && audit.ss_collection_type === 'mixed' && evidence.server_side.strict_duplicate_count === 0) codes.add('SERVER_MIXED_NO_DUPLICATE');
  if (includesAuditModule(evidence.selected_modules, 'server_side') && audit.server_side_status === 'partial_or_misconfigured') codes.add('SERVER_STRICT_DUPLICATE');
  if (includesAuditModule(evidence.selected_modules, 'consent') && audit.cmp_provider === 'OneTrust' && evidence.consent.banner_visible === false) codes.add('CMP_ONETRUST_SCRIPT_NO_BANNER');
  if (consistency.length > 0) codes.add('CROSS_MODULE_CONTRADICTION');
  if (audit.trace_steps !== undefined && audit.trace_steps !== null &&
    traceStepNames(audit.trace_steps).filter((step) => step === 'scan_finalized').length === 0 &&
    audit.scan_status && !['pending', 'scanning'].includes(audit.scan_status)) {
    codes.add('SCAN_FINALIZATION_MISSING');
  }
  return [...codes].sort();
}

export function qaPrioritySignals(
  audit: Partial<StorefrontAudit>,
  evidence: EvidenceBundle,
  consistency: string[]
): QaPrioritySignal[] {
  const signals: QaPrioritySignal[] = [];
  const add = (code: string, label: string, points: number, severity: QaPrioritySignal['severity']) => {
    signals.push({ code, label, points, severity });
  };

  if (consistency.length > 0) add('CROSS_MODULE_CONTRADICTION', 'Contradictory module findings', 40, 'critical');

  if (audit.scan_status === 'failed' && audit.error_category !== 'none') {
    const infrastructureFailure = ['rate_limited', 'bot_protection', 'proxy_error', 'access_blocked', 'dns_error', 'ssl_error', 'navigation_timeout', 'scan_timeout'].includes(String(audit.error_category));
    if (!infrastructureFailure) add('SCAN_EXECUTION_FAILED', 'Scan execution failed', 35, 'high');
  }

  const incompleteModules = [
    includesAuditModule(evidence.selected_modules, 'consent') ? audit.consent_status : undefined,
    includesAuditModule(evidence.selected_modules, 'tracking') ? audit.product_payload_status : undefined,
    includesAuditModule(evidence.selected_modules, 'server_side') ? audit.server_side_status : undefined
  ]
    .filter((status) => status === 'inconclusive' || status === 'not_tested').length;
  if (audit.scan_status !== 'failed' && incompleteModules > 0) {
    add('MODULE_RESULT_INCOMPLETE', `${incompleteModules} module${incompleteModules === 1 ? '' : 's'} inconclusive or not tested`, 20, 'medium');
  }

  if (includesAuditModule(evidence.selected_modules, 'consent') && (audit.consent_status === 'consent_leakage' || audit.consent_status === 'prior_consent_violation' || audit.consent_status === 'missing')) {
    add('CONSENT_FINDING_REVIEW', 'Consent finding needs verification', 25, 'high');
  }
  if (includesAuditModule(evidence.selected_modules, 'tracking') && (audit.product_payload_status === 'missing_view_item' || audit.product_payload_status === 'incomplete_view_item')) {
    add('PRODUCT_TRACKING_GAP', 'GA4 ecommerce finding needs verification', 25, 'high');
  } else if (includesAuditModule(evidence.selected_modules, 'tracking') && audit.product_payload_status === 'pdp_not_found') {
    add('PDP_DISCOVERY_GAP', 'No usable PDP was found', 15, 'medium');
  }
  if (includesAuditModule(evidence.selected_modules, 'server_side') && audit.server_side_status === 'partial_or_misconfigured') {
    add('SERVER_SIDE_CONFLICT', 'Possible duplicate or misconfigured collection', 25, 'high');
  }
  if (includesAuditModule(evidence.selected_modules, 'consent') && audit.cmp_provider === 'Unknown') add('CMP_UNKNOWN', 'Unknown CMP pattern', 10, 'medium');
  if (audit.cms_platform_detected === 'Unknown' && evidence.page.valid === true) add('CMS_UNKNOWN', 'CMS could not be identified', 5, 'low');
  if (includesAuditModule(evidence.selected_modules, 'tracking') && audit.site_ga4_detected && !audit.site_ga4_collection_hit_detected) {
    add('GA4_SCRIPT_NO_COLLECT', 'GA4 installation seen without collection', 15, 'medium');
  }
  const actionableNovelEndpoints = evidence.network.novel_endpoints.filter((endpoint) =>
    !((endpoint.host === 'google.com' || endpoint.host === 'www.google.com') && endpoint.path.replace(/\/+$/, '') === '/ccm/collect')
  );
  if (includesAuditModule(evidence.selected_modules, 'tracking') && actionableNovelEndpoints.length > 0) add('NEW_TRACKING_ENDPOINT', 'New tracking endpoint pattern', 10, 'medium');
  if (includesAuditModule(evidence.selected_modules, 'consent') && audit.cmp_provider === 'OneTrust' && evidence.consent.banner_visible === false) {
    add('CMP_ONETRUST_SCRIPT_NO_BANNER', 'OneTrust evidence found without a visible banner', 10, 'low');
  }
  return signals;
}

export function calculateQaPriority(audit: Partial<StorefrontAudit>, evidence: EvidenceBundle, consistency: string[]) {
  return Math.min(qaPrioritySignals(audit, evidence, consistency).reduce((score, signal) => score + signal.points, 0), 100);
}
