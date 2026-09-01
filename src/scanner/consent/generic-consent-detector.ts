import {
  ConsentAuditCodes,
  type AvailableAction,
  type BannerSurface,
  type ConsentActionType,
  type MechanismResult,
  type ProviderConfidence
} from './domain-types';

export type GenericSurfaceIntent =
  | 'consent'
  | 'newsletter'
  | 'email_capture'
  | 'login'
  | 'account_creation'
  | 'age_gate'
  | 'country_selector'
  | 'location_selector'
  | 'currency_selector'
  | 'ordinary_notice'
  | 'privacy_policy_only'
  | 'unknown';

export type GenericStorageKind = 'cookie' | 'local_storage';

export interface GenericConsentSurface {
  id: string;
  surface_type: Exclude<BannerSurface, 'none' | 'unknown'>;
  visible: boolean;
  /** Derived by the bounded semantic probe; page text is not retained here. */
  privacy_or_cookie_semantics: boolean;
  intent: GenericSurfaceIntent;
}

export interface GenericConsentControl {
  surface_id: string;
  visible: boolean;
  enabled: boolean;
  actionable: boolean;
  /** A transient a11y name; it is normalized for matching and never emitted. */
  accessible_name?: string;
  /** A trusted semantic probe can supply an action without retaining the label. */
  semantic_action?: ConsentActionType;
}

export interface GenericConsentStorageSignal {
  storage_type: GenericStorageKind;
  key_name: string;
  exists: boolean;
  consent_shaped: boolean;
  parsed_shape?: 'json_object' | 'delimited_categories' | 'unknown';
}

export interface GenericConsentSignals {
  storage?: readonly GenericConsentStorageSignal[];
  consent_change_datalayer_event?: boolean;
  consent_mode_transition?: boolean;
  tcf_present?: boolean;
  gpp_present?: boolean;
  manual_tag_gating_marker?: boolean;
}

export interface GenericConsentDetectorConfig {
  candidate_threshold: number;
  inconclusive_threshold: number;
  minimum_corroborating_signals: number;
  /** Optional locale-specific aliases supplied by a trusted browser semantic layer. */
  localized_action_labels: Partial<Record<Exclude<ConsentActionType, 'set_category' | 'close'>, readonly string[]>>;
}

export interface GenericConsentActionPlan {
  action: Exclude<ConsentActionType, 'set_category' | 'close'>;
  availability: AvailableAction['availability'];
  surface_type: GenericConsentSurface['surface_type'];
  origin: 'semantic_ui';
}

export interface GenericConsentDetectionResult {
  status: 'detected' | 'inconclusive' | 'not_detected';
  score: number;
  corroborating_signals: string[];
  actions: AvailableAction[];
  action_plan: GenericConsentActionPlan[];
  mechanism: MechanismResult | null;
  reason_codes: string[];
}

const NEGATIVE_INTENTS = new Set<GenericSurfaceIntent>([
  'newsletter', 'email_capture', 'login', 'account_creation', 'age_gate',
  'country_selector', 'location_selector', 'currency_selector', 'ordinary_notice', 'privacy_policy_only'
]);

const DEFAULT_ACTION_LABELS: GenericConsentDetectorConfig['localized_action_labels'] = {
  accept_all: ['accept all', 'accept cookies', 'allow all'],
  reject_all: ['reject all', 'decline all', 'deny all'],
  only_necessary: ['only necessary', 'necessary only'],
  open_preferences: ['preferences', 'manage preferences', 'cookie settings', 'customize'],
  save_preferences: ['save preferences', 'save choices', 'save settings']
};

export const DEFAULT_GENERIC_CONSENT_DETECTOR_CONFIG: GenericConsentDetectorConfig = {
  candidate_threshold: 70,
  inconclusive_threshold: 45,
  minimum_corroborating_signals: 2,
  localized_action_labels: DEFAULT_ACTION_LABELS
};

