import type { Page, Request } from 'playwright-core';
import type { EvidenceBundle, TrackingRequestEvidence } from '../../types';
import { consentTimingValues, type ConsentTimingValues } from '../../shared/config';
import { cmpAdapterRegistry, platformRuntimeRegistry, scoreProviderCandidates, type CmpAdapterProviderId, type ProviderEvidenceSignal } from './adapter-registry';
import './onetrust-adapter'; import './cookiebot-adapter'; import './usercentrics-adapter'; import './didomi-adapter'; import './cookieyes-adapter'; import './sourcepoint-adapter'; import './shopify-customer-privacy-runtime';
import { buildRejectStateMachine, executeActionPlan, planFromAvailableAction, type ActionPlan, type ConsentInteractionStrategy, type InteractionExecutionBridge } from './action-planner';
import { actionTargetFor, buildPersistenceStorage, buildProviderContexts, buildShopifyCustomerPrivacyContext, captureBrowserConsentFacts, installConsentCommandBootstrap, observeConsentFrameworksInPage, waitForConsentUiReadiness, type BrowserConsentFacts } from './browser-context-builders';
import { ConsentEvidenceLedger } from './evidence-ledger';
import { ConsentAuditCodes, type AvailableAction, type BannerState, type ConsentAuditCode, type ConsentDecision, type ConsentState, type FinalConsentAuditResult, type FrameworkState, type MechanismResult, type PersistenceResult, type VerificationResult } from './domain-types';
import { detectGenericConsentMechanism, semanticActionForConsentLabel, type GenericConsentDetectionResult } from './generic-consent-detector';
import { googleConsentModeMechanism, GoogleConsentModeObserver } from './google-consent-mode-observer';
import { frameworkMechanisms, frameworkStateFromObservations, mergeConsentFrameworkObservations, tcfObservationDecision, type ConsentFrameworkObservations } from './framework-observers';
import { shopifyCustomerPrivacyMechanism } from './shopify-customer-privacy-runtime';
import { verifySameContextReloadPersistence } from './persistence-verification';
import { verifyRequestedConsentAction } from './reject-verification-engine';
import { collectRejectVerificationSignals } from './verification-evidence';
import { captureConsentTrackingRequest, checkTrackingConsistency, ConsentRequestBuffer, normalizeConsentMeasurement, reconcileConsentMeasurement, type ConsentMeasurementSummary, type TrackingConsistencyResult } from './tracking-consistency';
import { buildUnknownCmpFingerprint } from './unknown-cmp-fingerprint';
import { consentV2ActionsEnabledFor, consentV2RolloutControls, type ConsentV2RolloutControls, type ConsentV2RolloutProvider } from './rollout-controls';

export interface ConsentV2SessionInput { geo: 'USA' | 'EU' | 'UK'; geo_verified: boolean | null; page_valid: boolean | null; timings?: ConsentTimingValues; access_blocked?: boolean; rollout?: ConsentV2RolloutControls; rollout_key?: string; diagnostic?: boolean; }
export type ConsentV2Telemetry = NonNullable<EvidenceBundle['runtime']['consent_v2']>;
type DiagnosticConsentObservation = NonNullable<EvidenceBundle['diagnostic_observability']>['consent_observations'][number];
export interface ConsentV2SessionOutput { result: FinalConsentAuditResult; tracking: TrackingConsistencyResult; ledger: ConsentEvidenceLedger; telemetry: ConsentV2Telemetry; google_consent_mode: ReturnType<GoogleConsentModeObserver['result']>; diagnostic_observation?: DiagnosticConsentObservation; }
export interface SharedConsentObservation {
  source: 'shared';
  provider: CmpAdapterProviderId | 'generic' | null;
  provider_conflict: boolean;
  banner: BannerState;
  actions: AvailableAction[];
  diagnostic_observation?: DiagnosticConsentObservation;
}
export interface MergedConsentObservation {
  provider: CmpAdapterProviderId | 'generic' | null;
  provider_conflict: boolean;
  banner: BannerState;
  actions: AvailableAction[];
}
type ProviderContexts = Map<CmpAdapterProviderId, unknown>;
const CMP_UI_READINESS_MAX_MS = 4_000;
type ProviderSelection = Awaited<ReturnType<typeof selectProvider>>;
type ConsentUiReadinessSummary = NonNullable<DiagnosticConsentObservation['readiness']>;
type ConsentUiSnapshot = { facts: BrowserConsentFacts; frameworkObservations: ConsentFrameworkObservations; contexts: ProviderContexts; selection: ProviderSelection };
export interface ConsentV2Timeline {
  session_started_at: number;
  navigation_started_at: number | null;
  dom_content_loaded_at: number | null;
  initial_observation_completed_at: number | null;
  /** Start of an attempted activation; it is not evidence that a choice occurred. */
  action_attempt_started_at: number | null;
  user_choice_at: number | null;
  reject_started_at: number | null;
  reject_completed_at: number | null;
  reload_started_at: number | null;
}
export interface PreparedConsentV2Session {
  timeline: ConsentV2Timeline;
  ledger: ConsentEvidenceLedger;
  requests: TrackingRequestEvidence[];
  request_buffer: ConsentRequestBuffer;
  gcm: GoogleConsentModeObserver;
  markNavigationStarted(): void;
  markDOMContentLoaded(): void;
  markInitialObservationCompleted(): void;
  dispose(): void;
}

