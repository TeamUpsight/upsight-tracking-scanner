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

export const DIDOMI_STANDARD_ROOTS = ['#didomi-host', '#didomi-notice'] as const;
export const DIDOMI_PUBLIC_METHODS = [
  'getCurrentUserStatus',
  'notice.isVisible',
  'setUserAgreeToAll',
  'setUserDisagreeToAll',
  'preferences.show'
] as const;

export type DidomiPublicMethod = typeof DIDOMI_PUBLIC_METHODS[number];
export type DidomiActionMethod = 'setUserAgreeToAll' | 'setUserDisagreeToAll' | 'preferences.show';
export type DidomiSemanticAction = 'accept_all' | 'reject_all' | 'open_preferences';
export type DidomiControlOrigin = 'provider_selector' | 'semantic_ui';

/** A stable provider selector or semantic control found only within a confirmed Didomi root. */
export interface DidomiControlObservation {
  id: string;
  semantic_action: DidomiSemanticAction;
  origin: DidomiControlOrigin;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  within_confirmed_didomi_surface: boolean;
}

export interface DidomiSurfaceObservation {
  selector: string;
  visible: boolean;
}

/** A privacy-safe summary of Didomi.getCurrentUserStatus(), never its identifiers or raw structure. */
export interface DidomiUserStatusSummary {
  decision: ConsentDecision;
  enabled_purpose_count?: number;
  disabled_purpose_count?: number;
  enabled_vendor_count?: number;
  disabled_vendor_count?: number;
}

export interface DidomiRuntimeState {
  current_user_status: DidomiUserStatusSummary | null;
  notice_visible: boolean | null;
}

/** Storage key metadata only; values and Didomi Consent String payloads are excluded. */
export interface DidomiStorageDescriptor {
  key_name: 'didomi_token' | 'didomi_dcs';
  exists: boolean;
  value_length?: number;
}

/** Input is transient browser evidence; outputs omit raw status maps and storage values. */
export interface DidomiAdapterContext {
  window_globals?: readonly string[];
  asset_urls?: readonly string[];
  surfaces?: readonly DidomiSurfaceObservation[];
  controls?: readonly DidomiControlObservation[];
  public_methods?: readonly string[];
  runtime?: DidomiRuntimeState | null;
  provider_events?: readonly string[];
  storage?: readonly DidomiStorageDescriptor[];
  tcf_active?: boolean;
  gpp_active?: boolean;
  action_executed?: boolean;
  invoke_control?: (id: string) => boolean | Promise<boolean>;
  invoke_public_method?: (method: DidomiActionMethod) => boolean | Promise<boolean>;
}

export interface DidomiActionInventory {
  actions: AvailableAction[];
  user_facing_reject_available: boolean;
  provider_api_reject_available: boolean;
  preferences_flow_available: boolean;
}

export interface DidomiVerificationContribution {
  strong: string[];
  supporting: string[];
}

const DIDOMI_EVENTS = new Set(['consent.changed', 'preferences.clickdisagreetoall', 'notice.clickdisagree']);

function hasExact(values: readonly string[] | undefined, expected: string) {
  return values?.some((value) => value === expected) || false;
}

function hasDidomiSdkAsset(values: readonly string[] | undefined) {
  return values?.some((value) => /(?:sdk\.privacy-center\.org\/loader\.js|sdk\.privacy-center\.org|didomi\.(?:io|cloud)\/.+(?:sdk|loader))/i.test(value)) || false;
}

function isDidomiRoot(selector: string) {
  return (DIDOMI_STANDARD_ROOTS as readonly string[]).includes(selector);
}

function hasPublicMethod(context: DidomiAdapterContext, method: DidomiPublicMethod) {
  return hasExact(context.public_methods, method);
}

function isActionable(control: DidomiControlObservation | undefined) {
  return Boolean(control?.visible && control.enabled && control.actionable && control.within_confirmed_didomi_surface);
}

