import type { EvidenceBundle, StorefrontAudit } from '../../types';
import { enforceConsistency } from './consistency';
import { generateFailureFingerprints } from './fingerprints';

export interface GuardrailViolation {
  code: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  explanation: string;
}

export interface AuditReview {
  classification: string;
  violations: GuardrailViolation[];
  likely_root_cause: string;
  patch_plan: string[];
  regression_tests: string[];
}

export function parseTraceSteps(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object') as Record<string, unknown>[];
  if (typeof value !== 'string') throw new Error('trace_steps must be an array, JSON array, or JSONL string');
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('trace_steps JSON must be an array');
    return parsed;
  }
  const normalized = trimmed.includes('\\n') && !trimmed.includes('\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
  return normalized.split(/\r?\n/).filter(Boolean).map((line) => {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') throw new Error('Every JSONL line must be an object');
    return parsed;
  });
}

function traceViolations(trace: Record<string, unknown>[]) {
  const violations: GuardrailViolation[] = [];
  const names = trace.map((step) => String(step.step || ''));
  const finalizationCount = names.filter((name) => name === 'scan_finalized').length;
  if (finalizationCount !== 1) {
    violations.push({
      code: finalizationCount === 0 ? 'SCAN_FINALIZATION_MISSING' : 'SCAN_FINALIZATION_DUPLICATE',
      severity: 'critical',
      explanation: `Expected exactly one scan_finalized event; observed ${finalizationCount}.`
    });
  }
  if (names.includes('stale_scan_recovered') && finalizationCount > 0) {
    const staleIndex = names.lastIndexOf('stale_scan_recovered');
    const finalIndex = names.lastIndexOf('scan_finalized');
    if (staleIndex > finalIndex) {
      violations.push({
        code: 'STALE_RECOVERY_AFTER_FINALIZATION',
        severity: 'critical',
        explanation: 'Stale recovery mutated a scan after standard finalization.'
      });
    }
  }
  if (names.includes('meta_viewcontent_detected') && names.includes('no_collection_detected')) {
    violations.push({
      code: 'META_COLLECTION_SUMMARY_CONTRADICTION',
      severity: 'high',
      explanation: 'Meta collection was observed but a later module reported no collection.'
    });
  }
  const blocked = trace.find((step) => step.step === 'page_validity_failed');
  if (blocked && names.includes('cmp_not_found')) {
    violations.push({
      code: 'INVALID_PAGE_CONSENT_CONCLUSION',
      severity: 'high',
      explanation: 'CMP absence was concluded from an invalid storefront response.'
    });
  }
  return violations;
}

export function reviewAudit(input: {
  audit: Partial<StorefrontAudit>;
  trace: unknown;
  evidence: EvidenceBundle;
}): AuditReview {
  const trace = parseTraceSteps(input.trace);
  const violations = traceViolations(trace);
  const consistency = enforceConsistency(input.audit, input.evidence);
  for (const code of consistency.violations) {
    if (!violations.some((violation) => violation.code === code)) {
      violations.push({ code, severity: 'high', explanation: 'Cross-module evidence and final result disagree.' });
    }
  }
  const fingerprints = generateFailureFingerprints(input.audit, input.evidence, consistency.violations);
  const classification = fingerprints[0] || (violations.length ? 'GUARDRAIL_VIOLATION' : 'NORMAL_COMPLETED');
  const likelyRootCause = violations[0]?.explanation ||
    (input.audit.error_category && input.audit.error_category !== 'none'
      ? `Operational scan failure: ${input.audit.error_category}.`
      : 'No deterministic scanner guardrail violation detected.');

  return {
    classification,
    violations,
    likely_root_cause: likelyRootCause,
    patch_plan: violations.length
      ? ['Inspect the cited evidence and resolver input.', 'Change the shared detector or resolver, not a domain-specific branch.', 'Replay the affected fixture before a live validation scan.']
      : ['No source patch suggested.'],
    regression_tests: violations.map((violation) => `Add or update a fixture covering ${violation.code}.`)
  };
}