/** Installs Consent V2 capture after a fresh page is created and before navigation. */
export async function prepareConsentV2Session(page: Page): Promise<PreparedConsentV2Session> {
  await installConsentCommandBootstrap(page);
  const timeline: ConsentV2Timeline = { session_started_at: Date.now(), navigation_started_at: null, dom_content_loaded_at: null, initial_observation_completed_at: null, action_attempt_started_at: null, user_choice_at: null, reject_started_at: null, reject_completed_at: null, reload_started_at: null };
  const ledger = new ConsentEvidenceLedger(); const request_buffer = new ConsentRequestBuffer(); const requests = request_buffer.requests; const gcm = new GoogleConsentModeObserver({ timestamp_tolerance_ms: 50 });
  const listener = (request: Request) => {
    const timestamp = Date.now(); const url = request.url();
    // postData is immediately reduced by the owning observers/classifier and
    // is never appended to requests, the ledger, telemetry, or persistence.
    const postData = request.method().toUpperCase() === 'POST' ? request.postData() : null;
    gcm.observeMeasurementRequest({ url, body: postData || undefined, timestamp });
    const captured = captureConsentTrackingRequest({ url, resource_type: request.resourceType(), method: request.method(), post_data: postData, timestamp });
    if (captured) request_buffer.append(captured);
  };
  let disposed = false;
  page.on('request', listener);
  return {
    timeline, ledger, requests, request_buffer, gcm,
    markNavigationStarted() { timeline.navigation_started_at ||= Date.now(); },
    markDOMContentLoaded() { timeline.dom_content_loaded_at ||= Date.now(); },
    markInitialObservationCompleted() { timeline.initial_observation_completed_at ||= Date.now(); },
    dispose() { if (!disposed) { disposed = true; page.off('request', listener); } }
  };
}

function unknownState(): ConsentState { return { decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] }; }
function unknownBanner(): BannerState { return { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] }; }
function genericDetection(facts: BrowserConsentFacts, frameworks: FrameworkState, gcm: GoogleConsentModeObserver): GenericConsentDetectionResult { return detectGenericConsentMechanism(facts.generic.surfaces as any, facts.generic.controls, { storage: buildPersistenceStorage(facts).map((item) => ({ storage_type: item.storage_type as 'cookie' | 'local_storage', key_name: item.key_name, exists: item.exists, consent_shaped: true })), consent_change_datalayer_event: facts.consent_commands.some((item) => item.command === 'update'), consent_mode_transition: gcm.result().lifecycle !== 'not_observed', tcf_present: frameworks.tcf !== 'not_present', gpp_present: frameworks.gpp !== 'not_present' }); }

