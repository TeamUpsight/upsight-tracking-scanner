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

export const COOKIEBOT_STANDARD_ROOT = '#CybotCookiebotDialog';
export const COOKIEBOT_STANDARD_CONTROLS = {
  accept: '#CybotCookiebotDialogBodyButtonAccept',
  decline: '#CybotCookiebotDialogBodyButtonDecline',
  level_decline_all: '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
  preferences: '#CybotCookiebotDialogBodyButtonDetails'
} as const;

export type CookiebotControlId = typeof COOKIEBOT_STANDARD_CONTROLS[keyof typeof COOKIEBOT_STANDARD_CONTROLS] | string;
export type CookiebotSemanticAction = 'decline_all' | 'open_preferences' | 'save_preferences' | 'set_category';
export type CookiebotSemanticCategory = 'preferences' | 'statistics' | 'marketing';

export interface CookiebotRuntimeState {
  has_response: boolean | null;
  consented: boolean | null;
  declined: boolean | null;
  consent: {
    preferences: boolean | null;
    statistics: boolean | null;
    marketing: boolean | null;
  } | null;
}

export interface CookiebotControlObservation {
  id: CookiebotControlId;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  within_confirmed_cookiebot_surface: boolean;
  semantic_action?: CookiebotSemanticAction;
  semantic_category?: CookiebotSemanticCategory;
}

export interface CookiebotSurfaceObservation {
  selector: string;
  visible: boolean;
}

export interface CookiebotCookieDescriptor {
  name: string;
  exists: boolean;
  value_length?: number;
}

/** Input is transient browser evidence; adapter outputs omit cookie values and cbid identifiers. */
export interface CookiebotAdapterContext {
  window_globals?: readonly string[];
  asset_urls?: readonly string[];
  script_ids?: readonly string[];
  data_cbid_present?: boolean;
  surfaces?: readonly CookiebotSurfaceObservation[];
  controls?: readonly CookiebotControlObservation[];
  runtime?: CookiebotRuntimeState | null;
  provider_events?: readonly string[];
  cookies?: readonly CookiebotCookieDescriptor[];
  tcf_active?: boolean;
  gpp_active?: boolean;
  consent_mode_present?: boolean;
  action_executed?: boolean;
  invoke_control?: (id: CookiebotControlId) => boolean | Promise<boolean>;
}

export interface CookiebotActionInventory {
  actions: AvailableAction[];
  user_facing_reject_available: boolean;
  preferences_flow_available: boolean;
}

export interface CookiebotVerificationContribution {
  strong: string[];
  supporting: string[];
}

const COOKIEBOT_EVENTS = new Set(['CookiebotOnAccept', 'CookiebotOnDecline', 'CookiebotOnDialogDisplay']);

function includesExact(values: readonly string[] | undefined, expected: string) {
  return values?.some((value) => value === expected) || false;
}

function hasCookiebotAsset(values: readonly string[] | undefined) {
  return values?.some((value) => /consent\.cookiebot\.com\/uc\.js/i.test(value)) || false;
}

function isActionable(control: CookiebotControlObservation | undefined) {
  return Boolean(control?.visible && control.enabled && control.actionable && control.within_confirmed_cookiebot_surface);
}

function standardControl(context: CookiebotAdapterContext, id: CookiebotControlId) {
  return context.controls?.find((control) => control.id === id);
}

function semanticControl(context: CookiebotAdapterContext, action: CookiebotSemanticAction) {
  return context.controls?.find((control) => control.semantic_action === action && isActionable(control));
}

