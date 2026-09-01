import {
  cmpAdapterRegistry,
  scoreProviderCandidates,
  type AdapterDetectionInput,
  type AdapterDetectionResult,
  type AdapterOperationInput,
  type AdapterOperationResult,
  type ConsentProviderAdapter,
  type ProviderEvidenceSignal
} from './adapter-registry';
import {
  ConsentAuditCodes,
  type AvailableAction,
  type BannerState,
  type ConsentAuditCode,
  type ConsentCategory,
  type ConsentDecision,
  type ConsentState,
  type InteractionAttempt,
  type PersistenceResult,
  type VerificationResult
} from './domain-types';

export const COOKIEYES_STANDARD_ROOT = '.cky-consent-container';
export const COOKIEYES_STABLE_CONTROLS = {
  accept: '.cky-btn-accept',
  reject: '.cky-btn-reject',
  customize: '.cky-btn-customize'
} as const;
export const COOKIEYES_STABLE_ATTRIBUTES = {
  accept: 'accept-button',
  reject: 'reject-button',
  customize: 'settings-button'
} as const;
export const COOKIEYES_PUBLIC_METHODS = ['performBannerAction', 'getCkyConsent'] as const;

export type CookieYesPublicMethod = typeof COOKIEYES_PUBLIC_METHODS[number];
export type CookieYesBannerAction = 'accept_all' | 'reject' | 'accept_partial';
export type CookieYesSemanticAction = 'accept_all' | 'reject_all' | 'open_preferences';
export type CookieYesCategoryName = 'analytics' | 'advertisement' | 'functional' | 'performance' | 'necessary' | 'other';

export interface CookieYesControlObservation {
  selector: string;
  stable_attribute?: string;
  semantic_action?: CookieYesSemanticAction;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  /** Prevents generic-looking CookieYes classes elsewhere on the page from becoming controls. */
  within_confirmed_cookieyes_surface: boolean;
}

export interface CookieYesSurfaceObservation {
  selector: string;
  visible: boolean;
}

/** A safe getCkyConsent() projection: no consent ID, law, language, or raw payload is retained. */
export interface CookieYesConsentSummary {
  categories: Partial<Record<CookieYesCategoryName, boolean | null>>;
  is_user_action_completed: boolean | null;
}

/** Metadata only; cookieyes-consent values never enter this adapter. */
export interface CookieYesPersistenceDescriptor {
  name: 'cookieyes-consent';
  exists: boolean;
  value_length?: number;
  changed?: boolean;
  post_reload_exists?: boolean;
  post_reload_matches_after?: boolean;
}

/** Input is transient browser evidence; output remains bounded and privacy-safe. */
export interface CookieYesAdapterContext {
  asset_urls?: readonly string[];
  runtime_functions?: readonly string[];
  surfaces?: readonly CookieYesSurfaceObservation[];
  controls?: readonly CookieYesControlObservation[];
  consent?: CookieYesConsentSummary | null;
  persistence?: readonly CookieYesPersistenceDescriptor[];
  tcf_active?: boolean;
  action_executed?: boolean;
  invoke_control?: (selector: string) => boolean | Promise<boolean>;
  invoke_public_action?: (action: CookieYesBannerAction) => boolean | Promise<boolean>;
}

export interface CookieYesActionInventory {
  actions: AvailableAction[];
  user_facing_reject_available: boolean;
  provider_api_reject_available: boolean;
  preferences_flow_available: boolean;
}

export interface CookieYesVerificationContribution {
  strong: string[];
  supporting: string[];
}