/** Unicode normalization, case folding, whitespace collapsing, and diacritic removal before label comparison. */
export function normalizeConsentActionLabel(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function configuredActionLabels(config: GenericConsentDetectorConfig) {
  const labels = new Map<Exclude<ConsentActionType, 'set_category' | 'close'>, Set<string>>();
  for (const action of Object.keys(DEFAULT_ACTION_LABELS) as Array<Exclude<ConsentActionType, 'set_category' | 'close'>>) {
    const values = [...(DEFAULT_ACTION_LABELS[action] || []), ...(config.localized_action_labels[action] || [])];
    labels.set(action, new Set(values.map(normalizeConsentActionLabel).filter(Boolean)));
  }
  return labels;
}

function normalizedControlAction(control: GenericConsentControl, labels: ReturnType<typeof configuredActionLabels>) {
  if (control.semantic_action && control.semantic_action !== 'set_category' && control.semantic_action !== 'close') return control.semantic_action;
  if (!control.accessible_name) return null;
  const name = normalizeConsentActionLabel(control.accessible_name);
  for (const [action, aliases] of labels) {
    if (aliases.has(name)) return action;
  }
  return null;
}

function isActionable(control: GenericConsentControl) {
  return control.visible && control.enabled && control.actionable;
}

function isConsentStorage(signal: GenericConsentStorageSignal) {
  return signal.exists && signal.consent_shaped && /(?:consent|cookie|privacy|tracking)/i.test(signal.key_name);
}

function providerUnknownConfidence(evidence: string[]): ProviderConfidence {
  return {
    attribution: 'unknown_candidate',
    confidence: 'medium',
    candidates: [{ provider_name: 'unknown', attribution: 'unknown_candidate', confidence: 'medium', evidence, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN] }],
    reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN]
  };
}

function genericMechanism(evidence: string[]): MechanismResult {
  return {
    mechanism: 'custom',
    detection: { status: 'verified', evidence, reason_codes: [ConsentAuditCodes.CMP_DETECTED] },
    provider: providerUnknownConfidence(evidence),
    adapter_maturity: 'unvalidated'
  };
}

function actionResults(actions: Map<Exclude<ConsentActionType, 'set_category' | 'close'>, GenericConsentSurface>) {
  const accept = actions.get('accept_all');
  const reject = actions.get('reject_all');
  const onlyNecessary = actions.get('only_necessary');
  const preferences = actions.get('open_preferences');
  const save = actions.get('save_preferences');
  const result: AvailableAction[] = [
    { action: 'accept_all', availability: accept ? 'direct' : 'not_present', category: null, evidence: accept ? ['generic_semantic_accept'] : [], reason_codes: accept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : [] },
    { action: 'reject_all', availability: reject ? 'direct' : preferences ? 'preferences_only' : 'not_present', category: null, evidence: reject ? ['generic_semantic_reject'] : preferences ? ['generic_semantic_preferences'] : [], reason_codes: reject ? [ConsentAuditCodes.REJECT_AVAILABLE] : preferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE] },
    { action: 'only_necessary', availability: onlyNecessary ? 'direct' : 'not_present', category: null, evidence: onlyNecessary ? ['generic_semantic_only_necessary'] : [], reason_codes: [] },
    { action: 'open_preferences', availability: preferences ? 'direct' : 'not_present', category: null, evidence: preferences ? ['generic_semantic_preferences'] : [], reason_codes: preferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : [] },
    { action: 'save_preferences', availability: save ? 'direct' : 'not_present', category: null, evidence: save ? ['generic_semantic_save'] : [], reason_codes: [] }
  ];
  return result;
}

function actionPlan(actions: Map<Exclude<ConsentActionType, 'set_category' | 'close'>, GenericConsentSurface>): GenericConsentActionPlan[] {
  return [...actions.entries()].map(([action, surface]) => ({ action, availability: 'direct', surface_type: surface.surface_type, origin: 'semantic_ui' }));
}

/**
 * Provider-agnostic fallback. It never searches outside a visible, consent-shaped
 * surface and never triggers browser interaction.
 */
