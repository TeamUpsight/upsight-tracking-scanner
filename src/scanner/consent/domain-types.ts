/**
 * Consent Audit V2's internal vocabulary.
 *
 * These types deliberately do not map to persisted consent_status, cmp_provider,
 * or trace_steps fields. They model independently observed facts for a future
 * Consent V2 execution path.
 */

export type ConsentMechanismType =
  | 'cmp'
  | 'commerce_privacy_runtime'
  | 'framework'
  | 'consent_mode'
  | 'custom';

export type ProviderAttribution =
  | 'identified'
  | 'unknown_candidate'
  | 'rejected_candidate'
  | 'inconclusive';

export type ProviderConfidenceLevel = 'high' | 'medium' | 'low';

export type ConsentDecision =
  | 'unanswered'
  | 'accepted'
  | 'rejected'
  | 'partial'
  | 'not_applicable'
  | 'unavailable'
  | 'ambiguous';

export type ConsentCategory =
  | 'necessary'
  | 'preferences'
  | 'analytics'
  | 'marketing'
  | 'personalization'
  | 'sale_or_share'
  | 'unknown';

export type BannerSurface =
  | 'banner'
  | 'dialog'
  | 'drawer'
  | 'preference_center'
  | 'link_only'
  | 'none'
  | 'unknown';

export type BannerVisibility = 'visible' | 'not_visible' | 'unknown';

export type ConsentActionType =
  | 'accept_all'
  | 'reject_all'
  | 'only_necessary'
  | 'open_preferences'
  | 'set_category'
  | 'save_preferences'
  | 'close';

export type ActionAvailability =
  | 'direct'
  | 'preferences_only'
  | 'api_only'
  | 'not_present'
  | 'unknown';

export type InteractionOrigin =
  | 'provider_api'
  | 'provider_selector'
  | 'semantic_ui'
  | 'generic_ui'
  | 'keyboard';

export type InteractionOutcome =
  | 'executed'
  | 'not_executed'
  | 'timeout'
  | 'unsupported'
  | 'aborted';

export type VerificationStatus = 'verified' | 'not_verified' | 'inconclusive';

export type PersistenceStatus =
  | 'confirmed'
  | 'not_confirmed'
  | 'inconclusive'
  | 'not_applicable';

export type AdapterMaturity =
  | 'verified'
  | 'documentation_supported'
  | 'fixture_only'
  | 'supporting_only'
  | 'unvalidated'
  | 'unsupported';

export const ConsentAuditCodes = {
  CMP_DETECTED: 'CMP_DETECTED',
  CMP_PROVIDER_IDENTIFIED: 'CMP_PROVIDER_IDENTIFIED',
  CMP_PROVIDER_UNKNOWN: 'CMP_PROVIDER_UNKNOWN',
  NO_CMP_DETECTED: 'NO_CMP_DETECTED',
  DETECTION_INCONCLUSIVE: 'DETECTION_INCONCLUSIVE',

  TCF_PRESENT: 'TCF_PRESENT',
  GPP_PRESENT: 'GPP_PRESENT',
  GPP_STUB_PRESENT: 'GPP_STUB_PRESENT',
  USP_PRESENT: 'USP_PRESENT',

  CONSENT_MODE_PRESENT: 'CONSENT_MODE_PRESENT',
  CONSENT_MODE_AMBIGUOUS: 'CONSENT_MODE_AMBIGUOUS',

  BANNER_VISIBLE: 'BANNER_VISIBLE',
  BANNER_NOT_VISIBLE: 'BANNER_NOT_VISIBLE',
  BANNER_VISIBILITY_UNKNOWN: 'BANNER_VISIBILITY_UNKNOWN',

  ACCEPT_AVAILABLE: 'ACCEPT_AVAILABLE',
  REJECT_AVAILABLE: 'REJECT_AVAILABLE',
  REJECT_PREFERENCES_ONLY: 'REJECT_PREFERENCES_ONLY',
  REJECT_NOT_AVAILABLE: 'REJECT_NOT_AVAILABLE',
  PREFERENCES_LINK_PRESENT: 'PREFERENCES_LINK_PRESENT',

  ACTION_EXECUTED: 'ACTION_EXECUTED',
  ACTION_NOT_EXECUTED: 'ACTION_NOT_EXECUTED',
  INTERACTION_UNSUPPORTED: 'INTERACTION_UNSUPPORTED',
  INTERACTION_TIMEOUT: 'INTERACTION_TIMEOUT',

  ACTION_VERIFIED: 'ACTION_VERIFIED',
  ACTION_NOT_VERIFIED: 'ACTION_NOT_VERIFIED',
  ACTION_INCONCLUSIVE: 'ACTION_INCONCLUSIVE',

  PERSISTENCE_CONFIRMED: 'PERSISTENCE_CONFIRMED',
  PERSISTENCE_NOT_CONFIRMED: 'PERSISTENCE_NOT_CONFIRMED',
  PERSISTENCE_INCONCLUSIVE: 'PERSISTENCE_INCONCLUSIVE',
  PERSISTENCE_NOT_APPLICABLE: 'PERSISTENCE_NOT_APPLICABLE',

  GEO_UNVERIFIED: 'GEO_UNVERIFIED',
  CONTEXT_NOT_CLEAN: 'CONTEXT_NOT_CLEAN',
  PROVIDER_CONFLICT: 'PROVIDER_CONFLICT',
  ADAPTER_NOT_READY: 'ADAPTER_NOT_READY',
  CROSS_ORIGIN_FRAME_ERROR: 'CROSS_ORIGIN_FRAME_ERROR',
  CLOSED_SHADOW_ROOT: 'CLOSED_SHADOW_ROOT',
  ACTION_NOT_EXPOSED: 'ACTION_NOT_EXPOSED',
  NO_VERIFIER: 'NO_VERIFIER',
  STATE_CONTRADICTION: 'STATE_CONTRADICTION',
  NAVIGATION_INTERRUPTED: 'NAVIGATION_INTERRUPTED',
  BLOCKED_OR_CHALLENGED: 'BLOCKED_OR_CHALLENGED'
} as const;

