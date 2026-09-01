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
  type ConsentState,
  type InteractionAttempt,
  type PersistenceResult,
  type VerificationResult
} from './domain-types';
import type { ShadowMode } from './surface-utils';

export const USERCENTRICS_STANDARD_ROOT = 'aside#usercentrics-cmp-ui';

export type UsercentricsSemanticAction = 'accept_all' | 'reject_all' | 'open_preferences';

/**
 * A normalized control supplied by the browser bridge. Discovery uses normal
 * Playwright locators, which already traverse the current UI's open shadow root.
 * No accessible text is retained by this adapter.
 */
export interface UsercentricsControlObservation {
  id: string;
  semantic_action: UsercentricsSemanticAction;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  within_confirmed_usercentrics_surface: boolean;
  role: 'button' | 'link' | 'unknown';
  locale?: string;
}

export interface UsercentricsSurfaceObservation {
  selector: string;
  visible: boolean;
  shadow_mode: ShadowMode;
}

/**
 * Metadata-only storage evidence. Raw Web Storage values, fingerprints, and
 * consent identifiers are intentionally not accepted or returned here.
 */
export interface UsercentricsStorageDescriptor {
  key_name: 'ucData' | 'ucString';
  before_exists?: boolean;
  after_exists?: boolean;
  changed?: boolean;
  post_reload_exists?: boolean;
  post_reload_matches_after?: boolean;
}

/** A safe semantic state read contributed by a future browser/runtime bridge. */
export interface UsercentricsSemanticState {
  decision: ConsentState['decision'];
  categories?: ConsentState['categories'];
}

/** Input is transient browser evidence; no Usercentrics API invoker is exposed. */
export interface UsercentricsAdapterContext {
  uc_ui_type?: 'object' | 'function' | 'undefined' | 'unknown';
  asset_urls?: readonly string[];
  surfaces?: readonly UsercentricsSurfaceObservation[];
  controls?: readonly UsercentricsControlObservation[];
  storage?: readonly UsercentricsStorageDescriptor[];
  safe_provider_state?: UsercentricsSemanticState | null;
  /** Observational only; the adapter never invokes these methods. */
  observed_uc_ui_methods?: readonly string[];
  legacy_globals?: readonly string[];
  tcf_active?: boolean;
  gpp_active?: boolean;
  action_executed?: boolean;
  invoke_control?: (id: string) => boolean | Promise<boolean>;
}

export interface UsercentricsActionInventory {
  actions: AvailableAction[];
  user_facing_reject_available: boolean;
  preferences_flow_available: boolean;
  provider_api_reject_available: false;
}

export interface UsercentricsStateContribution {
  provider_state: ConsentState | null;
  framework_context: string[];
}

export interface UsercentricsVerificationContribution {
  strong: string[];
  supporting: string[];
}