function actionControl(context: DidomiAdapterContext, action: DidomiSemanticAction) {
  return context.controls?.find((control) => control.semantic_action === action && isActionable(control));
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as DidomiAdapterContext : null;
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

/** Generic TCF presence is intentionally absent: only Didomi-specific signals can attribute the provider. */
export function didomiProviderEvidence(context: DidomiAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (hasExact(context.window_globals, 'Didomi')) {
    evidence.push({ provider_id: 'didomi', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' });
  }
  if (hasDidomiSdkAsset(context.asset_urls) || hasExact(context.window_globals, 'didomiOnReady') || hasExact(context.window_globals, 'didomiConfig')) {
    evidence.push({ provider_id: 'didomi', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' });
  }
  if (context.surfaces?.some((surface) => isDidomiRoot(surface.selector))) {
    evidence.push({ provider_id: 'didomi', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' });
  }
  if (context.storage?.some((descriptor) => descriptor.exists && (descriptor.key_name === 'didomi_token' || descriptor.key_name === 'didomi_dcs'))) {
    evidence.push({ provider_id: 'didomi', family: 'provider_persistence', kind: 'provider_persistence_key', specificity: 'provider_specific' });
  }
  if (context.provider_events?.some((event) => DIDOMI_EVENTS.has(event))) {
    evidence.push({ provider_id: 'didomi', family: 'provider_state', kind: 'provider_state_or_event', specificity: 'provider_specific' });
  }
  return evidence;
}

export function detectDidomi(context: DidomiAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(didomiProviderEvidence(context)).find((item) => item.provider_id === 'didomi');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  return candidate.high_confidence
    ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
    : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
}

/** Runtime notice visibility and DOM visibility are distinct facts and contradictions remain inconclusive. */
export function didomiBannerState(context: DidomiAdapterContext): BannerState {
  const roots = context.surfaces?.filter((surface) => isDidomiRoot(surface.selector)) || [];
  const rootVisible = roots.some((surface) => surface.visible);
  const rootHidden = roots.length > 0 && !rootVisible;
  const apiVisible = hasPublicMethod(context, 'notice.isVisible') ? context.runtime?.notice_visible : null;
  if ((rootVisible && apiVisible === false) || (rootHidden && apiVisible === true)) {
    return { surface: 'unknown', visibility: 'unknown', evidence: ['didomi_notice_visibility_contradiction'], reason_codes: [ConsentAuditCodes.STATE_CONTRADICTION, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
  }
  if (rootVisible || apiVisible === true) {
    return {
      surface: 'banner', visibility: 'visible',
      evidence: [
        ...(rootVisible ? ['didomi_standard_root'] : []),
        ...(apiVisible === true ? ['didomi_notice_visible_api'] : [])
      ],
      reason_codes: [ConsentAuditCodes.BANNER_VISIBLE]
    };
  }
  if (rootHidden || apiVisible === false) {
    return {
      surface: 'none', visibility: 'not_visible',
      evidence: [
        ...(rootHidden ? ['didomi_standard_root'] : []),
        ...(apiVisible === false ? ['didomi_notice_visible_api'] : [])
      ],
      reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE]
    };
  }
  return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

/** State comes only from a safe Didomi runtime summary, never from a TCF string or persistence key. */
export function didomiConsentState(context: DidomiAdapterContext): ConsentState {
  const state = context.runtime?.current_user_status;
  const evidence: string[] = [];
  if (hasPublicMethod(context, 'getCurrentUserStatus')) evidence.push('didomi_current_user_status_api_available');
  if (state) evidence.push('didomi_current_user_status_read');
  if (context.provider_events?.some((event) => DIDOMI_EVENTS.has(event))) evidence.push('didomi_state_event');
  if (context.tcf_active) evidence.push('tcf_framework_active');
  if (context.gpp_active) evidence.push('gpp_framework_active');
  return {
    decision: state?.decision || 'ambiguous', categories: [], evidence,
    reason_codes: state ? [] : [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  };
}

export function didomiActionInventory(context: DidomiAdapterContext): DidomiActionInventory {
  const acceptControl = actionControl(context, 'accept_all');
  const rejectControl = actionControl(context, 'reject_all');
  const preferencesControl = actionControl(context, 'open_preferences');
  const apiAccept = hasPublicMethod(context, 'setUserAgreeToAll');
  const apiReject = hasPublicMethod(context, 'setUserDisagreeToAll');
  const apiPreferences = hasPublicMethod(context, 'preferences.show');
  return {
    actions: [
      {
        action: 'accept_all', availability: acceptControl ? 'direct' : apiAccept ? 'api_only' : 'not_present', category: null,
        evidence: acceptControl ? ['didomi_accept_control'] : apiAccept ? ['didomi_set_agree_to_all_api'] : [],
        reason_codes: acceptControl || apiAccept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : []
      },
      {
        action: 'reject_all', availability: rejectControl ? 'direct' : preferencesControl ? 'preferences_only' : apiReject ? 'api_only' : 'not_present', category: null,
        evidence: rejectControl ? ['didomi_reject_control'] : preferencesControl ? ['didomi_preferences_control'] : apiReject ? ['didomi_set_disagree_to_all_api'] : [],
        reason_codes: rejectControl ? [ConsentAuditCodes.REJECT_AVAILABLE]
          : preferencesControl ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY]
            : apiReject ? [] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE]
      },
      {
        action: 'open_preferences', availability: preferencesControl ? 'direct' : apiPreferences ? 'api_only' : 'not_present', category: null,
        evidence: preferencesControl ? ['didomi_preferences_control'] : apiPreferences ? ['didomi_preferences_show_api'] : [],
        reason_codes: preferencesControl || apiPreferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : []
      }
    ],
    user_facing_reject_available: Boolean(rejectControl),
    provider_api_reject_available: apiReject,
    preferences_flow_available: Boolean(preferencesControl || apiPreferences)
  };
}

export function didomiPersistenceEvidence(context: DidomiAdapterContext): PersistenceResult {
  const keys = (context.storage || []).filter((descriptor) => descriptor.exists).map((descriptor) => descriptor.key_name);
  return {
    status: 'inconclusive', evidence: keys.map((key) => `didomi_persistence_key:${key}`),
    reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
  };
}

/** Events remain supporting evidence; they become more useful only when paired with a fresh state read. */
export function didomiVerificationContribution(context: DidomiAdapterContext): DidomiVerificationContribution {
  const events = context.provider_events?.filter((event) => DIDOMI_EVENTS.has(event)) || [];
  const strong = context.runtime?.current_user_status && events.includes('consent.changed')
    ? ['didomi_state_read_after_consent_changed']
    : [];
  const supporting: string[] = [];
  if (context.action_executed) supporting.push('didomi_action_invoked');
  if (events.length) supporting.push('didomi_event_observed');
  if (context.runtime?.current_user_status) supporting.push('didomi_current_user_status_read');
  if (context.storage?.some((descriptor) => descriptor.exists)) supporting.push('didomi_persistence_key_present');
  return { strong, supporting };
}

async function invokeAction(
  context: DidomiAdapterContext,
  action: 'accept' | 'reject' | 'preferences'
): Promise<AdapterOperationResult<InteractionAttempt>> {
  const actionType = action === 'accept' ? 'accept_all' : action === 'reject' ? 'reject_all' : 'open_preferences';
  const control = actionControl(context, actionType);
  const method: DidomiActionMethod = action === 'accept' ? 'setUserAgreeToAll' : action === 'reject' ? 'setUserDisagreeToAll' : 'preferences.show';
  if (control && context.invoke_control) {
    const executed = await context.invoke_control(control.id);
    return executed
      ? completed({ action: actionType, origin: control.origin, outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
      : inconclusive({ action: actionType, origin: control.origin, outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
  }
  if (hasPublicMethod(context, method) && context.invoke_public_method) {
    const executed = await context.invoke_public_method(method);
    return executed
      ? completed({ action: actionType, origin: 'provider_api', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
      : inconclusive({ action: actionType, origin: 'provider_api', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
  }
  return unsupported();
}

function verifyDidomiAction(context: DidomiAdapterContext): AdapterOperationResult<VerificationResult> {
  const contribution = didomiVerificationContribution(context);
  return completed({
    status: 'inconclusive', evidence: [...contribution.strong, ...contribution.supporting], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  });
}

export const didomiAdapter: ConsentProviderAdapter<'didomi'> = {
  metadata: {
    provider_id: 'didomi',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['web_sdk'],
    supported_template_variants: ['notice', 'preferences'],
    regions: null,
    tcf_capable: true,
    gpp_capable: true,
    iframe_support: true,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: true,
    stable_dom_interaction_support: true,
    preferences_flow_support: true,
    capability_maturity: {
      detection: 'fixture_only',
      state_read: 'documentation_supported',
      banner_state: 'documentation_supported',
      available_actions: 'fixture_only',
      accept: 'documentation_supported',
      reject: 'documentation_supported',
      open_preferences: 'documentation_supported',
      save_preferences: 'unsupported',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  getProviderEvidence(context) { return didomiProviderEvidence(context as DidomiAdapterContext); },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'didomi');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(didomiConsentState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(didomiBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(didomiActionInventory(context).actions) : inconclusive<AvailableAction[]>([]);
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
    return context ? verifyDidomiAction(context) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence(input) {
    const context = contextFrom(input);
    return context ? completed(didomiPersistenceEvidence(context)) : inconclusive<PersistenceResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  }
};

cmpAdapterRegistry.register(didomiAdapter);
