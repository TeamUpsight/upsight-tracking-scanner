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

export const ONETRUST_STANDARD_ROOTS = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#onetrust-pc-sdk',
  '.ot-sdk-container'
] as const;

export const ONETRUST_DOCUMENTED_CONTROLS = {
  accept: '#onetrust-accept-btn-handler',
  reject: '#onetrust-reject-all-handler',
  preferences: '#onetrust-pc-btn-handler'
} as const;

export const ONETRUST_PUBLIC_METHODS = ['AllowAll', 'RejectAll', 'ToggleInfoDisplay'] as const;

export type OneTrustPublicMethod = typeof ONETRUST_PUBLIC_METHODS[number];
export type OneTrustControlSelector = typeof ONETRUST_DOCUMENTED_CONTROLS[keyof typeof ONETRUST_DOCUMENTED_CONTROLS];

export interface OneTrustSurfaceObservation {
  selector: string;
  visible: boolean;
}

export interface OneTrustControlObservation {
  selector: string;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
}

export interface OneTrustCookieDescriptor {
  name: string;
  exists: boolean;
  value_length?: number;
}

/**
 * This is an in-memory browser bridge only. It accepts identifiers briefly to
 * calculate a count, but all adapter outputs intentionally omit raw group ids
 * and raw OptanonConsent values.
 */
export interface OneTrustAdapterContext {
  window_globals?: readonly string[];
  asset_urls?: readonly string[];
  surfaces?: readonly OneTrustSurfaceObservation[];
  controls?: readonly OneTrustControlObservation[];
  cookies?: readonly OneTrustCookieDescriptor[];
  public_methods?: readonly string[];
  active_group_ids?: readonly string[];
  provider_events?: readonly string[];
  tcf_active?: boolean;
  gpp_active?: boolean;
  action_executed?: boolean;
  invoke_control?: (selector: OneTrustControlSelector) => boolean | Promise<boolean>;
  invoke_public_method?: (method: OneTrustPublicMethod) => boolean | Promise<boolean>;
}

export interface OneTrustActionInventory {
  actions: AvailableAction[];
  user_facing_reject_available: boolean;
  provider_api_reject_available: boolean;
}

export interface OneTrustVerificationContribution {
  strong: string[];
  supporting: string[];
}

function hasExact(values: readonly string[] | undefined, expected: string) {
  return values?.some((value) => value === expected) || false;
}

function containsOneTrustAsset(values: readonly string[] | undefined) {
  return values?.some((value) => /(?:cdn\.cookielaw\.org|onetrust\.com|otsdkstub\.js|optanon\.js)/i.test(value)) || false;
}

function isOneTrustRoot(selector: string) {
  return (ONETRUST_STANDARD_ROOTS as readonly string[]).includes(selector);
}

function actionControl(context: OneTrustAdapterContext, selector: OneTrustControlSelector) {
  return context.controls?.find((control) => control.selector === selector) || null;
}

function actionableControl(context: OneTrustAdapterContext, selector: OneTrustControlSelector) {
  const control = actionControl(context, selector);
  return Boolean(control?.visible && control.enabled && control.actionable);
}