export type ConsentAuditCode = typeof ConsentAuditCodes[keyof typeof ConsentAuditCodes];

export const CONSENT_AUDIT_RESULT_CODES = Object.values(ConsentAuditCodes) as ConsentAuditCode[];

export function isConsentAuditCode(value: string): value is ConsentAuditCode {
  return (CONSENT_AUDIT_RESULT_CODES as string[]).includes(value);
}

export interface VerificationResult {
  status: VerificationStatus;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export interface CmpCandidate {
  provider_name: string;
  attribution: ProviderAttribution;
  confidence: ProviderConfidenceLevel;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export interface ProviderConfidence {
  attribution: ProviderAttribution;
  confidence: ProviderConfidenceLevel;
  candidates: CmpCandidate[];
  reason_codes: ConsentAuditCode[];
}

export interface MechanismResult {
  mechanism: ConsentMechanismType;
  detection: VerificationResult;
  provider: ProviderConfidence | null;
  adapter_maturity: AdapterMaturity;
}

export interface BannerState {
  surface: BannerSurface;
  visibility: BannerVisibility;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export interface AvailableAction {
  action: ConsentActionType;
  availability: ActionAvailability;
  category: ConsentCategory | null;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export interface CategoryDecision {
  category: ConsentCategory;
  decision: ConsentDecision;
  evidence: string[];
}

export interface ConsentState {
  decision: ConsentDecision;
  categories: CategoryDecision[];
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export interface InteractionAttempt {
  action: ConsentActionType;
  origin: InteractionOrigin;
  outcome: InteractionOutcome;
  category: ConsentCategory | null;
  reason_codes: ConsentAuditCode[];
}

export interface PersistenceResult {
  status: PersistenceStatus;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export type FrameworkPresence = 'present' | 'stub_present' | 'not_present' | 'unknown';

export interface FrameworkState {
  tcf: FrameworkPresence;
  gpp: FrameworkPresence;
  usp: FrameworkPresence;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export type GoogleConsentModePresence = 'present' | 'not_present' | 'ambiguous' | 'unknown';

export interface GoogleConsentModeState {
  presence: GoogleConsentModePresence;
  defaults_observed: boolean | null;
  updates_observed: boolean | null;
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

/**
 * Storage metadata only. Raw cookie and Web Storage values are intentionally
 * excluded from this model.
 */
export interface StorageChange {
  storage_type: 'cookie' | 'local_storage' | 'session_storage' | 'indexeddb';
  key_name: string;
  change: 'added' | 'updated' | 'removed' | 'unchanged';
}

/**
 * A bounded request observation. Neither full URLs nor request payloads belong
 * in this model.
 */
export interface NetworkSignal {
  host: string;
  path: string;
  method: string;
  phase: string;
  signal: 'script' | 'request' | 'response' | 'tracking';
}

export interface FinalConsentAuditResult {
  context_clean: VerificationResult;
  geo_verified: VerificationResult;
  mechanisms: MechanismResult[];
  banner: BannerState;
  available_actions: AvailableAction[];
  initial_state: ConsentState;
  resulting_state: ConsentState | null;
  interactions: InteractionAttempt[];
  rejection_verification: VerificationResult;
  persistence: PersistenceResult;
  frameworks: FrameworkState;
  google_consent_mode: GoogleConsentModeState;
  storage_changes: StorageChange[];
  network_signals: NetworkSignal[];
  reason_codes: ConsentAuditCode[];
}
