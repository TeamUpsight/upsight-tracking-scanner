import type { EvidenceBundle, StorefrontAudit } from '../../types';
import { sanitizeValue } from './sanitize';
import { qaPrioritySignals } from './fingerprints';

export function buildDebugPackageFiles(audit: StorefrontAudit) {
  const trace = (() => {
    try {
      return audit.trace_steps ? JSON.parse(audit.trace_steps) : [];
    } catch {
      return [];
    }
  })();
  const evidence = audit.evidence_bundle;
  const screenshots = evidence?.runtime.screenshots || [];
  const withoutScreenshots: EvidenceBundle | null = evidence
    ? { ...evidence, runtime: { ...evidence.runtime, screenshots: [] } }
    : null;
  const files: Record<string, string | Buffer> = {
    'audit-result.json': JSON.stringify(sanitizeValue({ ...audit, trace_steps: undefined, evidence_bundle: undefined }), null, 2),
    'trace.jsonl': (sanitizeValue(trace) as unknown[]).map((line) => JSON.stringify(line)).join('\n'),
    'evidence.json': JSON.stringify(sanitizeValue(withoutScreenshots), null, 2),
    'normalized-evidence.json': JSON.stringify(sanitizeValue(withoutScreenshots), null, 2),
    'network-summary.json': JSON.stringify(sanitizeValue(evidence?.network || {}), null, 2),
    'cmp-evidence.json': JSON.stringify(sanitizeValue(evidence?.consent || {}), null, 2),
    'product-evidence.json': JSON.stringify(sanitizeValue(evidence?.product || {}), null, 2),
    'quality-summary.json': JSON.stringify(sanitizeValue({
      selected_modules: evidence?.selected_modules || audit.selected_modules || ['consent', 'tracking', 'server_side'],
      qa_priority: audit.qa_priority ?? null,
      qa_priority_signals: evidence ? qaPrioritySignals(audit, evidence, audit.consistency_violations || []) : [],
      failure_fingerprints: audit.failure_fingerprints || [],
      consistency_violations: audit.consistency_violations || [],
      candidate_pdp_url: evidence?.product.candidate_url || null,
      final_pdp_url: evidence?.product.final_pdp_url || evidence?.product.pdp_url || null
    }), null, 2),
    'access-summary.json': JSON.stringify(sanitizeValue({
      access: evidence?.access || null,
      page: evidence ? {
        valid: evidence.page.valid,
        status_code: evidence.page.status_code,
        final_url: evidence.page.final_url,
        access_category: evidence.page.access_category,
        bot_provider: evidence.page.bot_provider,
        challenge_cleared: evidence.page.challenge_cleared,
        retry_after_ms: evidence.page.retry_after_ms
      } : null,
      failure_fingerprints: (audit.failure_fingerprints || []).filter((code) => /PROXY|FALLBACK|CHALLENGE|WAF|HTTP_RATE|STOREFRONT/.test(code)),
      access_consistency_violations: (audit.consistency_violations || []).filter((code) => code.startsWith('ACCESS_'))
    }), null, 2),
    'proxy-attempt-summary.json': JSON.stringify(sanitizeValue({
      initial_provider: evidence?.access?.initial_provider || evidence?.runtime.proxy_initial_provider || null,
      final_provider: evidence?.access?.final_provider || evidence?.runtime.proxy_final_provider || null,
      fallback_used: evidence?.access?.proxy_fallback_used ?? evidence?.runtime.proxy_fallback_used ?? false,
      fallback_recovered: evidence?.access?.proxy_fallback_recovered ?? evidence?.runtime.proxy_fallback_recovered ?? false,
      fallback_candidate: evidence?.runtime.proxy_fallback_candidate || false,
      attempts: evidence?.access?.proxy_attempts || evidence?.runtime.proxy_attempts || []
    }), null, 2),
    'build-metadata.json': JSON.stringify({
      scanner_version: evidence?.scanner_version || 'unknown',
      build_commit: evidence?.build_commit || null,
      build_timestamp: evidence?.build_timestamp || 'unknown',
      rule_pack_version: evidence?.rule_pack_version || 'unknown'
    }, null, 2)
  };
  for (const screenshot of screenshots) {
    files[`screenshots/${screenshot.name.replace(/[^a-z0-9_.-]/gi, '_')}`] = Buffer.from(screenshot.content_base64, 'base64');
  }
  return files;
}
