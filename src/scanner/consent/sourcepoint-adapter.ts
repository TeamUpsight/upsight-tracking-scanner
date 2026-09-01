import type { Locator, Page } from 'playwright-core';
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
  type ConsentDecision,
  type ConsentState,
  type InteractionAttempt,
  type PersistenceResult,
  type VerificationResult
} from './domain-types';
import { frameLocatorForIframe, resolveContentFrame } from './surface-utils';

export const SOURCEPOINT_FIRST_LAYER_CLASSES = {
  accept: 'sp_choice_type_11',
  reject: 'sp_choice_type_13',
  preferences: 'sp_choice_type_12'
} as const;
export const SOURCEPOINT_PRIVACY_MANAGER_CLASSES = {
  accept: 'sp_choice_type_ACCEPT_ALL',
  reject: 'sp_choice_type_REJECT_ALL',
  save: 'sp_choice_type_SAVE_AND_EXIT'
} as const;

export type SourcepointSurface = 'first_layer' | 'privacy_manager';
export type SourcepointAction = 'accept_all' | 'reject_all' | 'open_preferences' | 'save_preferences';
export type SourcepointControlClass =
  | typeof SOURCEPOINT_FIRST_LAYER_CLASSES[keyof typeof SOURCEPOINT_FIRST_LAYER_CLASSES]
  | typeof SOURCEPOINT_PRIVACY_MANAGER_CLASSES[keyof typeof SOURCEPOINT_PRIVACY_MANAGER_CLASSES];

/**
 * A control discovered through Playwright Frame/FrameLocator APIs. frame_path
 * is descriptive only; no coordinate interaction or same-origin DOM access is
 * required for a Playwright frame locator.
 */
export interface SourcepointFrameControlObservation {
  action_class: SourcepointControlClass;
  surface: SourcepointSurface;
  frame_path: string[];
  frame_attached: boolean;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  within_confirmed_sourcepoint_surface: boolean;
}

export interface SourcepointFrameSurfaceObservation {
  selector: string;
  surface: SourcepointSurface;
  frame_path: string[];
  frame_attached: boolean;
  visible: boolean;
}

/** A summary supplied by the shared TCF/GPP observers, not a duplicate parser. */
export interface SourcepointFrameworkContribution {
  tcf_present?: boolean;
  tcf_event_status?: 'cmpuishown' | 'tcloaded' | 'useractioncomplete' | 'unknown';
  tcf_purpose_decision?: ConsentDecision;
  tcf_vendor_decision?: ConsentDecision;
  gpp_present?: boolean;
}

/** Sourcepoint storage metadata only. Property identifiers and raw values are excluded from output. */
export interface SourcepointStorageDescriptor {
  key_name: string;
  storage_type: 'cookie' | 'local_storage';
  exists: boolean;
  value_length?: number;
  changed?: boolean;
  post_reload_exists?: boolean;
  post_reload_matches_after?: boolean;
}

export interface SourcepointAdapterContext {
  window_globals?: readonly string[];
  asset_urls?: readonly string[];
  /** Normalized endpoint host evidence, including a DNS-verified Sourcepoint CNAME when available. */
  sourcepoint_cname_endpoint_verified?: boolean;
  surfaces?: readonly SourcepointFrameSurfaceObservation[];
  controls?: readonly SourcepointFrameControlObservation[];
  active_surface?: SourcepointSurface | null;
  /** True only when a required Privacy Manager configuration was safely obtained from public runtime/config/callback facts. */
  privacy_manager_configuration_available?: boolean;
  framework?: SourcepointFrameworkContribution | null;
  storage?: readonly SourcepointStorageDescriptor[];
  action_executed?: boolean;
  invoke_control?: (actionClass: SourcepointControlClass, framePath: readonly string[]) => boolean | Promise<boolean>;
}

export interface SourcepointActionInventory {
  actions: AvailableAction[];
  user_facing_reject_available: boolean;
  privacy_manager_configuration_available: boolean;
  limitations: string[];
}

export interface SourcepointVerificationContribution {
  strong: string[];
  supporting: string[];
}

/** Native Playwright frame access; cross-origin frames are handled by Playwright, never coordinates. */
export function sourcepointFrameLocator(page: Page, iframeSelector: string) {
  return frameLocatorForIframe(page, iframeSelector);
}