function hasCurrentLoader(values: readonly string[] | undefined) {
  return values?.some((value) => /web\.cmp\.usercentrics\.eu\/ui\/loader\.js(?:[?#]|$)/i.test(value)) || false;
}

function hasLegacyEvidence(context: UsercentricsAdapterContext) {
  return context.legacy_globals?.some((value) => value === '__ucCmp' || value === 'UC_UI') || false;
}

function isActionable(control: UsercentricsControlObservation | undefined) {
  return Boolean(control?.visible && control.enabled && control.actionable && control.within_confirmed_usercentrics_surface);
}

function semanticControl(context: UsercentricsAdapterContext, action: UsercentricsSemanticAction) {
  return context.controls?.find((control) => control.semantic_action === action && isActionable(control));
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as UsercentricsAdapterContext : null;
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

/** TCF/GPP are deliberately absent: framework presence does not identify Usercentrics. */
export function usercentricsProviderEvidence(context: UsercentricsAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (context.uc_ui_type === 'object') {
    evidence.push({ provider_id: 'usercentrics', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' });
  }
  if (hasCurrentLoader(context.asset_urls)) {
    evidence.push({ provider_id: 'usercentrics', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' });
  }
  if (context.surfaces?.some((surface) => surface.selector === USERCENTRICS_STANDARD_ROOT)) {
    evidence.push({ provider_id: 'usercentrics', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' });
  }
  if (hasLegacyEvidence(context)) {
    evidence.push({ provider_id: 'usercentrics', family: 'provider_network', kind: 'provider_specific_network', specificity: 'provider_specific' });
  }
  return evidence;
}

export function detectUsercentrics(context: UsercentricsAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(usercentricsProviderEvidence(context)).find((item) => item.provider_id === 'usercentrics');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  return candidate.high_confidence
    ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
    : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
}

/** Provider presence and the visible UI surface are independent observations. */
export function usercentricsBannerState(context: UsercentricsAdapterContext): BannerState {
  const root = context.surfaces?.find((surface) => surface.selector === USERCENTRICS_STANDARD_ROOT);
  if (!root) return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  if (root.shadow_mode === 'closed') {
    return {
      surface: root.visible ? 'dialog' : 'unknown', visibility: root.visible ? 'visible' : 'unknown', evidence: ['usercentrics_standard_root'],
      reason_codes: [ConsentAuditCodes.CLOSED_SHADOW_ROOT, ...(root.visible ? [ConsentAuditCodes.BANNER_VISIBLE] : [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN])]
    };
  }
  return root.visible
    ? { surface: 'dialog', visibility: 'visible', evidence: ['usercentrics_standard_root', ...(root.shadow_mode === 'open' ? ['open_shadow_root'] : [])], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] }
    : { surface: 'none', visibility: 'not_visible', evidence: ['usercentrics_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

/** A safe provider state is kept distinct from framework state and from persistence evidence. */
export function usercentricsStateContribution(context: UsercentricsAdapterContext): UsercentricsStateContribution {
  const framework_context: string[] = [];
  if (context.tcf_active) framework_context.push('tcf_framework_active');
  if (context.gpp_active) framework_context.push('gpp_framework_active');
  const safe = context.safe_provider_state;
  const provider_state = safe
    ? { decision: safe.decision, categories: [...(safe.categories || [])], evidence: ['usercentrics_safe_provider_state'], reason_codes: [] }
    : null;
  return { provider_state, framework_context };
}

export function usercentricsConsentState(context: UsercentricsAdapterContext): ConsentState {
  const contribution = usercentricsStateContribution(context);
  if (contribution.provider_state) {
    return { ...contribution.provider_state, evidence: [...contribution.provider_state.evidence, ...contribution.framework_context] };
  }
  return {
    decision: 'ambiguous', categories: [], evidence: contribution.framework_context,
    reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  };
}

/** Actions are normalized by accessible semantics before this adapter receives them; no locale-specific labels are matched here. */
export function usercentricsActionInventory(context: UsercentricsAdapterContext): UsercentricsActionInventory {
  const accept = semanticControl(context, 'accept_all');
  const reject = semanticControl(context, 'reject_all');
  const preferences = semanticControl(context, 'open_preferences');
  return {
    actions: [
      { action: 'accept_all', availability: accept ? 'direct' : 'not_present', category: null, evidence: accept ? ['usercentrics_semantic_accept'] : [], reason_codes: accept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : [] },
      {
        action: 'reject_all', availability: reject ? 'direct' : preferences ? 'preferences_only' : 'not_present', category: null,
        evidence: reject ? ['usercentrics_semantic_reject'] : preferences ? ['usercentrics_semantic_preferences'] : [],
        reason_codes: reject ? [ConsentAuditCodes.REJECT_AVAILABLE] : preferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE]
      },
      { action: 'open_preferences', availability: preferences ? 'direct' : 'not_present', category: null, evidence: preferences ? ['usercentrics_semantic_preferences'] : [], reason_codes: preferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : [] }
    ],
    user_facing_reject_available: Boolean(reject),
    preferences_flow_available: Boolean(preferences),
    provider_api_reject_available: false
  };
}

/** Metadata descriptors can confirm persistence across reload, but never semantic rejection. */
export function usercentricsPersistenceEvidence(context: UsercentricsAdapterContext): PersistenceResult {
  const descriptors = context.storage || [];
  const evidence = descriptors.flatMap((descriptor) => {
    const prefix = descriptor.key_name === 'ucData' ? 'usercentrics_uc_data' : 'usercentrics_uc_string';
    return [
      ...(descriptor.changed ? [`${prefix}_changed`] : []),
      ...(descriptor.post_reload_exists ? [`${prefix}_present_after_reload`] : [])
    ];
  });
  const confirmed = descriptors.some((descriptor) => descriptor.changed && descriptor.post_reload_exists && descriptor.post_reload_matches_after);
  return {
    status: confirmed ? 'confirmed' : 'inconclusive', evidence,
    reason_codes: [confirmed ? ConsentAuditCodes.PERSISTENCE_CONFIRMED : ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
  };
}

/** Provider state may be strong evidence; storage remains supporting evidence and never verifies Reject alone. */
export function usercentricsVerificationContribution(context: UsercentricsAdapterContext): UsercentricsVerificationContribution {
  const strong = context.safe_provider_state ? ['usercentrics_safe_provider_state'] : [];
  const supporting: string[] = [];
  if (context.action_executed) supporting.push('usercentrics_semantic_action_invoked');
  for (const descriptor of context.storage || []) {
    if (descriptor.changed) supporting.push(descriptor.key_name === 'ucData' ? 'usercentrics_uc_data_changed' : 'usercentrics_uc_string_changed');
    if (descriptor.post_reload_exists) supporting.push(descriptor.key_name === 'ucData' ? 'usercentrics_uc_data_present_after_reload' : 'usercentrics_uc_string_present_after_reload');
  }
  return { strong, supporting };
}

async function invokeSemanticControl(
  context: UsercentricsAdapterContext,
  control: UsercentricsControlObservation,
  action: InteractionAttempt['action']
): Promise<AdapterOperationResult<InteractionAttempt>> {
  if (!context.invoke_control) return unsupported();
  const executed = await context.invoke_control(control.id);
  return executed
    ? completed({ action, origin: 'semantic_ui', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
    : inconclusive({ action, origin: 'semantic_ui', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
}

function verifyUsercentricsAction(context: UsercentricsAdapterContext): AdapterOperationResult<VerificationResult> {
  const contribution = usercentricsVerificationContribution(context);
  return completed({
    status: 'inconclusive', evidence: [...contribution.strong, ...contribution.supporting], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  });
}

export const usercentricsAdapter: ConsentProviderAdapter<'usercentrics'> = {
  metadata: {
    provider_id: 'usercentrics',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['current_web_cmp_ui'],
    supported_template_variants: ['open_shadow_root'],
    regions: null,
    tcf_capable: true,
    gpp_capable: true,
    iframe_support: false,
    shadow_root_support: true,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: false,
    stable_dom_interaction_support: true,
    preferences_flow_support: true,
    capability_maturity: {
      detection: 'fixture_only',
      state_read: 'supporting_only',
      banner_state: 'fixture_only',
      available_actions: 'fixture_only',
      accept: 'fixture_only',
      reject: 'fixture_only',
      open_preferences: 'fixture_only',
      save_preferences: 'unsupported',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  getProviderEvidence(context) { return usercentricsProviderEvidence(context as UsercentricsAdapterContext); },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'usercentrics');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(usercentricsConsentState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(usercentricsBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(usercentricsActionInventory(context).actions) : inconclusive<AvailableAction[]>([]);
  },
  accept(input) {
    const context = contextFrom(input);
    const control = context && semanticControl(context, 'accept_all');
    return context && control ? invokeSemanticControl(context, control, 'accept_all') : unsupported<InteractionAttempt>();
  },
  reject(input) {
    const context = contextFrom(input);
    const control = context && semanticControl(context, 'reject_all');
    return context && control ? invokeSemanticControl(context, control, 'reject_all') : unsupported<InteractionAttempt>();
  },
  openPreferences(input) {
    const context = contextFrom(input);
    const control = context && semanticControl(context, 'open_preferences');
    return context && control ? invokeSemanticControl(context, control, 'open_preferences') : unsupported<InteractionAttempt>();
  },
  verifyAction(input) {
    const context = contextFrom(input);
    return context ? verifyUsercentricsAction(context) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence(input) {
    const context = contextFrom(input);
    return context ? completed(usercentricsPersistenceEvidence(context)) : inconclusive<PersistenceResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  }
};

cmpAdapterRegistry.register(usercentricsAdapter);