function hasCookieYesAsset(values: readonly string[] | undefined) {
  return values?.some((value) => /cdn-cookieyes\.com\/client_data\//i.test(value)) || false;
}

function hasRuntimeFunction(context: CookieYesAdapterContext, method: CookieYesPublicMethod) {
  return context.runtime_functions?.some((value) => value === method) || false;
}

function isActionable(control: CookieYesControlObservation | undefined) {
  return Boolean(control?.visible && control.enabled && control.actionable && control.within_confirmed_cookieyes_surface);
}

function standardControl(context: CookieYesAdapterContext, action: 'accept' | 'reject' | 'customize') {
  const selector = COOKIEYES_STABLE_CONTROLS[action];
  const attribute = COOKIEYES_STABLE_ATTRIBUTES[action];
  return context.controls?.find((control) =>
    isActionable(control) && (control.selector === selector || control.stable_attribute === attribute)
  );
}

function semanticControl(context: CookieYesAdapterContext, action: CookieYesSemanticAction) {
  return context.controls?.find((control) => control.semantic_action === action && isActionable(control));
}

function actionControl(context: CookieYesAdapterContext, action: 'accept' | 'reject' | 'preferences') {
  if (action === 'accept') return standardControl(context, 'accept') || semanticControl(context, 'accept_all');
  if (action === 'reject') return standardControl(context, 'reject') || semanticControl(context, 'reject_all');
  return standardControl(context, 'customize') || semanticControl(context, 'open_preferences');
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as CookieYesAdapterContext : null;
}

function completed<T>(value: T): AdapterOperationResult<T> {
  return { status: 'completed', value, reason_codes: [] };
}

function inconclusive<T>(value: T, reasonCodes: ConsentAuditCode[] = [ConsentAuditCodes.DETECTION_INCONCLUSIVE]) {
  return { status: 'inconclusive' as const, value, reason_codes: reasonCodes };
}

function unsupported<T>() {
  return { status: 'unsupported' as const, value: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED] };
}

