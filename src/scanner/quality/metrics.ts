import type { QaFeedback, StorefrontAudit } from '../../types';
import { latestAuditsByWebsite } from './review-queue';

type Outcome = 'true_positive' | 'false_positive' | 'true_negative' | 'false_negative' | 'inconclusive' | 'not_tested' | 'unscored';

function actualForCategory(audit: StorefrontAudit, category: QaFeedback['category']) {
  if (category === 'GA4') return audit.site_ga4_detected;
  if (category === 'Meta') return audit.site_meta_detected;
  if (category === 'CMP') return audit.cmp_provider;
  if (category === 'Consent') return audit.consent_status;
  if (category === 'view_item') return audit.product_payload_status;
  if (category === 'PDP discovery') return audit.pdp_url_tested ? 'detected' : audit.product_payload_status;
  if (category === 'server-side') return audit.server_side_status;
  if (category === 'CMS') return audit.cms_platform_detected;
  if (category === 'bot/access') return audit.error_category;
  return audit.overall_status;
}

function polarity(value: unknown): 'positive' | 'negative' | 'inconclusive' | 'not_tested' | 'unknown' {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[ -]/g, '_');
  if (!normalized || normalized === 'null' || normalized === 'unknown') return 'unknown';
  if (normalized.includes('inconclusive')) return 'inconclusive';
  if (normalized.includes('not_tested')) return 'not_tested';
  if (['false', 'no', 'absent', 'not_found', 'not_detected', 'ga4_not_detected'].includes(normalized)) return 'negative';
  if (['true', 'yes', 'present', 'detected', 'pass'].includes(normalized) ||
      normalized.includes('detected') || normalized.includes('server_side') || normalized.includes('first_party')) return 'positive';
  return 'unknown';
}

function scoreOutcome(actual: unknown, expected: unknown): Outcome {
  const actualPolarity = polarity(actual);
  const expectedPolarity = polarity(expected);
  if (actualPolarity === 'inconclusive') return 'inconclusive';
  if (actualPolarity === 'not_tested') return 'not_tested';
  if (expectedPolarity === 'unknown' || actualPolarity === 'unknown') return 'unscored';
  if (expectedPolarity === 'positive') return actualPolarity === 'positive' ? 'true_positive' : 'false_negative';
  if (expectedPolarity === 'negative') return actualPolarity === 'negative' ? 'true_negative' : 'false_positive';
  return 'unscored';
}