function hasPublicMethod(context: OneTrustAdapterContext, method: OneTrustPublicMethod) {
  return hasExact(context.public_methods, method);
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as OneTrustAdapterContext : null;
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

/** Converts normalized browser facts into scored, provider-specific evidence. */
export function oneTrustProviderEvidence(context: OneTrustAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (hasExact(context.window_globals, 'OneTrust') || hasExact(context.window_globals, 'Optanon')) {
    evidence.push({ provider_id: 'onetrust', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' });
  }
  if (containsOneTrustAsset(context.asset_urls)) {
    evidence.push({ provider_id: 'onetrust', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' });
  }
  if (context.surfaces?.some((surface) => isOneTrustRoot(surface.selector))) {
    evidence.push({ provider_id: 'onetrust', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' });
  }
  if (context.cookies?.some((cookie) => cookie.exists && (cookie.name === 'OptanonConsent' || cookie.name === 'OptanonAlertBoxClosed'))) {
    evidence.push({ provider_id: 'onetrust', family: 'provider_persistence', kind: 'provider_persistence_key', specificity: 'provider_specific' });
  }
  if (context.provider_events?.some((event) => event === 'OneTrustGroupsUpdated' || event === 'OTConsentApplied')) {
    evidence.push({ provider_id: 'onetrust', family: 'provider_state', kind: 'provider_state_or_event', specificity: 'provider_specific' });
  }
  return evidence;
}

export function detectOneTrust(context: OneTrustAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(oneTrustProviderEvidence(context)).find((item) => item.provider_id === 'onetrust');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  if (candidate.high_confidence) {
    return {
      status: 'detected',
      evidence: candidate.independent_families,
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    };
  }
  return {
    status: 'inconclusive',
    evidence: candidate.independent_families,
    reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE]
  };
}

/** Banner visibility is intentionally independent from OneTrust provider detection. */
export function oneTrustBannerState(context: OneTrustAdapterContext): BannerState {
  const roots = context.surfaces?.filter((surface) => isOneTrustRoot(surface.selector)) || [];
  const visible = roots.find((surface) => surface.visible);
  if (visible) {
    const surface = visible.selector === '#onetrust-pc-sdk' ? 'preference_center' : 'banner';
    return { surface, visibility: 'visible', evidence: ['onetrust_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] };
  }
  if (roots.length) {
    return { surface: 'none', visibility: 'not_visible', evidence: ['onetrust_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  }
  return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

export function oneTrustActionInventory(context: OneTrustAdapterContext): OneTrustActionInventory {
  const directAccept = actionableControl(context, ONETRUST_DOCUMENTED_CONTROLS.accept);
  const directReject = actionableControl(context, ONETRUST_DOCUMENTED_CONTROLS.reject);
  const directPreferences = actionableControl(context, ONETRUST_DOCUMENTED_CONTROLS.preferences);
  const apiAccept = hasPublicMethod(context, 'AllowAll');
  const apiReject = hasPublicMethod(context, 'RejectAll');
  const apiPreferences = hasPublicMethod(context, 'ToggleInfoDisplay');
  const actions: AvailableAction[] = [
    {
      action: 'accept_all',
      availability: directAccept ? 'direct' : apiAccept ? 'api_only' : 'not_present',
      category: null,
      evidence: directAccept ? ['onetrust_accept_control'] : apiAccept ? ['onetrust_allow_all_api'] : [],
      reason_codes: directAccept || apiAccept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : []
    },
    {
      action: 'reject_all',
      availability: directReject ? 'direct' : directPreferences ? 'preferences_only' : apiReject ? 'api_only' : 'not_present',
      category: null,
      evidence: directReject ? ['onetrust_reject_control'] : directPreferences ? ['onetrust_preferences_control'] : apiReject ? ['onetrust_reject_all_api'] : [],
      reason_codes: directReject ? [ConsentAuditCodes.REJECT_AVAILABLE]
        : directPreferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY]
          : apiReject ? [] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE]
    },
    {
      action: 'open_preferences',
      availability: directPreferences ? 'direct' : apiPreferences ? 'api_only' : 'not_present',
      category: null,
      evidence: directPreferences ? ['onetrust_preferences_control'] : apiPreferences ? ['onetrust_toggle_info_display_api'] : [],
      reason_codes: directPreferences || apiPreferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : []
    }
  ];
  return {
    actions,
    user_facing_reject_available: directReject,
    provider_api_reject_available: apiReject
  };
}

/** Active groups are tenant-defined; this intentionally returns only their count. */
export function oneTrustConsentState(context: OneTrustAdapterContext): ConsentState {
  const groupCount = Math.min(context.active_group_ids?.length || 0, 200);
  const evidence: string[] = [];
  if (context.active_group_ids) evidence.push(`onetrust_active_group_count:${groupCount}`);
  if (context.cookies?.some((cookie) => cookie.name === 'OptanonConsent' && cookie.exists)) evidence.push('optanon_consent_present');
  if (context.provider_events?.some((event) => event === 'OneTrustGroupsUpdated' || event === 'OTConsentApplied')) evidence.push('onetrust_state_event');
  if (context.tcf_active) evidence.push('tcf_framework_active');
  if (context.gpp_active) evidence.push('gpp_framework_active');
  return { decision: 'ambiguous', categories: [], evidence, reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] };
}

export function oneTrustPersistenceEvidence(context: OneTrustAdapterContext): PersistenceResult {
  const present = context.cookies?.some((cookie) => cookie.exists && (cookie.name === 'OptanonConsent' || cookie.name === 'OptanonAlertBoxClosed')) || false;
  return {
    status: 'inconclusive',
    evidence: present ? ['onetrust_persistence_key_present'] : [],
    reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
  };
}

/** A contribution for a later global verifier; this never claims a verified consent outcome. */
export function oneTrustVerificationContribution(context: OneTrustAdapterContext): OneTrustVerificationContribution {
  const strong = context.action_executed ? ['onetrust_documented_action_invoked'] : [];
  const supporting: string[] = [];
  if (context.provider_events?.some((event) => event === 'OneTrustGroupsUpdated' || event === 'OTConsentApplied')) supporting.push('onetrust_state_event');
  if (context.cookies?.some((cookie) => cookie.exists && (cookie.name === 'OptanonConsent' || cookie.name === 'OptanonAlertBoxClosed'))) supporting.push('onetrust_persistence_key_present');
  if (context.active_group_ids) supporting.push('onetrust_active_group_shape');
  return { strong, supporting };
}

async function invokeAction(
  context: OneTrustAdapterContext,
  action: 'accept' | 'reject' | 'preferences'
): Promise<AdapterOperationResult<InteractionAttempt>> {
  const control = ONETRUST_DOCUMENTED_CONTROLS[action];
  const method: OneTrustPublicMethod = action === 'accept' ? 'AllowAll' : action === 'reject' ? 'RejectAll' : 'ToggleInfoDisplay';
  const actionType = action === 'accept' ? 'accept_all' : action === 'reject' ? 'reject_all' : 'open_preferences';
  if (actionableControl(context, control) && context.invoke_control) {
    const executed = await context.invoke_control(control);
    return executed
      ? completed({ action: actionType, origin: 'provider_selector', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
      : inconclusive({ action: actionType, origin: 'provider_selector', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
  }
  if (hasPublicMethod(context, method) && context.invoke_public_method) {
    const executed = await context.invoke_public_method(method);
    return executed
      ? completed({ action: actionType, origin: 'provider_api', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
      : inconclusive({ action: actionType, origin: 'provider_api', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
  }
  return unsupported();
}

function verifyOneTrustAction(context: OneTrustAdapterContext): AdapterOperationResult<VerificationResult> {
  const contribution = oneTrustVerificationContribution(context);
  return completed({
    status: 'inconclusive',
    evidence: [...contribution.strong, ...contribution.supporting],
    reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  });
}

export const oneTrustAdapter: ConsentProviderAdapter<'onetrust'> = {
  metadata: {
    provider_id: 'onetrust',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['web_cmp'],
    supported_template_variants: ['standard_banner', 'preference_center'],
    regions: null,
    tcf_capable: true,
    gpp_capable: true,
    iframe_support: false,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: true,
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
      save_preferences: 'unsupported',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'onetrust');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(oneTrustConsentState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(oneTrustBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(oneTrustActionInventory(context).actions) : inconclusive<AvailableAction[]>([]);
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
    return context ? verifyOneTrustAction(context) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence(input) {
    const context = contextFrom(input);
    return context ? completed(oneTrustPersistenceEvidence(context)) : inconclusive<PersistenceResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  }
};

cmpAdapterRegistry.register(oneTrustAdapter);