/** TCF is intentionally excluded: CookieYes must be attributed with its own runtime, asset, root, or persistence evidence. */
export function cookieYesProviderEvidence(context: CookieYesAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (hasRuntimeFunction(context, 'performBannerAction') || hasRuntimeFunction(context, 'getCkyConsent')) {
    evidence.push({ provider_id: 'cookieyes', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' });
  }
  if (hasCookieYesAsset(context.asset_urls)) {
    evidence.push({ provider_id: 'cookieyes', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' });
  }
  if (context.surfaces?.some((surface) => surface.selector === COOKIEYES_STANDARD_ROOT)) {
    evidence.push({ provider_id: 'cookieyes', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' });
  }
  if (context.persistence?.some((descriptor) => descriptor.name === 'cookieyes-consent' && descriptor.exists)) {
    evidence.push({ provider_id: 'cookieyes', family: 'provider_persistence', kind: 'provider_persistence_key', specificity: 'provider_specific' });
  }
  return evidence;
}

export function detectCookieYes(context: CookieYesAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(cookieYesProviderEvidence(context)).find((item) => item.provider_id === 'cookieyes');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  return candidate.high_confidence
    ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
    : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
}

/** A detected runtime does not imply that its consent container is visible. */
export function cookieYesBannerState(context: CookieYesAdapterContext): BannerState {
  const root = context.surfaces?.find((surface) => surface.selector === COOKIEYES_STANDARD_ROOT);
  if (root?.visible) return { surface: 'banner', visibility: 'visible', evidence: ['cookieyes_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] };
  if (root) return { surface: 'none', visibility: 'not_visible', evidence: ['cookieyes_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

function normalizedCategory(category: CookieYesCategoryName): ConsentCategory {
  if (category === 'advertisement') return 'marketing';
  if (category === 'functional') return 'preferences';
  if (category === 'performance') return 'analytics';
  if (category === 'other') return 'unknown';
  return category;
}

function categoryDecision(value: boolean | null | undefined): ConsentDecision {
  return value === true ? 'accepted' : value === false ? 'rejected' : 'ambiguous';
}

function normalizedCategories(categories: CookieYesConsentSummary['categories']) {
  const valuesByCategory = new Map<ConsentCategory, Array<boolean | null | undefined>>();
  for (const [name, value] of Object.entries(categories)) {
    const category = normalizedCategory(name as CookieYesCategoryName);
    valuesByCategory.set(category, [...(valuesByCategory.get(category) || []), value]);
  }
  return [...valuesByCategory.entries()].map(([category, values]) => {
    const decisions = values.map(categoryDecision);
    const decision: ConsentDecision = decisions.every((entry) => entry === 'accepted') ? 'accepted'
      : decisions.every((entry) => entry === 'rejected') ? 'rejected'
        : decisions.some((entry) => entry === 'ambiguous') ? 'ambiguous' : 'partial';
    return { category, decision, evidence: ['cookieyes_get_cky_consent'] };
  });
}

function overallDecision(categories: CookieYesConsentSummary['categories']): ConsentDecision {
  const optional = ['analytics', 'advertisement', 'functional', 'performance', 'other'] as const;
  const values = optional.map((name) => categories[name]).filter((value): value is boolean => typeof value === 'boolean');
  if (!values.length) return 'ambiguous';
  if (values.every((value) => value)) return 'accepted';
  if (values.every((value) => !value)) return 'rejected';
  return 'partial';
}

/** isUserActionCompleted only contributes choice-completed evidence; category decisions determine the state. */
export function cookieYesConsentState(context: CookieYesAdapterContext): ConsentState {
  const consent = context.consent;
  const categories = normalizedCategories(consent?.categories || {});
  const evidence: string[] = [];
  if (hasRuntimeFunction(context, 'getCkyConsent')) evidence.push('cookieyes_get_cky_consent_api_available');
  if (consent) evidence.push('cookieyes_get_cky_consent_read');
  if (consent?.is_user_action_completed === true) evidence.push('cookieyes_user_action_completed');
  if (context.tcf_active) evidence.push('tcf_framework_active');
  return {
    decision: consent ? overallDecision(consent.categories) : 'ambiguous', categories, evidence,
    reason_codes: consent ? [] : [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  };
}

export function cookieYesActionInventory(context: CookieYesAdapterContext): CookieYesActionInventory {
  const accept = actionControl(context, 'accept');
  const reject = actionControl(context, 'reject');
  const preferences = actionControl(context, 'preferences');
  const api = hasRuntimeFunction(context, 'performBannerAction');
  return {
    actions: [
      {
        action: 'accept_all', availability: accept ? 'direct' : api ? 'api_only' : 'not_present', category: null,
        evidence: accept ? ['cookieyes_accept_control'] : api ? ['cookieyes_perform_banner_action'] : [],
        reason_codes: accept || api ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : []
      },
      {
        action: 'reject_all', availability: reject ? 'direct' : preferences ? 'preferences_only' : api ? 'api_only' : 'not_present', category: null,
        evidence: reject ? ['cookieyes_reject_control'] : preferences ? ['cookieyes_customize_control'] : api ? ['cookieyes_perform_banner_action'] : [],
        reason_codes: reject ? [ConsentAuditCodes.REJECT_AVAILABLE]
          : preferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY]
            : api ? [] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE]
      },
      {
        action: 'open_preferences', availability: preferences ? 'direct' : 'not_present', category: null,
        evidence: preferences ? ['cookieyes_customize_control'] : [], reason_codes: preferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : []
      }
    ],
    user_facing_reject_available: Boolean(reject),
    provider_api_reject_available: api,
    preferences_flow_available: Boolean(preferences)
  };
}

/** A reload fingerprint comparison may confirm persistence, but cannot verify a semantic Reject decision. */
export function cookieYesPersistenceEvidence(context: CookieYesAdapterContext): PersistenceResult {
  const descriptor = context.persistence?.find((entry) => entry.name === 'cookieyes-consent' && entry.exists);
  if (!descriptor) return { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] };
  const confirmed = Boolean(descriptor.changed && descriptor.post_reload_exists && descriptor.post_reload_matches_after);
  return {
    status: confirmed ? 'confirmed' : 'inconclusive',
    evidence: [
      'cookieyes_persistence_key_present',
      ...(descriptor.changed ? ['cookieyes_persistence_key_changed'] : []),
      ...(descriptor.post_reload_exists ? ['cookieyes_persistence_key_present_after_reload'] : [])
    ],
    reason_codes: [confirmed ? ConsentAuditCodes.PERSISTENCE_CONFIRMED : ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
  };
}

export function cookieYesVerificationContribution(context: CookieYesAdapterContext): CookieYesVerificationContribution {
  const state = cookieYesConsentState(context);
  const strong = context.consent && state.decision !== 'ambiguous' ? ['cookieyes_get_cky_consent_state'] : [];
  const supporting: string[] = [];
  if (context.action_executed) supporting.push('cookieyes_action_invoked');
  if (context.consent?.is_user_action_completed === true) supporting.push('cookieyes_user_action_completed');
  if (context.persistence?.some((descriptor) => descriptor.name === 'cookieyes-consent' && descriptor.exists)) supporting.push('cookieyes_persistence_key_present');
  return { strong, supporting };
}

async function invokeAction(
  context: CookieYesAdapterContext,
  action: 'accept' | 'reject' | 'preferences'
): Promise<AdapterOperationResult<InteractionAttempt>> {
  const actionType = action === 'accept' ? 'accept_all' : action === 'reject' ? 'reject_all' : 'open_preferences';
  const control = actionControl(context, action);
  if (control && context.invoke_control) {
    const executed = await context.invoke_control(control.selector);
    const origin = control.semantic_action ? 'semantic_ui' : 'provider_selector';
    return executed
      ? completed({ action: actionType, origin, outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
      : inconclusive({ action: actionType, origin, outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
  }
  if (action !== 'preferences' && hasRuntimeFunction(context, 'performBannerAction') && context.invoke_public_action) {
    const bannerAction: CookieYesBannerAction = action === 'accept' ? 'accept_all' : 'reject';
    const executed = await context.invoke_public_action(bannerAction);
    return executed
      ? completed({ action: actionType, origin: 'provider_api', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
      : inconclusive({ action: actionType, origin: 'provider_api', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
  }
  return unsupported();
}

function verifyCookieYesAction(context: CookieYesAdapterContext): AdapterOperationResult<VerificationResult> {
  const contribution = cookieYesVerificationContribution(context);
  return completed({ status: 'inconclusive', evidence: [...contribution.strong, ...contribution.supporting], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
}

export const cookieYesAdapter: ConsentProviderAdapter<'cookieyes'> = {
  metadata: {
    provider_id: 'cookieyes',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['web_app_banner'],
    supported_template_variants: ['consent_container', 'preference_center'],
    regions: null,
    tcf_capable: true,
    gpp_capable: false,
    iframe_support: false,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: true,
    stable_dom_interaction_support: true,
    preferences_flow_support: true,
    capability_maturity: {
      detection: 'fixture_only',
      state_read: 'documentation_supported',
      banner_state: 'fixture_only',
      available_actions: 'fixture_only',
      accept: 'documentation_supported',
      reject: 'documentation_supported',
      open_preferences: 'fixture_only',
      save_preferences: 'unsupported',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  getProviderEvidence(context) { return cookieYesProviderEvidence(context as CookieYesAdapterContext); },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'cookieyes');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(cookieYesConsentState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(cookieYesBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(cookieYesActionInventory(context).actions) : inconclusive<AvailableAction[]>([]);
  },
  accept(input) {
    const context = contextFrom(input);
    return context ? invokeAction(context, 'accept') : unsupported<InteractionAttempt>();
  },
  reject(input) {
    const context = contextFrom(input);
    return context ? invokeAction(context, 'reject') : unsupported<InteractionAttempt>();
  },
  openPreferences(input) {
    const context = contextFrom(input);
    return context ? invokeAction(context, 'preferences') : unsupported<InteractionAttempt>();
  },
  verifyAction(input) {
    const context = contextFrom(input);
    return context ? verifyCookieYesAction(context) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence(input) {
    const context = contextFrom(input);
    return context ? completed(cookieYesPersistenceEvidence(context)) : inconclusive<PersistenceResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  }
};

cmpAdapterRegistry.register(cookieYesAdapter);