/** Maps attachment races to the shared, explicit cross-origin-frame diagnostic. */
export async function resolveSourcepointFrame(iframe: Locator) {
  return resolveContentFrame(iframe);
}

function hasExact(values: readonly string[] | undefined, expected: string) {
  return values?.some((value) => value === expected) || false;
}

function hasSourcepointAsset(values: readonly string[] | undefined) {
  return values?.some((value) => /(?:cdn\.privacy-mgmt\.com|sourcepoint\.com\/(?:cdn|wrapper|messaging))/i.test(value)) || false;
}

function isSourcepointSurface(selector: string) {
  return /^#?sp_message_(?:container|iframe)_[A-Za-z0-9_-]+$/i.test(selector);
}

function isSourcepointStorage(descriptor: SourcepointStorageDescriptor) {
  return descriptor.exists && (
    /^_sp_(?:user_consent|local_state|non_keyed_local_state)(?:_|$)/i.test(descriptor.key_name) ||
    /^_sp_v1_(?:ss|freqcap)$/i.test(descriptor.key_name) ||
    descriptor.key_name === 'sp_v1_freqcap'
  );
}

function isActionable(control: SourcepointFrameControlObservation | undefined) {
  return Boolean(control?.frame_attached && control.visible && control.enabled && control.actionable && control.within_confirmed_sourcepoint_surface);
}

function sourcepointControl(
  context: SourcepointAdapterContext,
  surface: SourcepointSurface,
  actionClass: SourcepointControlClass
) {
  return context.controls?.find((control) => control.surface === surface && control.action_class === actionClass && isActionable(control));
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as SourcepointAdapterContext : null;
}

function completed<T>(value: T): AdapterOperationResult<T> {
  return { status: 'completed', value, reason_codes: [] };
}

function inconclusive<T>(value: T, reasonCodes: ConsentAuditCode[] = [ConsentAuditCodes.DETECTION_INCONCLUSIVE]) {
  return { status: 'inconclusive' as const, value, reason_codes: reasonCodes };
}

function unsupported<T>(reasonCodes: ConsentAuditCode[] = [ConsentAuditCodes.ACTION_NOT_EXPOSED]) {
  return { status: 'unsupported' as const, value: null, reason_codes: reasonCodes };
}

