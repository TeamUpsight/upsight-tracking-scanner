import type { CmpProvider, ConsentStatus } from '../../types';
import { resolveConsentStatus } from '../resolver/status-resolver';
import {
  ConsentAuditCodes,
  type ConsentAuditCode,
  type FinalConsentAuditResult,
  type MechanismResult
} from './domain-types';
import type { TrackingConsistencyResult } from './tracking-consistency';

export interface ConsentV2CompatibilityContext {
  geo: 'USA' | 'EU' | 'UK';
  page_valid: boolean | null;
  tracking_before_interaction: boolean;
  post_reject_observation_completed?: boolean;
  trace_steps?: string | null;
  max_trace_steps?: number;
}

export interface ConsentV2CompatibilityResult {
  cmp_provider: CmpProvider | null;
  consent_status: ConsentStatus;
  trace_steps: string;
  trace_events: string[];
}

const LEGACY_PROVIDER_BY_ID: Record<string, CmpProvider> = {
  onetrust: 'OneTrust',
  optanon: 'OneTrust',
  cookiebot: 'Cookiebot',
  usercentrics: 'Usercentrics',
  didomi: 'Didomi',
  cookieyes: 'CookieYes',
  osano: 'Osano',
  iubenda: 'Iubenda',
  trustarc: 'TrustArc',
  fides: 'Fides',
  quantcast: 'Quantcast',
  sourcepoint: 'Sourcepoint'
};

function allReasonCodes(result: FinalConsentAuditResult) {
  const codes = new Set<ConsentAuditCode>(result.reason_codes);
  for (const mechanism of result.mechanisms) {
    mechanism.detection.reason_codes.forEach((code) => codes.add(code));
    mechanism.provider?.reason_codes.forEach((code) => codes.add(code));
  }
  result.context_clean.reason_codes.forEach((code) => codes.add(code));
  result.geo_verified.reason_codes.forEach((code) => codes.add(code));
  result.rejection_verification.reason_codes.forEach((code) => codes.add(code));
  result.persistence.reason_codes.forEach((code) => codes.add(code));
  result.interactions.forEach((attempt) => attempt.reason_codes.forEach((code) => codes.add(code)));
  return codes;
}

function mechanismProvider(mechanism: MechanismResult) {
  const identified = mechanism.provider?.candidates.find((candidate) => candidate.attribution === 'identified');
  return identified?.provider_name ? LEGACY_PROVIDER_BY_ID[identified.provider_name.trim().toLowerCase()] || null : null;
}

function unknownMechanism(result: FinalConsentAuditResult) {
  return result.mechanisms.some((mechanism) =>
    (mechanism.mechanism === 'cmp' || mechanism.mechanism === 'custom') &&
    mechanism.provider?.attribution === 'unknown_candidate'
  );
}

function mapLegacyProvider(result: FinalConsentAuditResult, blockedOrInconclusive: boolean, codes: ReadonlySet<ConsentAuditCode>): CmpProvider | null {
  if (blockedOrInconclusive) return null;
  const visibleCmp = result.mechanisms.find((mechanism) => mechanism.mechanism === 'cmp' && mechanismProvider(mechanism));
  if (visibleCmp) return mechanismProvider(visibleCmp);
  const customCmp = result.mechanisms.find((mechanism) => mechanism.mechanism === 'custom' && mechanismProvider(mechanism));
  if (customCmp) return mechanismProvider(customCmp);
  if (unknownMechanism(result) || codes.has(ConsentAuditCodes.CMP_PROVIDER_UNKNOWN)) return 'Unknown';

  const shopifyRuntime = result.mechanisms.find((mechanism) =>
    mechanism.mechanism === 'commerce_privacy_runtime' && mechanismProvider(mechanism) === null &&
    mechanism.provider?.candidates.some((candidate) => candidate.provider_name.trim().toLowerCase() === 'shopify')
  );
  if (shopifyRuntime) return 'Shopify Privacy';

  return codes.has(ConsentAuditCodes.NO_CMP_DETECTED) ? 'Not Found' : null;
}

function parseTrace(value: string | null | undefined) {
  if (!value) return [] as Record<string, unknown>[];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[] : [];
  } catch {
    return [] as Record<string, unknown>[];
  }
}

