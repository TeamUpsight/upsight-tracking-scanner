import type { QaFeedback, StorefrontAudit } from '../../types';

function siteKey(domain: string) {
  return domain.trim().toLowerCase().replace(/^www\./, '');
}

export function latestAuditsByWebsite(audits: StorefrontAudit[]) {
  const latestBySite = new Map<string, StorefrontAudit>();
  for (const audit of audits) {
    const key = siteKey(audit.domain);
    const existing = latestBySite.get(key);
    if (!existing || new Date(audit.scan_started_at).getTime() > new Date(existing.scan_started_at).getTime()) {
      latestBySite.set(key, audit);
    }
  }
  return [...latestBySite.values()];
}

export function buildLatestReviewQueue(audits: StorefrontAudit[], feedback: QaFeedback[], limit = 100) {
  const feedbackByAudit = new Map<string, QaFeedback[]>();
  for (const item of feedback) {
    const key = String(item.audit_id);
    const items = feedbackByAudit.get(key) || [];
    items.push(item);
    feedbackByAudit.set(key, items);
  }

  return latestAuditsByWebsite(audits).flatMap((audit) => {
    if (audit.qa_review_status === 'correct') return [];
    const latestAuditFeedback = (feedbackByAudit.get(String(audit.audit_id)) || []).sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const isCandidate = (audit.qa_priority || 0) > 0 || audit.overall_confidence === 'low' ||
      (audit.consistency_violations || []).length > 0 || latestAuditFeedback.length > 0;
    return isCandidate ? [{ ...audit, qa_feedback: latestAuditFeedback }] : [];
  }).sort((a, b) => {
    const incorrectA = (a.qa_feedback || []).filter((item) => item.verdict === 'incorrect').length;
    const incorrectB = (b.qa_feedback || []).filter((item) => item.verdict === 'incorrect').length;
    return incorrectB - incorrectA || (b.qa_priority || 0) - (a.qa_priority || 0) ||
      new Date(b.scan_started_at).getTime() - new Date(a.scan_started_at).getTime();
  }).slice(0, Math.max(1, Math.min(limit, 500)));
}