/** Shared TCF/GPP facts are intentionally absent from provider attribution. */
export function sourcepointProviderEvidence(context: SourcepointAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (hasExact(context.window_globals, '_sp_')) {
    evidence.push({ provider_id: 'sourcepoint', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' });
  }
  if (hasExact(context.window_globals, '_sp_queue') || hasSourcepointAsset(context.asset_urls)) {
    evidence.push({ provider_id: 'sourcepoint', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' });
  }
  if (context.surfaces?.some((surface) => isSourcepointSurface(surface.selector))) {
    evidence.push({ provider_id: 'sourcepoint', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' });
  }
  if (context.sourcepoint_cname_endpoint_verified) {
    evidence.push({ provider_id: 'sourcepoint', family: 'provider_network', kind: 'provider_specific_network', specificity: 'provider_specific' });
  }
  if (context.storage?.some(isSourcepointStorage)) {
    evidence.push({ provider_id: 'sourcepoint', family: 'provider_persistence', kind: 'provider_persistence_key', specificity: 'provider_specific' });
  }
  return evidence;
}

export function detectSourcepoint(context: SourcepointAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(sourcepointProviderEvidence(context)).find((item) => item.provider_id === 'sourcepoint');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  return candidate.high_confidence
    ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
    : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
}

/** Detachment is an interaction diagnostic, never proof that Sourcepoint has no visible banner. */
export function sourcepointBannerState(context: SourcepointAdapterContext): BannerState {
  const surfaces = context.surfaces?.filter((surface) => isSourcepointSurface(surface.selector)) || [];
  if (surfaces.some((surface) => !surface.frame_attached)) {
    return { surface: 'unknown', visibility: 'unknown', evidence: ['sourcepoint_frame_detached'], reason_codes: [ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
  }
  const visible = surfaces.find((surface) => surface.visible);
  if (visible) {
    return {
      surface: visible.surface === 'privacy_manager' ? 'preference_center' : 'dialog', visibility: 'visible',
      evidence: ['sourcepoint_message_frame'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE]
    };
  }
  if (surfaces.length) return { surface: 'none', visibility: 'not_visible', evidence: ['sourcepoint_message_frame'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

/** TCF/GPP observations are forwarded as context only; this adapter does not read raw framework strings. */
export function sourcepointConsentState(context: SourcepointAdapterContext): ConsentState {
  const framework = context.framework;
  const evidence: string[] = [];
  if (framework?.tcf_present) evidence.push('tcf_framework_active');
  if (framework?.tcf_event_status) evidence.push(`tcf_event:${framework.tcf_event_status}`);
  if (framework?.gpp_present) evidence.push('gpp_framework_active');
  const decision = framework?.tcf_purpose_decision === 'rejected' && framework.tcf_vendor_decision === 'rejected'
    ? 'rejected'
    : 'ambiguous';
  return { decision, categories: [], evidence, reason_codes: decision === 'ambiguous' ? [ConsentAuditCodes.ACTION_INCONCLUSIVE] : [] };
}

function sourcepointActionControl(context: SourcepointAdapterContext, action: SourcepointAction) {
  const surface = context.active_surface;
  if (surface === 'first_layer') {
    if (action === 'accept_all') return sourcepointControl(context, surface, SOURCEPOINT_FIRST_LAYER_CLASSES.accept);
    if (action === 'reject_all') return sourcepointControl(context, surface, SOURCEPOINT_FIRST_LAYER_CLASSES.reject);
    if (action === 'open_preferences') return sourcepointControl(context, surface, SOURCEPOINT_FIRST_LAYER_CLASSES.preferences);
  }
  if (surface === 'privacy_manager') {
    if (action === 'accept_all') return sourcepointControl(context, surface, SOURCEPOINT_PRIVACY_MANAGER_CLASSES.accept);
    if (action === 'reject_all') return sourcepointControl(context, surface, SOURCEPOINT_PRIVACY_MANAGER_CLASSES.reject);
    if (action === 'save_preferences') return sourcepointControl(context, surface, SOURCEPOINT_PRIVACY_MANAGER_CLASSES.save);
  }
  return undefined;
}

export function sourcepointActionInventory(context: SourcepointAdapterContext): SourcepointActionInventory {
  const accept = sourcepointActionControl(context, 'accept_all');
  const reject = sourcepointActionControl(context, 'reject_all');
  const openPreferences = sourcepointActionControl(context, 'open_preferences');
  const save = sourcepointActionControl(context, 'save_preferences');
  const privacyManagerUnavailable = context.active_surface !== 'privacy_manager' && !openPreferences && !context.privacy_manager_configuration_available;
  return {
    actions: [
      { action: 'accept_all', availability: accept ? 'direct' : 'not_present', category: null, evidence: accept ? ['sourcepoint_active_surface_accept'] : [], reason_codes: accept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : [] },
      { action: 'reject_all', availability: reject ? 'direct' : openPreferences ? 'preferences_only' : 'not_present', category: null, evidence: reject ? ['sourcepoint_active_surface_reject'] : openPreferences ? ['sourcepoint_first_layer_preferences'] : [], reason_codes: reject ? [ConsentAuditCodes.REJECT_AVAILABLE] : openPreferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE] },
      { action: 'open_preferences', availability: openPreferences ? 'direct' : 'not_present', category: null, evidence: openPreferences ? ['sourcepoint_first_layer_preferences'] : [], reason_codes: openPreferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : [] },
      { action: 'save_preferences', availability: save ? 'direct' : 'not_present', category: null, evidence: save ? ['sourcepoint_privacy_manager_save'] : [], reason_codes: [] }
    ],
    user_facing_reject_available: Boolean(reject),
    privacy_manager_configuration_available: Boolean(context.privacy_manager_configuration_available),
    limitations: privacyManagerUnavailable ? ['privacy_manager_configuration_unavailable'] : []
  };
}

export function sourcepointPersistenceEvidence(context: SourcepointAdapterContext): PersistenceResult {
  const descriptors = (context.storage || []).filter(isSourcepointStorage);
  const confirmed = descriptors.some((descriptor) => descriptor.changed && descriptor.post_reload_exists && descriptor.post_reload_matches_after);
  return {
    status: confirmed ? 'confirmed' : 'inconclusive',
    evidence: [
      ...(descriptors.length ? ['sourcepoint_persistence_key_present'] : []),
      ...(descriptors.some((descriptor) => descriptor.changed) ? ['sourcepoint_persistence_key_changed'] : []),
      ...(descriptors.some((descriptor) => descriptor.post_reload_exists) ? ['sourcepoint_persistence_key_present_after_reload'] : [])
    ],
    reason_codes: [confirmed ? ConsentAuditCodes.PERSISTENCE_CONFIRMED : ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
  };
}

/** useractioncomplete is supporting only unless the shared resolver also reports matching purpose and vendor state. */
export function sourcepointVerificationContribution(context: SourcepointAdapterContext): SourcepointVerificationContribution {
  const framework = context.framework;
  const completed = framework?.tcf_event_status === 'useractioncomplete';
  const rejectedState = framework?.tcf_purpose_decision === 'rejected' && framework?.tcf_vendor_decision === 'rejected';
  const strong = completed && rejectedState ? ['sourcepoint_tcf_rejection_state_after_user_action'] : [];
  const supporting: string[] = [];
  if (context.action_executed) supporting.push('sourcepoint_action_invoked');
  if (completed) supporting.push('tcf_useractioncomplete');
  if (framework?.tcf_purpose_decision || framework?.tcf_vendor_decision) supporting.push('tcf_semantic_state_read');
  if (framework?.gpp_present) supporting.push('gpp_framework_active');
  if (context.storage?.some(isSourcepointStorage)) supporting.push('sourcepoint_persistence_key_present');
  return { strong, supporting };
}

async function invokeSourcepointAction(
  context: SourcepointAdapterContext,
  action: SourcepointAction
): Promise<AdapterOperationResult<InteractionAttempt>> {
  const control = sourcepointActionControl(context, action);
  if (!control) return unsupported();
  if (!control.frame_attached) return unsupported([ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR]);
  if (!context.invoke_control) return unsupported();
  const executed = await context.invoke_control(control.action_class, control.frame_path);
  return executed
    ? completed({ action, origin: 'provider_selector', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
    : inconclusive({ action, origin: 'provider_selector', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
}

function verifySourcepointAction(context: SourcepointAdapterContext): AdapterOperationResult<VerificationResult> {
  const contribution = sourcepointVerificationContribution(context);
  return completed({ status: 'inconclusive', evidence: [...contribution.strong, ...contribution.supporting], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
}

export const sourcepointAdapter: ConsentProviderAdapter<'sourcepoint'> = {
  metadata: {
    provider_id: 'sourcepoint',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['cmp_web'],
    supported_template_variants: ['first_layer_frame', 'privacy_manager_frame'],
    regions: null,
    tcf_capable: true,
    gpp_capable: true,
    iframe_support: true,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: false,
    stable_dom_interaction_support: true,
    preferences_flow_support: true,
    capability_maturity: {
      detection: 'fixture_only',
      state_read: 'supporting_only',
      banner_state: 'fixture_only',
      available_actions: 'fixture_only',
      accept: 'documentation_supported',
      reject: 'documentation_supported',
      open_preferences: 'documentation_supported',
      save_preferences: 'documentation_supported',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  getProviderEvidence(context) { return sourcepointProviderEvidence(context as SourcepointAdapterContext); },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'sourcepoint');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(sourcepointConsentState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(sourcepointBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(sourcepointActionInventory(context).actions) : inconclusive<AvailableAction[]>([]);
  },
  accept(input) {
    const context = contextFrom(input);
    return context ? invokeSourcepointAction(context, 'accept_all') : unsupported<InteractionAttempt>();
  },
  reject(input) {
    const context = contextFrom(input);
    return context ? invokeSourcepointAction(context, 'reject_all') : unsupported<InteractionAttempt>();
  },
  openPreferences(input) {
    const context = contextFrom(input);
    return context ? invokeSourcepointAction(context, 'open_preferences') : unsupported<InteractionAttempt>();
  },
  savePreferences(input) {
    const context = contextFrom(input);
    return context ? invokeSourcepointAction(context, 'save_preferences') : unsupported<InteractionAttempt>();
  },
  verifyAction(input) {
    const context = contextFrom(input);
    return context ? verifySourcepointAction(context) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence(input) {
    const context = contextFrom(input);
    return context ? completed(sourcepointPersistenceEvidence(context)) : inconclusive<PersistenceResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  }
};

cmpAdapterRegistry.register(sourcepointAdapter);