/** Browser-command bridge only: GCM interpretation remains in its observer. */
function observeNewGoogleConsentCommands(gcm: GoogleConsentModeObserver, facts: BrowserConsentFacts, seen: Set<string>) {
  for (const item of facts.consent_commands) {
    const key = `${item.timestamp || 0}:${item.command}:${JSON.stringify(item.state)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    gcm.observeDataLayerEntry(['consent', item.command, item.state], item.timestamp);
  }
}

/** A real, completed pre/post request boundary is the only tracking-gate evidence. */
function markTrackingGatedWhenObserved(gcm: GoogleConsentModeObserver) {
  const observed = gcm.result();
  if (observed.user_choice_timestamp === null || !observed.pre_choice_measurement_window_observed) return;
  const preChoice = observed.network.filter((item) => item.timestamp < observed.user_choice_timestamp!);
  const postChoice = observed.network.filter((item) => item.timestamp >= observed.user_choice_timestamp!);
  if (preChoice.length === 0 && postChoice.length > 0) gcm.markTrackingGated();
}

function composeMechanisms(...groups: MechanismResult[][]): MechanismResult[] {
  const seen = new Set<string>();
  return groups.flat().filter((mechanism) => {
    const providers = mechanism.provider?.candidates.map((candidate) => candidate.provider_name).sort().join(',') || '';
    const key = `${mechanism.mechanism}:${providers}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasGcmContradiction(verification: VerificationResult, gcm: GoogleConsentModeObserver) {
  const observed = gcm.result();
  return verification.status === 'verified' && observed.user_choice_timestamp !== null && observed.commands.some((command) =>
    command.command === 'update' && command.timestamp >= observed.user_choice_timestamp! &&
    (command.state.ad_storage === 'granted' || command.state.analytics_storage === 'granted')
  );
}

async function selectProvider(contexts: ProviderContexts, controls: ConsentV2RolloutControls) {
  const evidence = cmpAdapterRegistry.collectProviderEvidence(contexts); const candidates = scoreProviderCandidates(evidence);
  const plausible = candidates.filter((candidate) => candidate.plausible_candidate)
    .map((candidate) => candidate.provider_id as CmpAdapterProviderId)
    .filter((provider) => controls.providers[provider].detection_enabled);
  if (plausible.length === 0) return { provider: undefined, candidates, conflict: false, evidence };
  // Scoring intentionally marks tied candidates inconclusive. Resolve those
  // ties from active browser surfaces rather than falling back to registry order.
  const detected = await Promise.all(plausible.map(async (provider) => ({ provider, operations: await providerOperations(provider, contexts) })));
  if (detected.length === 1) return { provider: detected[0].provider, candidates, conflict: false, evidence };
  const active = detected.filter((item) => item.operations.banner.visibility === 'visible' || item.operations.actions.some((action) => action.availability === 'direct'));
  if (active.length === 1) return { provider: active[0].provider, candidates, conflict: true, evidence };
  return { provider: undefined, candidates, conflict: detected.length > 1, evidence };
}

function semanticControlCount(facts: BrowserConsentFacts) {
  return facts.generic.controls.filter((control) => control.visible && control.enabled && control.actionable && Boolean(semanticActionForConsentLabel(control.accessible_name))).length;
}

function strongSurfaceCount(facts: BrowserConsentFacts) {
  return facts.generic.surfaces.filter((surface) => surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent' && surface.strong_presentation).length;
}

async function captureConsentUiSnapshot(page: Page, controls: ConsentV2RolloutControls): Promise<ConsentUiSnapshot> {
  const facts = await captureBrowserConsentFacts(page);
  const frameworkObservations = await observeConsentFrameworksInPage(page);
  const contexts = await buildProviderContexts(page, facts, frameworkObservations);
  const selection = controls.enabled ? await selectProvider(contexts, controls) : { provider: undefined, candidates: [], conflict: false, evidence: [] };
  return { facts, frameworkObservations, contexts, selection };
}

function readinessTrigger(snapshot: ConsentUiSnapshot) {
  const providerCount = snapshot.selection.candidates.filter((candidate) => candidate.high_confidence || candidate.deterministic_provider_signature).length;
  const strongSurfaces = strongSurfaceCount(snapshot.facts);
  const semanticControls = semanticControlCount(snapshot.facts);
  const providerUiResolved = snapshot.facts.observations.some((observation) => observation.visible) || snapshot.facts.usercentrics.visible || snapshot.facts.didomi_controls.some((control) => control.visible);
  if (providerCount > 0 && strongSurfaces === 0 && !providerUiResolved) return { reason: 'identified_provider_without_strong_surface', requireSemanticControls: false, providerCount, strongSurfaces, semanticControls };
  if (providerCount > 0 && strongSurfaces > 0 && semanticControls === 0) return { reason: 'identified_provider_without_semantic_controls', requireSemanticControls: true, providerCount, strongSurfaces, semanticControls };
  if (strongSurfaces > 0 && semanticControls === 0) return { reason: 'strong_surface_with_incomplete_controls', requireSemanticControls: true, providerCount, strongSurfaces, semanticControls };
  return { reason: null, requireSemanticControls: false, providerCount, strongSurfaces, semanticControls };
}

/** One conditional readiness/capture path shared by homepage and fresh-session observations. */
async function captureConsentUiReadySnapshot(page: Page, controls: ConsentV2RolloutControls, enabled = true): Promise<{ snapshot: ConsentUiSnapshot; readiness: ConsentUiReadinessSummary }> {
  const initial = await captureConsentUiSnapshot(page, controls);
  const trigger = readinessTrigger(initial);
  const skipped = (): ConsentUiReadinessSummary => ({
    triggered: false, reason: null, started_at_ms: null, completed_at_ms: null, elapsed_ms: 0, completion: 'skipped',
    initial: { provider_count: trigger.providerCount, strong_surface_count: trigger.strongSurfaces, semantic_control_count: trigger.semanticControls },
    final: { provider_count: trigger.providerCount, strong_surface_count: trigger.strongSurfaces, semantic_control_count: trigger.semanticControls, open_shadow_roots: 0, provider_root_visible: false }, reason_codes: []
  });
  if (!enabled || !trigger.reason) return { snapshot: initial, readiness: skipped() };
  const startedAt = Date.now();
  const probe = await waitForConsentUiReadiness(page, CMP_UI_READINESS_MAX_MS, trigger.requireSemanticControls);
  const completedAt = Date.now();
  const snapshot = await captureConsentUiSnapshot(page, controls);
  const finalProviderCount = snapshot.selection.candidates.filter((candidate) => candidate.high_confidence || candidate.deterministic_provider_signature).length;
  const elapsed = completedAt - startedAt;
  const positive = trigger.requireSemanticControls
    ? probe.visible_semantic_control_count > 0
    : probe.strong_visible_surface_count > 0 || probe.visible_semantic_control_count > 0 || probe.provider_root_visible;
  const timedOut = !positive && elapsed >= CMP_UI_READINESS_MAX_MS - 50;
  return {
    snapshot,
    readiness: {
      triggered: true, reason: trigger.reason, started_at_ms: startedAt, completed_at_ms: completedAt, elapsed_ms: elapsed,
      completion: positive ? 'positive_ui_ready' : 'timeout',
      initial: { provider_count: trigger.providerCount, strong_surface_count: trigger.strongSurfaces, semantic_control_count: trigger.semanticControls },
      final: { provider_count: finalProviderCount, strong_surface_count: strongSurfaceCount(snapshot.facts), semantic_control_count: semanticControlCount(snapshot.facts), open_shadow_roots: probe.open_shadow_roots_observed, provider_root_visible: probe.provider_root_visible },
      reason_codes: timedOut && trigger.providerCount > 0 ? [ConsentAuditCodes.CMP_UI_READINESS_TIMEOUT] : []
    }
  };
}

function diagnosticObservation(
  context: 'shared' | 'fresh', phase: string, facts: BrowserConsentFacts, framework: ConsentFrameworkObservations,
  selection: { provider?: CmpAdapterProviderId; candidates: ReturnType<typeof scoreProviderCandidates>; conflict: boolean; evidence: ProviderEvidenceSignal[] },
  banner: BannerState, actions: AvailableAction[], consentMode: string, observationComplete: boolean, readiness?: ConsentUiReadinessSummary
): DiagnosticConsentObservation {
  const providerCandidates = selection.candidates.slice(0, 8).map((candidate) => ({
    provider: candidate.provider_id,
    detection_status: candidate.attribution,
    confidence: candidate.high_confidence ? 'high' as const : candidate.plausible_candidate ? 'medium' as const : 'low' as const,
    deterministic_provider_signature: candidate.deterministic_provider_signature === true,
    independent_evidence_families: candidate.independent_families.slice(0, 8),
    evidence_codes: [...new Set(selection.evidence.filter((signal) => signal.provider_id === candidate.provider_id).map((signal) => signal.kind))].slice(0, 20)
  }));
  const location = selection.provider === 'usercentrics' && facts.usercentrics.shadow_mode !== 'none' ? 'shadow_dom' as const : 'main_frame' as const;
  const surfaces: DiagnosticConsentObservation['visible_surfaces'] = facts.generic.surfaces.filter((surface) => surface.visible).slice(0, 11).map((surface) => ({
    surface_type: surface.surface_type, provider_specific: false, visible: surface.visible,
    privacy_or_cookie_semantics: surface.privacy_or_cookie_semantics, intent: surface.intent, strong_presentation: surface.strong_presentation, location: surface.location
  }));
  if (selection.provider && banner.visibility === 'visible' && surfaces.length < 12) surfaces.unshift({
    surface_type: banner.surface, provider_specific: true, visible: true, privacy_or_cookie_semantics: true, intent: 'consent', location
  });
  const controls: DiagnosticConsentObservation['visible_controls'] = facts.generic.controls.filter((control) => Boolean(semanticActionForConsentLabel(control.accessible_name))).slice(0, 20).map((control) => ({
    accessible_name: control.accessible_name.slice(0, 120), semantic_action: semanticActionForConsentLabel(control.accessible_name) || 'unknown',
    visible: control.visible, enabled: control.enabled, actionable: control.actionable, provider_specific: false, location: control.location
  }));
  for (const action of actions) {
    if (controls.length >= 20 || action.availability === 'not_present' || action.availability === 'unknown') continue;
    if (!controls.some((control) => control.semantic_action === action.action)) controls.push({
      accessible_name: '', semantic_action: action.action, visible: action.availability !== 'api_only', enabled: true,
      actionable: action.availability === 'direct' || action.availability === 'api_only', provider_specific: Boolean(selection.provider), location
    });
  }
  return {
    capture_id: `consent-${context}-${Date.now()}`, context, phase, captured_at_ms: Date.now(), observation_complete: observationComplete,
    provider_selection: { selected_provider: selection.provider || null, provider_conflict: selection.conflict, candidates: providerCandidates },
    banner: { visibility: banner.visibility, surface: banner.surface }, visible_surfaces: surfaces.slice(0, 12), visible_controls: controls.slice(0, 20),
    frameworks: { tcf: framework.tcf.present, gpp: framework.gpp.present, consent_mode: consentMode }, ...(readiness ? { readiness } : {})
  };
}
async function providerOperations(provider: CmpAdapterProviderId | undefined, contexts: ProviderContexts) {
  if (!provider) return { state: unknownState(), banner: unknownBanner(), actions: [] as AvailableAction[], persistence: null as PersistenceResult | null };
  const context = contexts.get(provider); const [state, banner, actions, persistence] = await Promise.all([cmpAdapterRegistry.invoke<ConsentState>(provider, 'state_read', { context }), cmpAdapterRegistry.invoke<BannerState>(provider, 'banner_state', { context }), cmpAdapterRegistry.invoke<AvailableAction[]>(provider, 'available_actions', { context }), cmpAdapterRegistry.invoke<PersistenceResult>(provider, 'persistence_evidence', { context })]);
  return { state: state.value || unknownState(), banner: banner.value || unknownBanner(), actions: actions.value || [], persistence: persistence.value };
}

/**
 * Captures passive CMP facts from the shared homepage after its existing
 * observation window. This deliberately does not create a V2 session, make a
 * decision, or attempt an action.
 */
export async function captureSharedConsentObservation(
  page: Page,
  controls: ConsentV2RolloutControls = consentV2RolloutControls(),
  diagnostic = false
): Promise<SharedConsentObservation> {
  const captured = await captureConsentUiReadySnapshot(page, controls);
  const { facts, frameworkObservations, contexts, selection } = captured.snapshot;
  const frameworks = frameworkStateFromObservations(frameworkObservations);
  const provider = await providerOperations(selection.provider, contexts);
  const generic = genericDetection(facts, frameworks, new GoogleConsentModeObserver());
  const useGeneric = !selection.provider && !selection.conflict && controls.providers.generic.detection_enabled && generic.status === 'detected';
  const banner = selection.provider
    ? provider.banner
    : selection.conflict
      ? { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: [], reason_codes: [ConsentAuditCodes.PROVIDER_CONFLICT, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] }
      : generic.action_plan.length
        ? { surface: generic.action_plan[0].surface_type, visibility: 'visible' as const, evidence: ['generic_detector_surface'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] }
        : { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
  const actions = selection.provider ? provider.actions : selection.conflict ? [] : generic.actions;
  return { source: 'shared', provider: selection.provider || (useGeneric ? 'generic' : null), provider_conflict: selection.conflict, banner, actions,
    ...(diagnostic ? { diagnostic_observation: diagnosticObservation('shared', 'homepage_shared_observation', facts, frameworkObservations, selection, banner, actions, 'not_recorded', true, captured.readiness) } : {}) };
}

function available(action: AvailableAction | undefined) {
  return Boolean(action && action.availability !== 'not_present' && action.availability !== 'unknown');
}

/** Positive shared facts survive an unavailable fresh context. Equal-authority
 * visible/not-visible observations are intentionally represented as unknown. */
export function mergeSharedConsentObservation(
  shared: SharedConsentObservation | null,
  fresh: Pick<ConsentV2SessionOutput, 'result' | 'telemetry'> | null
): MergedConsentObservation {
  if (!shared && !fresh) return { provider: null, provider_conflict: false, banner: { surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] }, actions: [] };
  if (!fresh) return shared!;
  const freshProvider = fresh.telemetry.provider as CmpAdapterProviderId | 'generic' | null;
  const providerConflict = Boolean(shared?.provider_conflict || fresh.telemetry.provider_conflict || (shared?.provider && freshProvider && shared.provider !== freshProvider));
  const provider = providerConflict ? null : freshProvider || shared?.provider || null;
  const freshBanner = fresh.result.banner;
  const sharedVisible = shared?.banner.visibility === 'visible';
  const banner = sharedVisible && freshBanner.visibility === 'not_visible'
    ? { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: ['shared_visible_fresh_not_visible'], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] }
    : sharedVisible && freshBanner.visibility === 'unknown'
      ? shared!.banner
      : freshBanner.visibility === 'unknown' && shared
        ? shared.banner
        : freshBanner;
  const actionKeys = new Set([...shared?.actions.map((item) => `${item.action}:${item.category || ''}`) || [], ...fresh.result.available_actions.map((item) => `${item.action}:${item.category || ''}`)]);
  const actions = [...actionKeys].map((key) => {
    const [action, categoryValue] = key.split(':');
    const category = categoryValue || null;
    const sharedAction = shared?.actions.find((item) => item.action === action && item.category === category);
    const freshAction = fresh.result.available_actions.find((item) => item.action === action && item.category === category);
    // Completed fresh observations enrich shared facts, but a missing/unavailable
    // fresh control never erases an already actionable shared control.
    return available(freshAction) ? freshAction! : available(sharedAction) ? sharedAction! : freshAction || sharedAction!;
  });
  return { provider, provider_conflict: providerConflict, banner, actions };
}

function actionPlanFor(provider: CmpAdapterProviderId, actions: AvailableAction[], banner: BannerState, context: unknown, action: ActionPlan['action'], category: ActionPlan['category'] = null, timings?: ConsentTimingValues) {
  const candidate = actions.find((item) => item.action === action && item.category === category && (item.availability === 'direct' || item.availability === 'api_only'));
  if (!candidate) return null;
  const target = actionTargetFor(context, action, category);
  const surface = target?.surface_type || (banner.surface === 'none' || banner.surface === 'unknown' ? 'banner' : banner.surface);
  return planFromAvailableAction(candidate, {
    provider_or_mechanism: provider,
    target: target ? { surface_type: target.surface_type, target_ref: target.target_ref, accessible_control: target.accessible_control, frame_path: target.frame_path, shadow_mode: target.shadow_mode } : { surface_type: surface, target_ref: candidate.availability === 'api_only' ? `api:${provider}` : null, accessible_control: false, frame_path: ['top'], shadow_mode: 'unknown' },
    eligible_strategies: candidate.availability === 'api_only' ? ['documented_provider_api'] : ['provider_selector', 'documented_provider_api'],
    timeout_ms: timings?.postActionSettleMs,
    stabilization_ms: timings?.postActionSettleMs,
    provider_api_reject_available: candidate.availability === 'api_only',
    user_facing_reject_available: candidate.availability === 'direct',
    prefer_user_facing: true
  });
}

function rejectStateMachineFor(provider: CmpAdapterProviderId, operations: Awaited<ReturnType<typeof providerOperations>>, context: unknown, timings: ConsentTimingValues) {
  return buildRejectStateMachine({
    direct_reject: actionPlanFor(provider, operations.actions, operations.banner, context, 'reject_all', null, timings) || undefined,
    only_necessary: actionPlanFor(provider, operations.actions, operations.banner, context, 'only_necessary', null, timings) || undefined,
    open_preferences: actionPlanFor(provider, operations.actions, operations.banner, context, 'open_preferences', null, timings) || undefined,
    // Category action plans are deliberately omitted until a provider bridge supplies
    // explicit category/current/desired semantics; no blind toggle is permitted.
    deny_optional_categories: [],
    save_preferences: actionPlanFor(provider, operations.actions, operations.banner, context, 'save_preferences', null, timings) || undefined,
    rediscover_after_preferences: true
  });
}
async function shopifyOperations(facts: BrowserConsentFacts) {
  const context = buildShopifyCustomerPrivacyContext(facts); if (!context) return { mechanism: null as MechanismResult | null, state: null as ConsentState | null, banner: null as BannerState | null, actions: [] as AvailableAction[] };
  const evidence = [{ provider_id: 'shopify_customer_privacy', family: 'typed_provider_api' as const, kind: 'typed_documented_provider_api' as const, specificity: 'provider_specific' as const }, { provider_id: 'shopify_customer_privacy', family: 'provider_state' as const, kind: 'provider_state_or_event' as const, specificity: 'provider_specific' as const }];
  const detection = await platformRuntimeRegistry.get('shopify_customer_privacy')?.detect({ evidence }); if (detection?.status !== 'detected') return { mechanism: null, state: null, banner: null, actions: [] };
  const [state, banner, actions] = await Promise.all([platformRuntimeRegistry.invoke<ConsentState>('shopify_customer_privacy', 'state_read', { context }), platformRuntimeRegistry.invoke<BannerState>('shopify_customer_privacy', 'banner_state', { context }), platformRuntimeRegistry.invoke<AvailableAction[]>('shopify_customer_privacy', 'available_actions', { context })]);
  return { mechanism: shopifyCustomerPrivacyMechanism(context as Parameters<typeof shopifyCustomerPrivacyMechanism>[0]), state: state.value, banner: banner.value, actions: actions.value || [] };
}
function providerMechanism(provider: CmpAdapterProviderId | undefined): MechanismResult[] { return provider ? [{ mechanism: 'cmp', detection: { status: 'verified', evidence: ['adapter_detection'], reason_codes: [ConsentAuditCodes.CMP_DETECTED] }, provider: { attribution: 'identified', confidence: 'high', candidates: [{ provider_name: provider, attribution: 'identified', confidence: 'high', evidence: ['adapter_detection'], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }, adapter_maturity: cmpAdapterRegistry.getCapability(provider, 'detection').maturity }] : []; }

function telemetry(result: FinalConsentAuditResult, tracking: TrackingConsistencyResult, facts: BrowserConsentFacts, generic: GenericConsentDetectionResult, frameworkObservations: ConsentFrameworkObservations, controls: ConsentV2RolloutControls, provider: CmpAdapterProviderId | undefined, conflict: boolean, blocked: boolean, actionsEnabled: boolean, timeline: ConsentV2Timeline, geo: ConsentV2SessionInput['geo'], capture: PreparedConsentV2Session): ConsentV2Telemetry {
  const custom = result.mechanisms.find((item) => item.mechanism === 'custom');
  const fingerprint = custom ? buildUnknownCmpFingerprint({
    mechanism_score: generic.score,
    provider_attribution: custom.provider?.attribution || 'unknown_candidate',
    geo,
    stable_dom_hints: facts.generic.surfaces.map((surface) => surface.surface_type === 'dialog' ? 'role:dialog' : `tag:${surface.surface_type === 'drawer' ? 'aside' : 'section'}`),
    script_hosts: facts.assets,
    available_actions: result.available_actions,
    storage_key_names: facts.storage_keys,
    candidate_global_names: facts.globals,
    tcf: { presence: frameworkObservations.tcf.present ? 'present' : frameworkObservations.tcf.lifecycle === 'absent' ? 'absent' : 'unknown', readiness: frameworkObservations.tcf.lifecycle === 'ready' ? 'ready' : frameworkObservations.tcf.lifecycle === 'loading' ? 'loading' : frameworkObservations.tcf.lifecycle === 'error' ? 'error' : 'unknown', event_status: frameworkObservations.tcf.latest_event?.event_status || 'unknown' },
    gpp: { presence: frameworkObservations.gpp.lifecycle === 'absent' ? 'absent' : frameworkObservations.gpp.lifecycle === 'stub_present' ? 'stub_present' : frameworkObservations.gpp.lifecycle === 'loading' ? 'loading' : frameworkObservations.gpp.lifecycle === 'ready' ? 'ready' : frameworkObservations.gpp.lifecycle === 'error' ? 'error' : 'unknown', display: frameworkObservations.gpp.ping?.cmp_display_status || 'unknown', supported_api_count: frameworkObservations.gpp.ping?.supported_apis.length || null },
    failure_reason_codes: result.reason_codes
  }) : null;
  const reject = result.available_actions.find((item) => item.action === 'reject_all');
  // A preferences step is preparatory. Requested-Reject telemetry must derive
  // from the final non-preference action, never from the first interaction.
  const interaction = [...result.interactions].reverse().find((item) => item.action !== 'open_preferences');
  const preferencesOpened = result.interactions.some((item) => item.action === 'open_preferences' && item.outcome === 'executed');
  const rejectAttempted = Boolean(interaction);
  const action_status = result.rejection_verification.status === 'verified' ? 'verified'
    : interaction?.outcome === 'executed' ? 'executed'
      : interaction?.outcome === 'unsupported' ? 'unsupported'
        : interaction?.outcome === 'not_executed' ? 'not_executed'
          : interaction ? 'inconclusive' : 'not_attempted';
  return {
    measurement: reconcileConsentMeasurement([normalizeConsentMeasurement(capture.requests, 'fresh', timeline.user_choice_at, capture.gcm.result(), capture.request_buffer.truncated, capture.request_buffer.observed)]),
    session_status: 'completed',
    enabled: controls.enabled, observation_only: !actionsEnabled,
    provider: provider || (custom ? 'generic' : null),
    provider_confidence: provider ? 'high' : custom ? 'medium' : null,
    provider_conflict: conflict, banner_visibility: result.banner.visibility,
    reject_availability: reject?.availability || 'not_present',
    interaction_outcome: interaction?.outcome || 'not_attempted',
    action_attempted: result.interactions.length > 0,
    preferences_opened: preferencesOpened,
    reject_attempted: rejectAttempted,
    reject_outcome: interaction?.outcome || 'not_attempted',
    verification: result.rejection_verification.status, persistence: result.persistence.status,
    generic_fallback: Boolean(custom), selector_or_action_failure: result.interactions.some((item) => item.outcome !== 'executed'),
    tcf_present: frameworkObservations.tcf.present, gpp_present: frameworkObservations.gpp.present,
    tcf_lifecycle: frameworkObservations.tcf.lifecycle, gpp_lifecycle: frameworkObservations.gpp.lifecycle, usp_present: frameworkObservations.usp.present, action_status,
    consent_mode_classification: result.google_consent_mode.evidence[0] || 'unknown', tracking_consistency: tracking.status,
    unknown_cmp_fingerprint: fingerprint?.fingerprint || null, geo_unverified: result.geo_verified.status !== 'verified',
    blocked_or_challenged: blocked, timeline: { ...timeline }
  };
}

/**
 * Shared pre-choice measurement belongs to the audit observation even when a
 * separate fresh page cannot be created or navigated.  Keep that provenance
 * without fabricating provider, framework, action, or persistence results.
 */
export function unavailableConsentV2Telemetry(
  measurement: ConsentMeasurementSummary,
  controls: ConsentV2RolloutControls = consentV2RolloutControls()
): ConsentV2Telemetry {
  return {
    measurement,
    session_status: 'unavailable',
    enabled: controls.enabled,
    observation_only: true,
    provider: null,
    provider_confidence: null,
    provider_conflict: false,
    banner_visibility: 'unknown',
    reject_availability: 'unknown',
    interaction_outcome: 'not_attempted',
    action_attempted: false,
    preferences_opened: false,
    reject_attempted: false,
    reject_outcome: 'not_attempted',
    verification: 'inconclusive',
    persistence: 'inconclusive',
    generic_fallback: false,
    selector_or_action_failure: false,
    tcf_present: false,
    gpp_present: false,
    tcf_lifecycle: 'unavailable',
    gpp_lifecycle: 'unavailable',
    usp_present: false,
    action_status: 'not_attempted',
    consent_mode_classification: 'unavailable',
    tracking_consistency: 'not_applicable',
    unknown_cmp_fingerprint: null,
    geo_unverified: true,
    blocked_or_challenged: false
  };
}

/** Production composition root. Provider, framework, Shopify, and generic semantics stay in their owning modules. */
export async function runConsentV2Session(page: Page, input: ConsentV2SessionInput, prepared?: PreparedConsentV2Session): Promise<ConsentV2SessionOutput> {
  const timings = input.timings || consentTimingValues(); const rollout = input.rollout || consentV2RolloutControls(); const capture = prepared || await prepareConsentV2Session(page); const { ledger, requests, gcm, timeline } = capture;
  try {
    ledger.append({ phase: 'baseline', source: 'page', family: 'semantic', kind: 'presence', specificity: 'generic', stability: 'stable', provenance: 'browser_api', descriptor: { exists: true } });
    const observedGoogleCommands = new Set<string>();
    const initialCapture = await captureConsentUiReadySnapshot(page, rollout, !input.access_blocked && rollout.enabled);
    capture.markInitialObservationCompleted();
    const { facts: before, frameworkObservations: initialFrameworkObservations, contexts, selection } = initialCapture.snapshot; observeNewGoogleConsentCommands(gcm, before, observedGoogleCommands);
    let frameworkObservations = initialFrameworkObservations; let frameworks = frameworkStateFromObservations(frameworkObservations);
    const generic = genericDetection(before, frameworks, gcm); const shopify = await shopifyOperations(before); const provider = await providerOperations(selection.provider, contexts); const useGeneric = !selection.provider && !selection.conflict && rollout.providers.generic.detection_enabled && generic.status === 'detected';
    const baseMechanisms = input.access_blocked || !rollout.enabled ? [] : [...(shopify.mechanism ? [shopify.mechanism] : []), ...providerMechanism(selection.provider), ...(useGeneric && generic.mechanism ? [generic.mechanism] : [])]; const initial = selection.provider ? provider.state : selection.conflict ? unknownState() : shopify.state || provider.state; const banner = selection.provider ? provider.banner : selection.conflict ? { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: [], reason_codes: [ConsentAuditCodes.PROVIDER_CONFLICT, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] } : shopify.banner?.visibility === 'visible' ? shopify.banner : generic.action_plan.length ? { surface: generic.action_plan[0].surface_type, visibility: 'visible' as const, evidence: ['generic_detector_surface'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] } : unknownBanner(); const actions = selection.provider ? provider.actions : selection.conflict ? [] : shopify.actions.length ? shopify.actions : generic.actions;
    const blocked = Boolean(input.access_blocked) || !rollout.enabled;
    if (blocked) { const mechanisms = input.access_blocked || !rollout.enabled ? [] : composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const result = buildResult(input, mechanisms, banner, actions, initial, null, [], { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }, { status: 'not_applicable', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] }, frameworks, gcm, requests, [input.access_blocked ? ConsentAuditCodes.BLOCKED_OR_CHALLENGED : ConsentAuditCodes.DETECTION_INCONCLUSIVE]); const tracking = checkTrackingConsistency({ rejection_verification: result.rejection_verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: false, requests }); const telemetryResult = telemetry(result, tracking, before, generic, frameworkObservations, rollout, undefined, selection.conflict, blocked, false, timeline, input.geo, capture); return { result, tracking, ledger, telemetry: telemetryResult, google_consent_mode: gcm.result(), ...(input.diagnostic ? { diagnostic_observation: diagnosticObservation('fresh', 'consent_fresh_observation', before, frameworkObservations, selection, banner, actions, telemetryResult.consent_mode_classification, false, initialCapture.readiness) } : {}) }; }
    const actionEnabled = consentV2ActionsEnabledFor(rollout, (selection.provider || 'generic') as ConsentV2RolloutProvider, input.rollout_key || page.url()); let after = before; const attempts: FinalConsentAuditResult['interactions'] = []; let attempt: FinalConsentAuditResult['interactions'][number] | null = null; let verification: VerificationResult = { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }; let timestamp: number | null = null;
    if (selection.provider && actionEnabled) {
      timeline.reject_started_at = Date.now(); timeline.action_attempt_started_at = timeline.reject_started_at; gcm.markPreChoiceMeasurementWindowObserved();
      for (let transition = 0; transition < 2 && !attempt; transition += 1) {
        // Each state transition rebuilds facts, provider context, action inventory,
        // and target topology. No control reference survives a previous action.
        after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const observed = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, observed); frameworks = frameworkStateFromObservations(frameworkObservations); const liveContexts = await buildProviderContexts(page, after, frameworkObservations); const liveProvider = await providerOperations(selection.provider, liveContexts); const machine = rejectStateMachineFor(selection.provider, liveProvider, liveContexts.get(selection.provider), timings);
        if (machine.status !== 'ready') {
          // Opening preferences is not a successful Reject. Record the missing
          // requested action explicitly so telemetry cannot report a false win.
          if (attempts.some((item) => item.action === 'open_preferences' && item.outcome === 'executed')) {
            attempt = { action: 'reject_all', origin: 'generic_ui', outcome: 'unsupported', category: null, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] };
            attempts.push(attempt);
          }
          break;
        }
        if (transition > 0 && machine.steps.length === 1 && machine.steps[0].action === 'open_preferences') {
          attempt = { action: 'reject_all', origin: 'generic_ui', outcome: 'unsupported', category: null, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] };
          attempts.push(attempt);
          break;
        }
        for (const step of machine.steps) {
          const freshFacts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, freshFacts, observedGoogleCommands); const freshFrameworks = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, freshFrameworks); frameworks = frameworkStateFromObservations(frameworkObservations); const freshContexts = await buildProviderContexts(page, freshFacts, frameworkObservations); const freshProvider = await providerOperations(selection.provider, freshContexts); const plan = actionPlanFor(selection.provider, freshProvider.actions, freshProvider.banner, freshContexts.get(selection.provider), step.action, step.category, timings);
          if (!plan) { attempt = { action: step.action, origin: 'generic_ui', outcome: 'unsupported', category: step.category, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] }; attempts.push(attempt); break; }
          const executed = await executeActionPlan(plan, adapterActionBridge(page, selection.provider, ledger, timings, freshProvider.state)); attempts.push(executed.attempt);
          if (executed.attempt.outcome !== 'executed' && executed.attempt.outcome !== 'aborted') { attempt = executed.attempt; break; }
          if (step.action !== 'open_preferences') { attempt = executed.attempt; timestamp = executed.activated_at; break; }
        }
      }
      timeline.reject_completed_at = Date.now();
      if (attempt && (attempt.outcome === 'executed' || attempt.outcome === 'aborted') && timestamp !== null) { timeline.user_choice_at = timestamp; gcm.markUserChoice(timestamp); }
      after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const afterFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, afterFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const afterContexts = await buildProviderContexts(page, after, frameworkObservations); const afterState = (await providerOperations(selection.provider, afterContexts)).state; verification = verifyRequestedConsentAction({ requested_action: attempt?.action || 'reject_all', action_timestamp: timestamp, signals: collectRejectVerificationSignals({ timestamp, interactionExecuted: attempt?.outcome === 'executed', navigationInterrupted: attempt?.outcome === 'aborted', providerState: afterState, providerEventObserved: after.provider_events.length > before.provider_events.length || (after.onetrust?.provider_events.length || 0) > (before.onetrust?.provider_events.length || 0), providerActionCompleted: after.cookieyes?.is_user_action_completed === true, frameworks: frameworkObservations }), navigation_interrupted: attempt?.outcome === 'aborted' }); markTrackingGatedWhenObserved(gcm); }
    const afterContexts = await buildProviderContexts(page, after, frameworkObservations); const resulting = (await providerOperations(selection.provider, afterContexts)).state; const persistence = await verifySameContextReloadPersistence({ meaningful_action_attempt: attempt?.outcome === 'executed' || attempt?.outcome === 'aborted', semantic_verification: verification, after_action: { semantic_state: { provider: resulting.decision, tcf: tcfObservationDecision(frameworkObservations.tcf), gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', shopify_privacy: shopify.state?.decision, consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(after) }, settle_timeout_ms: timings.reloadSettleMs }, { async reloadSameContext() { timeline.reload_started_at = Date.now(); const beforeUrl = page.url(); try { await page.reload({ waitUntil: 'commit' }); return { reloaded: true, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: false }; } catch { return { reloaded: false, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: true }; } }, async waitForSettle(timeoutMs) { try { await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }); return 'settled'; } catch { return 'timeout'; } }, async readPostReloadSnapshot() { const facts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, facts, observedGoogleCommands); const reloadFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, reloadFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const contextsAfterReload = await buildProviderContexts(page, facts, frameworkObservations); const state = (await providerOperations(selection.provider, contextsAfterReload)).state; return { semantic_state: { provider: state.decision, tcf: tcfObservationDecision(frameworkObservations.tcf), gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(facts) }; } });
    const mechanisms = composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const contradiction = hasGcmContradiction(verification, gcm); const hasCmpIdentity = baseMechanisms.some((mechanism) => mechanism.mechanism === 'cmp' || mechanism.mechanism === 'custom'); const result = buildResult(input, mechanisms, banner, actions, initial, resulting, attempts, verification, persistence, frameworks, gcm, requests, [...(hasCmpIdentity ? [] : [ConsentAuditCodes.NO_CMP_DETECTED]), ...(selection.conflict ? [ConsentAuditCodes.PROVIDER_CONFLICT] : []), ...verification.reason_codes, ...persistence.reason_codes, ...(contradiction ? [ConsentAuditCodes.STATE_CONTRADICTION] : [])]); const tracking = checkTrackingConsistency({ rejection_verification: verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: persistence.post_reload_observation_completed, requests }); const telemetryResult = telemetry(result, tracking, before, generic, frameworkObservations, rollout, selection.provider, selection.conflict, false, actionEnabled, timeline, input.geo, capture); return { result, tracking, ledger, telemetry: telemetryResult, google_consent_mode: gcm.result(), ...(input.diagnostic ? { diagnostic_observation: diagnosticObservation('fresh', 'consent_fresh_observation', before, frameworkObservations, selection, banner, actions, telemetryResult.consent_mode_classification, true, initialCapture.readiness) } : {}) };
  } finally { capture.dispose(); }
}

function adapterActionBridge(page: Page, provider: CmpAdapterProviderId, ledger: ConsentEvidenceLedger, timings: ConsentTimingValues, initial: ConsentState): InteractionExecutionBridge {
  const refreshed = async () => {
    const facts = await captureBrowserConsentFacts(page); const frameworks = await observeConsentFrameworksInPage(page); const contexts = await buildProviderContexts(page, facts, frameworks);
    return { contexts, operations: await providerOperations(provider, contexts) };
  };
  return {
    async inspectTarget(plan, strategy) {
      if (page.isClosed()) return { attached: false, visible: false, enabled: false, surface_active: false, frame_path: null, shadow_mode: 'unknown', navigation_state: 'interrupted' };
      const current = await refreshed(); const target = actionTargetFor(current.contexts.get(provider), plan.action, plan.category);
      if (strategy === 'documented_provider_api' && !target) return { attached: true, visible: current.operations.banner.visibility === 'visible', enabled: true, surface_active: current.operations.banner.visibility === 'visible', frame_path: ['top'], shadow_mode: 'none', navigation_state: 'idle' };
      return { attached: target?.attached || false, visible: target?.visible || false, enabled: target?.enabled || false, surface_active: current.operations.banner.visibility === 'visible', frame_path: target?.frame_path || null, shadow_mode: target?.shadow_mode || 'unknown', navigation_state: 'idle' };
    },
    async executeStrategy(plan, strategy: ConsentInteractionStrategy) {
      if (strategy !== 'documented_provider_api' && strategy !== 'provider_selector') return 'unsupported';
      const current = await refreshed(); const capability = plan.action === 'open_preferences' ? 'open_preferences' : plan.action === 'save_preferences' ? 'save_preferences' : 'reject';
      const result = await cmpAdapterRegistry.invoke<{ outcome: 'executed' | 'not_executed' }>(provider, capability, { context: current.contexts.get(provider) });
      return result.value?.outcome === 'executed' ? 'executed' : result.value?.outcome === 'not_executed' ? 'not_executed' : 'unsupported';
    },
    appendEvidence(event) { ledger.append({ phase: 'pre_action', source: 'provider_adapter', family: 'semantic', kind: event.kind === 'state_transition' ? 'state_change' : 'semantic_control', specificity: 'provider_specific', stability: 'stable', provenance: 'adapter', provider_candidate: provider, descriptor: { exists: true } }); },
    async waitForStabilization() { await page.waitForTimeout(timings.postActionSettleMs); const state = (await refreshed()).operations.state; return { state_changed: state.decision !== initial.decision, navigation_interrupted: page.isClosed() }; }
  };
}
function buildResult(input: ConsentV2SessionInput, mechanisms: MechanismResult[], banner: BannerState, actions: AvailableAction[], initial: ConsentState, resulting: ConsentState | null, interactions: FinalConsentAuditResult['interactions'], verification: VerificationResult, persistence: PersistenceResult, frameworks: FrameworkState, gcm: GoogleConsentModeObserver, requests: TrackingRequestEvidence[], reasonCodes: ConsentAuditCode[]): FinalConsentAuditResult { const observed = gcm.result(); return { context_clean: { status: 'verified', evidence: ['fresh_playwright_context'], reason_codes: [] }, geo_verified: { status: input.geo_verified === true ? 'verified' : 'inconclusive', evidence: [], reason_codes: input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED] }, mechanisms, banner, available_actions: actions, initial_state: initial, resulting_state: resulting, interactions, rejection_verification: verification, persistence, frameworks, google_consent_mode: { presence: observed.lifecycle === 'not_observed' ? 'not_present' : observed.classification === 'ambiguous' ? 'ambiguous' : 'present', defaults_observed: observed.commands.some((item) => item.command === 'default'), updates_observed: observed.commands.some((item) => item.command === 'update'), evidence: [observed.classification], reason_codes: observed.reason_codes }, storage_changes: [], network_signals: requests.slice(0, 100).map((item) => ({ host: item.host, path: item.path, method: item.method, phase: item.phase, signal: item.kind === 'script' ? 'script' : 'tracking' })), reason_codes: [...new Set([...(input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED]), ...reasonCodes])] }; }