function anyControl(context: CookiebotAdapterContext, ids: readonly CookiebotControlId[], action?: CookiebotSemanticAction) {
  const standard = ids.map((id) => standardControl(context, id)).find((control) => isActionable(control));
  return standard || (action ? semanticControl(context, action) : undefined);
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as CookiebotAdapterContext : null;
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

function categoryDecision(value: boolean | null): ConsentDecision {
  return value === true ? 'accepted' : value === false ? 'rejected' : 'ambiguous';
}

function normalizedCategory(category: CookiebotSemanticCategory): ConsentCategory {
  return category === 'statistics' ? 'analytics' : category;
}

/** Converts Cookiebot-specific facts to provider scoring inputs; TCF/GPP are intentionally absent. */
export function cookiebotProviderEvidence(context: CookiebotAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (includesExact(context.window_globals, 'Cookiebot')) {
    evidence.push({ provider_id: 'cookiebot', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' });
  }
  if (hasCookiebotAsset(context.asset_urls) || includesExact(context.script_ids, 'Cookiebot') || context.data_cbid_present) {
    evidence.push({ provider_id: 'cookiebot', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' });
  }
  if (context.surfaces?.some((surface) => surface.selector === COOKIEBOT_STANDARD_ROOT)) {
    evidence.push({ provider_id: 'cookiebot', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' });
  }
  if (context.cookies?.some((cookie) => cookie.name === 'CookieConsent' && cookie.exists)) {
    evidence.push({ provider_id: 'cookiebot', family: 'provider_persistence', kind: 'provider_persistence_key', specificity: 'provider_specific' });
  }
  if (context.provider_events?.some((event) => COOKIEBOT_EVENTS.has(event))) {
    evidence.push({ provider_id: 'cookiebot', family: 'provider_state', kind: 'provider_state_or_event', specificity: 'provider_specific' });
  }
  return evidence;
}

export function detectCookiebot(context: CookiebotAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(cookiebotProviderEvidence(context)).find((item) => item.provider_id === 'cookiebot');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  return candidate.high_confidence
    ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
    : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
}

/** Surface visibility is a standalone fact; a detected Cookiebot runtime need not display a dialog. */
export function cookiebotBannerState(context: CookiebotAdapterContext): BannerState {
  const root = context.surfaces?.find((surface) => surface.selector === COOKIEBOT_STANDARD_ROOT);
  if (root?.visible) return { surface: 'dialog', visibility: 'visible', evidence: ['cookiebot_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] };
  if (root) return { surface: 'none', visibility: 'not_visible', evidence: ['cookiebot_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

export function cookiebotConsentState(context: CookiebotAdapterContext): ConsentState {
  const runtime = context.runtime;
  const evidence: string[] = [];
  if (runtime) evidence.push('cookiebot_runtime_present');
  if (runtime?.has_response === true) evidence.push('cookiebot_has_response');
  if (runtime?.consented === true) evidence.push('cookiebot_consented');
  if (runtime?.declined === true) evidence.push('cookiebot_declined');
  if (context.provider_events?.some((event) => COOKIEBOT_EVENTS.has(event))) evidence.push('cookiebot_event_observed');
  if (context.tcf_active) evidence.push('tcf_framework_active');
  if (context.gpp_active) evidence.push('gpp_framework_active');
  if (context.consent_mode_present) evidence.push('consent_mode_present');

  const categoryValues = runtime?.consent;
  const categories = categoryValues ? [
    { category: 'preferences' as const, decision: categoryDecision(categoryValues.preferences), evidence: ['cookiebot_runtime'] },
    { category: 'analytics' as const, decision: categoryDecision(categoryValues.statistics), evidence: ['cookiebot_runtime'] },
    { category: 'marketing' as const, decision: categoryDecision(categoryValues.marketing), evidence: ['cookiebot_runtime'] }
  ] : [];
  const values = categoryValues ? [categoryValues.preferences, categoryValues.statistics, categoryValues.marketing] : [];
  const decision = runtime?.declined === true ? 'rejected'
    : runtime?.has_response === false ? 'unanswered'
      : values.length && values.every((value) => value === true) ? 'accepted'
        : values.length && values.every((value) => value === false) ? 'rejected'
          : values.some((value) => value === true) && values.some((value) => value === false) ? 'partial'
            : 'ambiguous';
  return { decision, categories, evidence, reason_codes: decision === 'ambiguous' ? [ConsentAuditCodes.ACTION_INCONCLUSIVE] : [] };
}

export function cookiebotActionInventory(context: CookiebotAdapterContext): CookiebotActionInventory {
  const decline = anyControl(context, [COOKIEBOT_STANDARD_CONTROLS.decline, COOKIEBOT_STANDARD_CONTROLS.level_decline_all], 'decline_all');
  const preferences = anyControl(context, [COOKIEBOT_STANDARD_CONTROLS.preferences], 'open_preferences');
  const accept = anyControl(context, [COOKIEBOT_STANDARD_CONTROLS.accept]);
  const save = semanticControl(context, 'save_preferences');
  const categoryControls = (context.controls || []).filter((control) =>
    control.semantic_action === 'set_category' && control.semantic_category && isActionable(control)
  );
  const actions: AvailableAction[] = [
    {
      action: 'accept_all', availability: accept ? 'direct' : 'not_present', category: null,
      evidence: accept ? ['cookiebot_accept_control'] : [], reason_codes: accept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : []
    },
    {
      action: 'reject_all', availability: decline ? 'direct' : preferences ? 'preferences_only' : 'not_present', category: null,
      evidence: decline ? ['cookiebot_decline_control'] : preferences ? ['cookiebot_preferences_control'] : [],
      reason_codes: decline ? [ConsentAuditCodes.REJECT_AVAILABLE] : preferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE]
    },
    {
      action: 'open_preferences', availability: preferences ? 'direct' : 'not_present', category: null,
      evidence: preferences ? ['cookiebot_preferences_control'] : [], reason_codes: preferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : []
    },
    {
      action: 'save_preferences', availability: save ? 'direct' : 'not_present', category: null,
      evidence: save ? ['cookiebot_semantic_save'] : [], reason_codes: []
    },
    ...categoryControls.map((control) => ({
      action: 'set_category' as const,
      availability: 'direct' as const,
      category: normalizedCategory(control.semantic_category!),
      evidence: ['cookiebot_semantic_category_control'],
      reason_codes: []
    }))
  ];
  return { actions, user_facing_reject_available: Boolean(decline), preferences_flow_available: Boolean(preferences) };
}

export function cookiebotPersistenceEvidence(context: CookiebotAdapterContext): PersistenceResult {
  const present = context.cookies?.some((cookie) => cookie.name === 'CookieConsent' && cookie.exists) || false;
  return {
    status: 'inconclusive',
    evidence: present ? ['cookiebot_persistence_key_present'] : [],
    reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
  };
}

/** Provider evidence for a later global verifier; neither an event nor a click verifies an outcome alone. */
export function cookiebotVerificationContribution(context: CookiebotAdapterContext): CookiebotVerificationContribution {
  const strong = context.runtime?.has_response === true && (context.runtime.consented === true || context.runtime.declined === true)
    ? ['cookiebot_runtime_response_state']
    : [];
  const supporting: string[] = [];
  if (context.action_executed) supporting.push('cookiebot_action_invoked');
  if (context.provider_events?.some((event) => COOKIEBOT_EVENTS.has(event))) supporting.push('cookiebot_event_observed');
  if (context.cookies?.some((cookie) => cookie.name === 'CookieConsent' && cookie.exists)) supporting.push('cookiebot_persistence_key_present');
  return { strong, supporting };
}

async function invokeCookiebotControl(
  context: CookiebotAdapterContext,
  control: CookiebotControlObservation,
  action: InteractionAttempt['action']
): Promise<AdapterOperationResult<InteractionAttempt>> {
  if (!context.invoke_control) return unsupported();
  const executed = await context.invoke_control(control.id);
  return executed
    ? completed({ action, origin: control.semantic_action ? 'semantic_ui' : 'provider_selector', outcome: 'executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_EXECUTED] })
    : inconclusive({ action, origin: control.semantic_action ? 'semantic_ui' : 'provider_selector', outcome: 'not_executed', category: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXECUTED] }, [ConsentAuditCodes.ACTION_NOT_EXECUTED]);
}

function actionControl(context: CookiebotAdapterContext, action: 'accept' | 'reject' | 'preferences' | 'save') {
  if (action === 'accept') return anyControl(context, [COOKIEBOT_STANDARD_CONTROLS.accept]);
  if (action === 'reject') return anyControl(context, [COOKIEBOT_STANDARD_CONTROLS.decline, COOKIEBOT_STANDARD_CONTROLS.level_decline_all], 'decline_all');
  if (action === 'preferences') return anyControl(context, [COOKIEBOT_STANDARD_CONTROLS.preferences], 'open_preferences');
  return semanticControl(context, 'save_preferences');
}

function verifyCookiebotAction(context: CookiebotAdapterContext): AdapterOperationResult<VerificationResult> {
  const contribution = cookiebotVerificationContribution(context);
  return completed({
    status: 'inconclusive',
    evidence: [...contribution.strong, ...contribution.supporting],
    reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  });
}

export const cookiebotAdapter: ConsentProviderAdapter<'cookiebot'> = {
  metadata: {
    provider_id: 'cookiebot',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['web_cmp'],
    supported_template_variants: ['standard_dialog', 'custom_template'],
    regions: null,
    tcf_capable: true,
    gpp_capable: true,
    iframe_support: false,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: false,
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
      save_preferences: 'fixture_only',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  getProviderEvidence(context) { return cookiebotProviderEvidence(context as CookiebotAdapterContext); },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'cookiebot');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(cookiebotConsentState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(cookiebotBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(cookiebotActionInventory(context).actions) : inconclusive<AvailableAction[]>([]);
  },
  accept(input) {
    const context = contextFrom(input);
    const control = context && actionControl(context, 'accept');
    return context && control ? invokeCookiebotControl(context, control, 'accept_all') : unsupported<InteractionAttempt>();
  },
  reject(input) {
    const context = contextFrom(input);
    const control = context && actionControl(context, 'reject');
    return context && control ? invokeCookiebotControl(context, control, 'reject_all') : unsupported<InteractionAttempt>();
  },
  openPreferences(input) {
    const context = contextFrom(input);
    const control = context && actionControl(context, 'preferences');
    return context && control ? invokeCookiebotControl(context, control, 'open_preferences') : unsupported<InteractionAttempt>();
  },
  savePreferences(input) {
    const context = contextFrom(input);
    const control = context && actionControl(context, 'save');
    return context && control ? invokeCookiebotControl(context, control, 'save_preferences') : unsupported<InteractionAttempt>();
  },
  verifyAction(input) {
    const context = contextFrom(input);
    return context ? verifyCookiebotAction(context) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence(input) {
    const context = contextFrom(input);
    return context ? completed(cookiebotPersistenceEvidence(context)) : inconclusive<PersistenceResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  }
};

cmpAdapterRegistry.register(cookiebotAdapter);