function rate(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function countBy<T>(items: T[], value: (item: T) => unknown) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = String(value(item) ?? 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function recommendationFor(code: string) {
  if (code.includes('GA4_SCRIPT_NO_COLLECT')) return 'Review installation-versus-collection evidence and add a replay fixture for the affected endpoint.';
  if (code.includes('GA4_NO_VIEW_ITEM')) return 'Inspect PDP discovery and the post-load observation window, then verify the captured GA4 payload.';
  if (code.includes('PDP_NOT_FOUND')) return 'Review PDP candidate signals and promote a generic discovery rule backed by a fixture.';
  if (code.includes('PDP_NAV_TIMEOUT')) return 'Inspect navigation timing, page validity, and proxy health before changing detector rules.';
  if (code.includes('PROXY') || code.includes('RATE_LIMIT') || code.includes('HTTP_')) return 'Compare geo and port health, then validate bounded retry and access classification behavior.';
  if (code.includes('BOT_') || code.includes('ACCESS_')) return 'Review the sanitized challenge signals and use a difficult-site rerun only for high-value validation.';
  if (code.includes('CMP_')) return 'Compare DOM, script, cookie, iframe, and global evidence before adjusting the shared CMP detector.';
  if (code.includes('SERVER_')) return 'Review normalized collection requests and strict duplicate keys before changing server-side classification.';
  if (code.includes('FINALIZATION') || code.includes('LIFECYCLE')) return 'Treat this as a lifecycle defect and add a terminal-path regression test.';
  return 'Open representative audits, verify the finding, and convert the confirmed pattern into a replay fixture.';
}

export function buildQualityMetrics(audits: StorefrontAudit[], feedback: QaFeedback[]) {
  const byId = new Map(audits.map((audit) => [String(audit.audit_id), audit]));
  const latestAudits = latestAuditsByWebsite(audits);
  const unresolvedLatestAudits = latestAudits.filter((audit) => audit.qa_review_status !== 'correct');
  const categories: Record<string, Record<Outcome, number>> = {};
  let exactCorrections = 0;
  let exactMatches = 0;
  for (const item of feedback) {
    const audit = byId.get(String(item.audit_id));
    if (!audit) continue;
    const counters = categories[item.category] ||= {
      true_positive: 0, false_positive: 0, true_negative: 0, false_negative: 0,
      inconclusive: 0, not_tested: 0, unscored: 0
    };
    counters[scoreOutcome(actualForCategory(audit, item.category), item.expected_value)] += 1;
    if (item.expected_value !== null) {
      exactCorrections += 1;
      if (String(actualForCategory(audit, item.category)).toLowerCase() === item.expected_value.toLowerCase()) exactMatches += 1;
    }
  }
  const ga4 = categories.GA4 || { true_positive: 0, false_positive: 0, true_negative: 0, false_negative: 0 };
  const durations = latestAudits.map((audit) => audit.runtime_metrics?.total_duration_ms ?? audit.evidence_bundle?.runtime.total_duration_ms)
    .filter((value): value is number => typeof value === 'number').sort((a, b) => a - b);
  const retries = latestAudits.map((audit) => audit.runtime_metrics?.proxy_retry_count ?? audit.evidence_bundle?.runtime.proxy_retry_count ?? 0);
  const retryAttempts = latestAudits.filter((_audit, index) => retries[index] > 0);
  const fingerprintClusters: Record<string, number> = {};
  const fingerprintSamples: Record<string, { domains: string[]; audit_ids: Array<string | number> }> = {};
  for (const audit of unresolvedLatestAudits) {
    for (const fingerprint of audit.failure_fingerprints || []) {
      fingerprintClusters[fingerprint] = (fingerprintClusters[fingerprint] || 0) + 1;
      const sample = fingerprintSamples[fingerprint] ||= { domains: [], audit_ids: [] };
      if (!sample.domains.includes(audit.domain) && sample.domains.length < 5) sample.domains.push(audit.domain);
      if (sample.audit_ids.length < 5) sample.audit_ids.push(audit.audit_id);
    }
  }
  const failureClusters = Object.entries(fingerprintClusters)
    .map(([code, count]) => ({
      code,
      count,
      share: rate(count, latestAudits.length),
      ...fingerprintSamples[code],
      recommendation: recommendationFor(code)
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  const feedbackAuditIds = new Set(feedback.map((item) => String(item.audit_id)));
  const verifiedLatestIds = new Set(latestAudits.filter((audit) =>
    audit.qa_review_status === 'correct' || feedbackAuditIds.has(String(audit.audit_id))
  ).map((audit) => String(audit.audit_id)));
  const categorySummaries = Object.entries(categories).map(([category, counters]) => {
    const scored = counters.true_positive + counters.true_negative + counters.false_positive + counters.false_negative;
    return {
      category,
      ...counters,
      total: Object.values(counters).reduce((sum, value) => sum + value, 0),
      accuracy: rate(counters.true_positive + counters.true_negative, scored)
    };
  }).sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
  const trendMap = new Map<string, { date: string; audits: number; completed: number; failed: number; inconclusive: number; duration_total_ms: number; duration_count: number }>();
  for (const audit of latestAudits) {
    const timestamp = new Date(audit.scan_started_at);
    if (Number.isNaN(timestamp.getTime())) continue;
    const date = timestamp.toISOString().slice(0, 10);
    const point = trendMap.get(date) || { date, audits: 0, completed: 0, failed: 0, inconclusive: 0, duration_total_ms: 0, duration_count: 0 };
    point.audits += 1;
    if (audit.scan_status === 'completed' || audit.scan_status === 'partial') point.completed += 1;
    if (audit.scan_status === 'failed') point.failed += 1;
    if (audit.overall_status === 'inconclusive') point.inconclusive += 1;
    const duration = audit.runtime_metrics?.total_duration_ms ?? audit.evidence_bundle?.runtime.total_duration_ms;
    if (typeof duration === 'number') {
      point.duration_total_ms += duration;
      point.duration_count += 1;
    }
    trendMap.set(date, point);
  }
  const trend = [...trendMap.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30).map((point) => ({
    date: point.date,
    audits: point.audits,
    completed: point.completed,
    failed: point.failed,
    inconclusive: point.inconclusive,
    average_scan_time_ms: point.duration_count ? point.duration_total_ms / point.duration_count : null
  }));
  return {
    verified: {
      total_feedback: feedback.length,
      verified_audits: verifiedLatestIds.size,
      coverage: rate(verifiedLatestIds.size, latestAudits.length),
      exact_value_accuracy: rate(exactMatches, exactCorrections),
      categories,
      category_summaries: categorySummaries,
      ga4_precision: rate(ga4.true_positive, ga4.true_positive + ga4.false_positive),
      ga4_recall: rate(ga4.true_positive, ga4.true_positive + ga4.false_negative),
      cmp_accuracy: (() => {
        const items = feedback.filter((item) => item.category === 'CMP' && item.expected_value !== null);
        const correct = items.filter((item) => String(byId.get(String(item.audit_id))?.cmp_provider || '').toLowerCase() === item.expected_value!.toLowerCase()).length;
        return rate(correct, items.length);
      })()
    },
    operational: {
      audits: audits.length,
      total_audits: audits.length,
      unique_websites: latestAudits.length,
      reviewed_correct_websites: latestAudits.filter((audit) => audit.qa_review_status === 'correct').length,
      findings_basis: 'latest_unique_website_audits',
      completion_rate: rate(latestAudits.filter((audit) => audit.scan_status === 'completed' || audit.scan_status === 'partial').length, latestAudits.length),
      proxy_failure_rate: rate(latestAudits.filter((audit) => audit.error_category === 'proxy_error').length, latestAudits.length),
      rate_limit_rate: rate(latestAudits.filter((audit) => audit.error_category === 'rate_limited').length, latestAudits.length),
      bot_rate: rate(latestAudits.filter((audit) => audit.error_category === 'bot_protection').length, latestAudits.length),
      access_block_rate: rate(latestAudits.filter((audit) => audit.error_category === 'access_blocked').length, latestAudits.length),
      valid_storefront_rate: rate(latestAudits.filter((audit) => audit.evidence_bundle?.page.valid === true).length, latestAudits.length),
      challenge_clear_rate: rate(
        latestAudits.filter((audit) => audit.evidence_bundle?.page.challenge_cleared).length,
        latestAudits.filter((audit) => audit.evidence_bundle?.page.bot_provider !== null && audit.evidence_bundle?.page.bot_provider !== undefined).length
      ),
      external_redirect_acceptance_rate: rate(
        latestAudits.filter((audit) => audit.evidence_bundle?.page.cross_domain_redirect_accepted).length,
        latestAudits.length
      ),
      inconclusive_rate: rate(latestAudits.filter((audit) => audit.overall_status === 'inconclusive').length, latestAudits.length),
      average_scan_time_ms: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length : null,
      p95_scan_time_ms: durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null,
      retry_rate: rate(retryAttempts.length, latestAudits.length),
      retry_recovery_rate: rate(
        retryAttempts.filter((audit) => audit.evidence_bundle?.runtime.proxy_retry_recovered).length,
        retryAttempts.length
      ),
      review_candidates: unresolvedLatestAudits.filter((audit) => (audit.qa_priority || 0) > 0 || audit.overall_confidence === 'low' || (audit.consistency_violations || []).length > 0).length,
      unverified_audits: latestAudits.filter((audit) => !verifiedLatestIds.has(String(audit.audit_id))).length
    },
    distributions: {
      scan_status: countBy(latestAudits, (audit) => audit.scan_status),
      overall_status: countBy(latestAudits, (audit) => audit.overall_status || 'not_tested'),
      error_category: countBy(latestAudits, (audit) => audit.error_category || 'none'),
      cms: countBy(latestAudits, (audit) => audit.cms_platform_detected || 'Unknown'),
      cmp: countBy(latestAudits, (audit) => audit.cmp_provider || 'Unknown'),
      consent: countBy(latestAudits, (audit) => audit.consent_status || 'not_tested'),
      ga4_installation: countBy(latestAudits, (audit) => audit.site_ga4_detected === null || audit.site_ga4_detected === undefined ? 'not_tested' : audit.site_ga4_detected ? 'detected' : 'not_detected'),
      meta_installation: countBy(latestAudits, (audit) => audit.site_meta_detected === null || audit.site_meta_detected === undefined ? 'not_tested' : audit.site_meta_detected ? 'detected' : 'not_detected'),
      product_payload: countBy(latestAudits, (audit) => audit.product_payload_status || 'not_tested'),
      server_side: countBy(latestAudits, (audit) => audit.server_side_status || 'not_tested')
    },
    trend,
    failure_clusters: failureClusters,
    improvement_opportunities: failureClusters.slice(0, 5),
    failure_fingerprint_clusters: fingerprintClusters
  };
}