function v2TraceEvents(result: FinalConsentAuditResult, tracking: TrackingConsistencyResult | null) {
  const events = new Set<string>();
  const codes = allReasonCodes(result);
  events.add('consent_context_started');
  events.add(result.geo_verified.status === 'verified' ? 'consent_geo_verified' : 'consent_geo_unverified');
  if (result.mechanisms.some((mechanism) => mechanism.mechanism === 'cmp' || mechanism.mechanism === 'custom')) events.add('cmp_candidate_detected');
  if (result.mechanisms.some((mechanism) => mechanismProvider(mechanism))) events.add('cmp_provider_identified');
  if (unknownMechanism(result) || codes.has(ConsentAuditCodes.CMP_PROVIDER_UNKNOWN)) events.add('cmp_provider_unknown');
  if (result.banner.visibility === 'visible') events.add('cmp_banner_visible');
  if (result.available_actions.length > 0) events.add('cmp_actions_resolved');
  const rejectAttempt = result.interactions.some((attempt) => attempt.action === 'reject_all' || attempt.action === 'only_necessary');
  if (rejectAttempt) events.add('cmp_reject_started');
  if (result.interactions.some((attempt) => (attempt.action === 'reject_all' || attempt.action === 'only_necessary') && attempt.outcome === 'executed')) events.add('cmp_reject_executed');
  if (result.rejection_verification.status === 'verified') events.add('cmp_reject_verified');
  if (result.rejection_verification.status === 'inconclusive') events.add('cmp_reject_inconclusive');
  if (result.frameworks.tcf === 'present') events.add('tcf_detected');
  if (result.frameworks.gpp === 'present') events.add('gpp_detected');
  if (result.frameworks.gpp === 'stub_present') events.add('gpp_stub_detected');
  if (result.google_consent_mode.presence === 'present') events.add('consent_mode_detected');
  if (result.persistence.status !== 'not_applicable') events.add('consent_persistence_reload_started');
  if (result.persistence.status === 'confirmed') events.add('consent_persistence_confirmed');
  if (tracking?.status === 'contradiction') events.add('consent_tracking_contradiction');
  events.add('consent_audit_completed');
  return [...events];
}

/**
 * A compatibility boundary only. V2 detectors/adapters retain technical facts;
 * this is the sole place where they are reduced to legacy persisted fields.
 */
export function mapConsentV2ToExisting(
  result: FinalConsentAuditResult,
  context: ConsentV2CompatibilityContext,
  trackingConsistency: TrackingConsistencyResult | null = null
): ConsentV2CompatibilityResult {
  const codes = allReasonCodes(result);
  const blockedOrInconclusive =
    result.context_clean.status !== 'verified' ||
    result.geo_verified.status !== 'verified' ||
    codes.has(ConsentAuditCodes.BLOCKED_OR_CHALLENGED) ||
    codes.has(ConsentAuditCodes.GEO_UNVERIFIED) ||
    codes.has(ConsentAuditCodes.INTERACTION_UNSUPPORTED);
  const cmp_provider = mapLegacyProvider(result, blockedOrInconclusive, codes);
  const rejection_attempted = result.interactions.some((attempt) => attempt.action === 'reject_all' || attempt.action === 'only_necessary');
  const technicalStatus = resolveConsentStatus({
    executed: true,
    page_valid: blockedOrInconclusive ? false : context.page_valid,
    geo: context.geo,
    cmp_provider,
    tracking_before_interaction: context.tracking_before_interaction,
    rejection_attempted,
    rejection_verified: result.rejection_verification.status === 'verified',
    post_reject_observation_completed: context.post_reject_observation_completed,
    tracking_after_verified_rejection: trackingConsistency?.status === 'contradiction'
  });
  const trace_events = v2TraceEvents(result, trackingConsistency);
  const maxTrace = Math.max(1, Math.min(context.max_trace_steps || 200, 500));
  const existingTrace = parseTrace(context.trace_steps);
  const available = Math.max(0, maxTrace - existingTrace.length);
  const appended = trace_events.slice(0, available).map((step) => ({ step, source: 'consent_v2' }));
  return {
    cmp_provider,
    consent_status: technicalStatus.status,
    trace_steps: JSON.stringify([...existingTrace, ...appended]),
    trace_events: appended.map((entry) => String(entry.step))
  };
}