export function detectGenericConsentMechanism(
  surfaces: readonly GenericConsentSurface[],
  controls: readonly GenericConsentControl[],
  signals: GenericConsentSignals = {},
  overrides: Partial<GenericConsentDetectorConfig> = {}
): GenericConsentDetectionResult {
  const config: GenericConsentDetectorConfig = {
    ...DEFAULT_GENERIC_CONSENT_DETECTOR_CONFIG,
    ...overrides,
    localized_action_labels: { ...DEFAULT_ACTION_LABELS, ...(overrides.localized_action_labels || {}) }
  };
  const labels = configuredActionLabels(config);
  const visibleSurfaces = surfaces.filter((surface) => surface.visible);
  const excluded = visibleSurfaces.some((surface) => NEGATIVE_INTENTS.has(surface.intent));
  const confirmed = visibleSurfaces.filter((surface) => surface.privacy_or_cookie_semantics && surface.intent === 'consent');
  const byId = new Map(confirmed.map((surface) => [surface.id, surface]));
  const actions = new Map<Exclude<ConsentActionType, 'set_category' | 'close'>, GenericConsentSurface>();
  for (const control of controls) {
    const surface = byId.get(control.surface_id);
    const action = normalizedControlAction(control, labels);
    if (surface && action && isActionable(control) && !actions.has(action)) actions.set(action, surface);
  }

  const corroborating: string[] = [];
  const addCorroboration = (value: string, present: boolean) => { if (present) corroborating.push(value); };
  const hasActionStructure = actions.size >= 2 || (actions.has('accept_all') && actions.has('reject_all')) || (actions.has('accept_all') && actions.has('open_preferences'));
  addCorroboration('privacy_semantics', confirmed.length > 0);
  addCorroboration('action_structure', hasActionStructure);
  addCorroboration('consent_shaped_storage', signals.storage?.some(isConsentStorage) || false);
  addCorroboration('consent_change_datalayer', signals.consent_change_datalayer_event || false);
  addCorroboration('consent_mode_transition', signals.consent_mode_transition || false);
  addCorroboration('tcf_framework', signals.tcf_present || false);
  addCorroboration('gpp_framework', signals.gpp_present || false);
  addCorroboration('manual_tag_gating', signals.manual_tag_gating_marker || false);

  const score = Math.max(0,
    (confirmed.length > 0 ? 25 : 0) +
    (confirmed.length > 0 ? 15 : 0) +
    (actions.has('accept_all') ? 10 : 0) +
    (actions.has('reject_all') ? 15 : 0) +
    (actions.has('only_necessary') ? 15 : 0) +
    (actions.has('open_preferences') ? 10 : 0) +
    (actions.has('save_preferences') ? 5 : 0) +
    (hasActionStructure ? 10 : 0) +
    (signals.storage?.some(isConsentStorage) ? 15 : 0) +
    (signals.consent_change_datalayer_event ? 15 : 0) +
    (signals.consent_mode_transition ? 10 : 0) +
    (signals.tcf_present ? 10 : 0) +
    (signals.gpp_present ? 10 : 0) +
    (signals.manual_tag_gating_marker ? 10 : 0) -
    (excluded ? 70 : 0)
  );
  const hasVisibleConsentSurface = confirmed.length > 0;
  const hasRealAction = actions.size > 0;
  const meetsMinimum = hasVisibleConsentSurface && hasRealAction && corroborating.length >= config.minimum_corroborating_signals;
  const availableActions = actionResults(actions);
  const plans = actionPlan(actions);
  if (!excluded && meetsMinimum && score >= config.candidate_threshold) {
    const evidence = ['generic_visible_consent_surface', ...corroborating];
    return {
      status: 'detected', score, corroborating_signals: corroborating, actions: availableActions, action_plan: plans,
      mechanism: genericMechanism(evidence), reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_UNKNOWN]
    };
  }
  if (!excluded && score >= config.inconclusive_threshold) {
    return {
      status: 'inconclusive', score, corroborating_signals: corroborating, actions: availableActions, action_plan: plans,
      mechanism: null, reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE]
    };
  }
  return {
    status: 'not_detected', score, corroborating_signals: corroborating, actions: [], action_plan: [], mechanism: null,
    reason_codes: [ConsentAuditCodes.NO_CMP_DETECTED]
  };
}
