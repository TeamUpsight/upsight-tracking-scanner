import type { Page, Request } from 'playwright-core';
import type { EvidenceBundle, TrackingRequestEvidence } from '../../types';
import { consentTimingValues, type ConsentTimingValues } from '../../shared/config';
import { cmpAdapterRegistry, platformRuntimeRegistry, scoreProviderCandidates, type CmpAdapterProviderId, type ProviderEvidenceSignal } from './adapter-registry';
import './onetrust-adapter'; import './cookiebot-adapter'; import './usercentrics-adapter'; import './didomi-adapter'; import './cookieyes-adapter'; import './sourcepoint-adapter'; import './shopify-customer-privacy-runtime';
import { buildRejectStateMachine, executeActionPlan, planFromAvailableAction, type ActionPlan, type ConsentInteractionStrategy, type InteractionExecutionBridge } from './action-planner';
import { actionTargetFor, buildPersistenceStorage, buildProviderContexts, buildShopifyCustomerPrivacyContext, captureBrowserConsentFacts, installConsentCommandBootstrap, observeConsentFrameworksInPage, waitForConsentUiReadiness, type BrowserConsentFacts } from './browser-context-builders';
import { ConsentEvidenceLedger } from './evidence-ledger';
import { ConsentAuditCodes, type AvailableAction, type BannerState, type ConsentAuditCode, type ConsentDecision, type ConsentState, type FinalConsentAuditResult, type FrameworkState, type MechanismResult, type PersistenceResult, type USPrivacyObservation, type VerificationResult } from './domain-types';
import { detectGenericConsentMechanism, semanticActionForConsentLabel, type GenericConsentDetectionResult } from './generic-consent-detector';
import { googleConsentModeMechanism, GoogleConsentModeObserver } from './google-consent-mode-observer';
import { frameworkMechanisms, frameworkStateFromObservations, mergeConsentFrameworkObservations, tcfObservationDecision, type ConsentFrameworkObservations } from './framework-observers';
import { shopifyCustomerPrivacyMechanism } from './shopify-customer-privacy-runtime';
import { verifySameContextReloadPersistence } from './persistence-verification';
import { verifyRequestedConsentAction } from './reject-verification-engine';
import { collectRejectVerificationSignals } from './verification-evidence';
import { assessRejectVerificationCapability, type VerificationCapability } from './verification-capability';
import { captureConsentTrackingRequest, checkTrackingConsistency, ConsentRequestBuffer, normalizeConsentMeasurement, reconcileConsentMeasurement, type ConsentMeasurementSummary, type TrackingConsistencyResult } from './tracking-consistency';
import { buildUnknownCmpFingerprint } from './unknown-cmp-fingerprint';
import { consentV2ActionsEnabledFor, consentV2RolloutControls, type ConsentV2RolloutControls, type ConsentV2RolloutProvider } from './rollout-controls';
import { captureDiagnosticConsentControlCensus, discoverProviderSemanticControls, type DiagnosticConsentControlCensusRecord, type ProviderSemanticDiscovery } from './provider-semantic-controls';
import { buildUSPrivacyObservation, isUSPrivacySemanticLabel, mergeUSPrivacyObservations } from './us-privacy';

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
  us_privacy: USPrivacyObservation | null;
  diagnostic_observation?: DiagnosticConsentObservation;
}
export interface MergedConsentObservation {
  provider: CmpAdapterProviderId | 'generic' | null;
  provider_conflict: boolean;
  banner: BannerState;
  actions: AvailableAction[];
  us_privacy: USPrivacyObservation | null;
}
type ProviderContexts = Map<CmpAdapterProviderId, unknown>;
const CMP_UI_READINESS_MAX_MS = 4_000;
type ProviderSelection = Awaited<ReturnType<typeof selectProvider>>;
type ConsentUiReadinessSummary = NonNullable<DiagnosticConsentObservation['readiness']>;
type ConsentCaptureStageDurations = NonNullable<DiagnosticConsentObservation['capture_stage_durations_ms']>;
type ConsentUiSnapshot = { facts: BrowserConsentFacts; frameworkObservations: ConsentFrameworkObservations; contexts: ProviderContexts; selection: ProviderSelection; providerBannerVisibility: BannerState['visibility']; semanticDiscovery?: ProviderSemanticDiscovery; diagnosticControlCensus?: DiagnosticConsentControlCensusRecord[]; stageDurations: ConsentCaptureStageDurations };
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
  return facts.generic.controls.filter((control) => control.visible && control.enabled && control.actionable && (Boolean(semanticActionForConsentLabel(control.accessible_name)) || isUSPrivacySemanticLabel(control.accessible_name))).length;
}

function strongSurfaceCount(facts: BrowserConsentFacts) {
  return facts.generic.surfaces.filter((surface) => surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent' && surface.strong_presentation).length;
}

async function captureConsentUiSnapshot(page: Page, controls: ConsentV2RolloutControls, geo: ConsentV2SessionInput['geo']): Promise<ConsentUiSnapshot> {
  const captureStartedAt = Date.now();
  let stageStartedAt = captureStartedAt;
  const facts = await captureBrowserConsentFacts(page);
  const browserFactsMs = Date.now() - stageStartedAt; stageStartedAt = Date.now();
  const frameworkObservations = await observeConsentFrameworksInPage(page);
  const frameworkObservationMs = Date.now() - stageStartedAt; stageStartedAt = Date.now();
  let contexts = await buildProviderContexts(page, facts, frameworkObservations, undefined, geo);
  let providerContextMs = Date.now() - stageStartedAt; stageStartedAt = Date.now();
  const selection = controls.enabled ? await selectProvider(contexts, controls) : { provider: undefined, candidates: [], conflict: false, evidence: [] };
  const providerSelectionMs = Date.now() - stageStartedAt; stageStartedAt = Date.now();
  const candidate = selection.provider && selection.candidates.find((item) => item.provider_id === selection.provider);
  const operations = await providerOperations(selection.provider, contexts);
  const providerOperationsMs = Date.now() - stageStartedAt;
  const baseDurations = (): ConsentCaptureStageDurations => ({ browser_facts: browserFactsMs, framework_observation: frameworkObservationMs, provider_context: providerContextMs, provider_selection: providerSelectionMs, provider_operations: providerOperationsMs, semantic_discovery: 0, ui_readiness: 0, accessibility_census: 0, total: Date.now() - captureStartedAt });
  const needsFallback = Boolean(selection.provider && candidate && (candidate.high_confidence || candidate.deterministic_provider_signature) &&
    (operations.banner.visibility === 'visible' || strongSurfaceCount(facts) > 0) && semanticControlCount(facts) === 0 && !operations.actions.some((action) => action.availability === 'direct'));
  if (!needsFallback || !selection.provider) return { facts, frameworkObservations, contexts, selection, providerBannerVisibility: operations.banner.visibility, stageDurations: baseDurations() };
  stageStartedAt = Date.now();
  const semanticDiscovery = await discoverProviderSemanticControls(page, selection.provider);
  const semanticDiscoveryMs = Date.now() - stageStartedAt;
  if (!semanticDiscovery.controls.length) return { facts, frameworkObservations, contexts, selection, providerBannerVisibility: operations.banner.visibility, semanticDiscovery, stageDurations: { ...baseDurations(), semantic_discovery: semanticDiscoveryMs, total: Date.now() - captureStartedAt } };
  for (const control of semanticDiscovery.controls) facts.generic.controls.push({ id: control.id, surface_id: control.surface_id, visible: true, enabled: control.enabled, actionable: true, accessible_name: control.accessible_name, location: control.location, shadow_depth: 0 });
  stageStartedAt = Date.now();
  contexts = await buildProviderContexts(page, facts, frameworkObservations, semanticDiscovery, geo);
  providerContextMs += Date.now() - stageStartedAt;
  return { facts, frameworkObservations, contexts, selection, providerBannerVisibility: operations.banner.visibility, semanticDiscovery, stageDurations: { ...baseDurations(), provider_context: providerContextMs, semantic_discovery: semanticDiscoveryMs, total: Date.now() - captureStartedAt } };
}

async function readinessTrigger(snapshot: ConsentUiSnapshot) {
  const providerCount = snapshot.selection.candidates.filter((candidate) => candidate.high_confidence || candidate.deterministic_provider_signature).length;
  const strongSurfaces = strongSurfaceCount(snapshot.facts);
  const semanticControls = semanticControlCount(snapshot.facts);
  const provider = await providerOperations(snapshot.selection.provider, snapshot.contexts);
  const directProviderControl = provider.actions.some((action) => action.availability === 'direct');
  const providerUiResolved = provider.banner.visibility === 'visible' || snapshot.facts.observations.some((observation) => observation.visible) || snapshot.facts.usercentrics.visible || snapshot.facts.didomi_controls.some((control) => control.visible);
  // An adapter's already-proven visible banner plus an actual direct control
  // is sufficient UI evidence. API-only actions intentionally do not qualify.
  if (providerUiResolved && directProviderControl) return { reason: null, requireSemanticControls: false, providerCount, strongSurfaces, semanticControls };
  if (providerCount > 0 && providerUiResolved && semanticControls === 0) return { reason: 'identified_provider_without_semantic_controls', requireSemanticControls: true, providerCount, strongSurfaces, semanticControls };
  if (providerCount > 0 && strongSurfaces === 0 && !providerUiResolved) return { reason: 'identified_provider_without_strong_surface', requireSemanticControls: false, providerCount, strongSurfaces, semanticControls };
  if (providerCount > 0 && strongSurfaces > 0 && semanticControls === 0) return { reason: 'identified_provider_without_semantic_controls', requireSemanticControls: true, providerCount, strongSurfaces, semanticControls };
  if (strongSurfaces > 0 && semanticControls === 0) return { reason: 'strong_surface_with_incomplete_controls', requireSemanticControls: true, providerCount, strongSurfaces, semanticControls };
  return { reason: null, requireSemanticControls: false, providerCount, strongSurfaces, semanticControls };
}

/** One conditional readiness/capture path shared by homepage and fresh-session observations. */
async function captureConsentUiReadySnapshot(page: Page, controls: ConsentV2RolloutControls, enabled = true, diagnostic = false, geo: ConsentV2SessionInput['geo'] = 'EU'): Promise<{ snapshot: ConsentUiSnapshot; readiness: ConsentUiReadinessSummary }> {
  const totalStartedAt = Date.now();
  const initial = await captureConsentUiSnapshot(page, controls, geo);
  const triggerStartedAt = Date.now();
  const trigger = await readinessTrigger(initial);
  initial.stageDurations.provider_operations += Date.now() - triggerStartedAt;
  const skipped = (): ConsentUiReadinessSummary => ({
    triggered: false, reason: null, started_at_ms: null, completed_at_ms: null, elapsed_ms: 0, completion: 'skipped',
    initial: { provider_count: trigger.providerCount, strong_surface_count: trigger.strongSurfaces, semantic_control_count: trigger.semanticControls },
    final: { provider_count: trigger.providerCount, strong_surface_count: trigger.strongSurfaces, semantic_control_count: trigger.semanticControls, open_shadow_roots: 0, provider_root_visible: false }, reason_codes: []
  });
  const finalizeDiagnostic = async (snapshot: ConsentUiSnapshot, uiReadinessMs: number) => {
    snapshot.stageDurations.ui_readiness = uiReadinessMs;
    const semanticDiagnostic = snapshot.semanticDiscovery?.diagnostic;
    const selectedCandidate = snapshot.selection.provider && snapshot.selection.candidates.find((candidate) => candidate.provider_id === snapshot.selection.provider);
    const exactCandidateCount = semanticDiagnostic
      ? semanticDiagnostic.role_candidate_count + semanticDiagnostic.link_candidate_count + semanticDiagnostic.open_shadow_candidate_count + semanticDiagnostic.text_candidate_count
      : 0;
    if (diagnostic && semanticDiagnostic?.attempted && selectedCandidate && (selectedCandidate.high_confidence || selectedCandidate.deterministic_provider_signature) &&
      (snapshot.providerBannerVisibility === 'visible' || strongSurfaceCount(snapshot.facts) > 0) && semanticControlCount(snapshot.facts) === 0 && exactCandidateCount === 0) {
      const censusStartedAt = Date.now();
      snapshot.diagnosticControlCensus = await captureDiagnosticConsentControlCensus(page);
      snapshot.stageDurations.accessibility_census = Date.now() - censusStartedAt;
    }
    snapshot.stageDurations.total = Date.now() - totalStartedAt;
    return snapshot;
  };
  if (!enabled || !trigger.reason) return { snapshot: await finalizeDiagnostic(initial, 0), readiness: skipped() };
  const startedAt = Date.now();
  const probe = await waitForConsentUiReadiness(page, CMP_UI_READINESS_MAX_MS, trigger.requireSemanticControls);
  const completedAt = Date.now();
  const snapshot = await captureConsentUiSnapshot(page, controls, geo);
  for (const key of ['browser_facts', 'framework_observation', 'provider_context', 'provider_selection', 'provider_operations', 'semantic_discovery'] as const) {
    snapshot.stageDurations[key] += initial.stageDurations[key];
  }
  const finalProviderCount = snapshot.selection.candidates.filter((candidate) => candidate.high_confidence || candidate.deterministic_provider_signature).length;
  const elapsed = completedAt - startedAt;
  const positive = trigger.requireSemanticControls
    ? probe.visible_semantic_control_count > 0
    : probe.strong_visible_surface_count > 0 || probe.visible_semantic_control_count > 0 || probe.provider_root_visible;
  const timedOut = !positive && elapsed >= CMP_UI_READINESS_MAX_MS - 50;
  return {
    snapshot: await finalizeDiagnostic(snapshot, elapsed),
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
  banner: BannerState, actions: AvailableAction[], consentMode: string, observationComplete: boolean, readiness?: ConsentUiReadinessSummary,
  semanticDiscovery?: ProviderSemanticDiscovery, diagnosticControlCensus?: DiagnosticConsentControlCensusRecord[], stageDurations?: ConsentCaptureStageDurations
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
    visible: control.visible, enabled: control.enabled, actionable: control.actionable, provider_specific: false, location: control.location === 'child_frame' ? 'iframe' : control.location
  }));
  for (const action of actions) {
    if (controls.length >= 20 || action.availability === 'not_present' || action.availability === 'unknown') continue;
    if (!controls.some((control) => control.semantic_action === action.action)) controls.push({
      accessible_name: '', semantic_action: action.action, visible: action.availability !== 'api_only', enabled: true,
      actionable: action.availability === 'direct' || action.availability === 'api_only', provider_specific: Boolean(selection.provider), location
    });
  }
  const semanticDiagnostic = semanticDiscovery?.diagnostic;
  const selectedCandidate = selection.provider && selection.candidates.find((candidate) => candidate.provider_id === selection.provider);
  const verifiedConsentSurfaceIds = new Set(facts.generic.surfaces
    .filter((surface) => surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent' && surface.strong_presentation)
    .map((surface) => surface.id));
  const exactCandidateCount = semanticDiagnostic
    ? semanticDiagnostic.role_candidate_count + semanticDiagnostic.link_candidate_count + semanticDiagnostic.open_shadow_candidate_count + semanticDiagnostic.text_candidate_count
    : 0;
  const exposeNearbyControls = Boolean(
    semanticDiagnostic?.attempted && selectedCandidate && (selectedCandidate.high_confidence || selectedCandidate.deterministic_provider_signature) &&
    (banner.visibility === 'visible' || verifiedConsentSurfaceIds.size > 0) && semanticControlCount(facts) === 0 && exactCandidateCount === 0
  );
  const nearbyActionableControls: NonNullable<NonNullable<DiagnosticConsentObservation['semantic_discovery']>['nearby_actionable_controls']> = [];
  if (exposeNearbyControls) {
    const retained = new Set<string>();
    const controlsForDiagnostics = diagnosticControlCensus?.length ? diagnosticControlCensus : facts.generic.controls;
    for (const control of controlsForDiagnostics) {
      const accessibleName = control.accessible_name.replace(/\s+/g, ' ').trim().slice(0, 120);
      const consentScopeCorroborated = 'consent_scope_corroborated' in control ? control.consent_scope_corroborated : verifiedConsentSurfaceIds.has(control.surface_id);
      const actionable = 'actionable' in control ? control.actionable : control.direct_actionable_target;
      if (!accessibleName || !actionable || !consentScopeCorroborated) continue;
      const item = {
        role: control.role || 'other' as const,
        accessible_name: accessibleName,
        location: control.location === 'child_frame' ? 'iframe' as const : control.location,
        shadow_depth: Math.max(0, Math.min(4, control.shadow_depth)),
        visible: control.visible,
        enabled: control.enabled,
        direct_actionable_target: control.direct_actionable_target === true,
        consent_scope_corroborated: true as const
      };
      const key = `${item.role}:${item.location}:${item.shadow_depth}:${item.accessible_name}`;
      if (retained.has(key)) continue;
      retained.add(key);
      nearbyActionableControls.push(item);
      if (nearbyActionableControls.length >= 20) break;
    }
  }
  return {
    capture_id: `consent-${context}-${Date.now()}`, context, phase, captured_at_ms: Date.now(), observation_complete: observationComplete,
    ...(stageDurations ? { capture_stage_durations_ms: { ...stageDurations } } : {}),
    provider_selection: { selected_provider: selection.provider || null, provider_conflict: selection.conflict, candidates: providerCandidates },
    banner: { visibility: banner.visibility, surface: banner.surface }, visible_surfaces: surfaces.slice(0, 12), visible_controls: controls.slice(0, 20),
    ...(semanticDiagnostic ? { semantic_discovery: {
      attempted: semanticDiagnostic.attempted,
      provider: semanticDiagnostic.provider,
      role_candidate_count: Math.min(80, semanticDiagnostic.role_candidate_count),
      link_candidate_count: Math.min(80, semanticDiagnostic.link_candidate_count),
      open_shadow_candidate_count: Math.min(80, semanticDiagnostic.open_shadow_candidate_count),
      text_candidate_count: Math.min(80, semanticDiagnostic.text_candidate_count),
      actionable_control_count: Math.min(20, semanticDiagnostic.actionable_control_count),
      rejection_counts: { ...semanticDiagnostic.rejection_counts },
      candidate_samples: semanticDiagnostic.candidate_samples.slice(0, 20).map((candidate) => ({ ...candidate, accessible_name: candidate.accessible_name.slice(0, 120) })),
      ...(exposeNearbyControls ? { nearby_actionable_controls: nearbyActionableControls } : {})
    } } : {}),
    frameworks: { tcf: framework.tcf.present, gpp: framework.gpp.present, consent_mode: consentMode, gpp_observation: framework.gpp }, ...(readiness ? { readiness } : {})
  };
}
async function providerOperations(provider: CmpAdapterProviderId | undefined, contexts: ProviderContexts) {
  if (!provider) return { state: unknownState(), banner: unknownBanner(), actions: [] as AvailableAction[], persistence: null as PersistenceResult | null };
  const context = contexts.get(provider); const [state, banner, actions, persistence] = await Promise.all([cmpAdapterRegistry.invoke<ConsentState>(provider, 'state_read', { context }), cmpAdapterRegistry.invoke<BannerState>(provider, 'banner_state', { context }), cmpAdapterRegistry.invoke<AvailableAction[]>(provider, 'available_actions', { context }), cmpAdapterRegistry.invoke<PersistenceResult>(provider, 'persistence_evidence', { context })]);
  return { state: state.value || unknownState(), banner: banner.value || unknownBanner(), actions: actions.value || [], persistence: persistence.value };
}

async function freshActionProviderContexts(page: Page, facts: BrowserConsentFacts, frameworks: ConsentFrameworkObservations, provider: CmpAdapterProviderId, geo: ConsentV2SessionInput['geo']) {
  const semanticDiscovery = provider === 'cookiebot' ? await discoverProviderSemanticControls(page, provider) : undefined;
  return { contexts: await buildProviderContexts(page, facts, frameworks, semanticDiscovery, geo), semanticDiscovery };
}

function targetResolutionDiagnostics(discovery: Awaited<ReturnType<typeof discoverProviderSemanticControls>> | undefined, context: unknown, action: ActionPlan['action'], category: ActionPlan['category'], apiAvailable = false) {
  const candidates = discovery?.diagnostic.candidate_samples || [];
  const matching = candidates.filter((candidate) => semanticActionForConsentLabel(candidate.accessible_name) === action);
  const controls = discovery?.controls.filter((control) => control.action === action) || [];
  const target = actionTargetFor(context, action, category);
  const resolved = apiAvailable || Boolean(target?.target_ref && target.attached && target.visible && target.enabled && target.accessible_control && target.frame_path?.length && target.shadow_mode !== 'closed');
  const rawReason = resolved ? 'resolved'
    : target && !target.visible ? 'not_visible'
      : target && !target.enabled ? 'disabled'
        : matching.find((candidate) => candidate.rejection_reason)?.rejection_reason || (matching.length ? 'not_direct_actionable_target' : 'label_not_found');
  const reason = ['resolved', 'label_not_found', 'not_visible', 'disabled', 'not_direct_actionable_target', 'outside_verified_consent_context', 'frame_unavailable'].includes(rawReason) ? rawReason : 'other_bounded_reason';
  return { semantic_discovery_attempted: discovery?.diagnostic.attempted === true, semantic_candidate_count: Math.min(80, matching.length), semantic_actionable_count: Math.min(20, controls.length), requested_action_target_resolved: resolved, target_resolution_reason: reason as NonNullable<ConsentV2Telemetry['target_resolution_reason']> };
}

function usPrivacyObservation(
  geo: ConsentV2SessionInput['geo'],
  facts: BrowserConsentFacts,
  framework: ConsentFrameworkObservations,
  selection: ProviderSelection
) {
  const selectedCandidate = selection.provider && selection.candidates.find((candidate) => candidate.provider_id === selection.provider);
  const providerConfirmed = Boolean(selection.provider && selectedCandidate && (selectedCandidate.high_confidence || selectedCandidate.deterministic_provider_signature));
  const providerControls = selection.provider === 'cookiebot'
    ? facts.observations
      .filter((item) => item.selector.startsWith('#CybotCookiebotDialogBody'))
      .map((item) => ({ accessible_name: item.text, visible: item.visible, enabled: item.enabled, actionable: item.visible && item.enabled, provider_specific: true }))
    : [];
  return buildUSPrivacyObservation({
    geo,
    provider: selection.provider || null,
    provider_confirmed: providerConfirmed,
    surfaces: facts.generic.surfaces,
    controls: facts.generic.controls,
    provider_controls: providerControls,
    gpc_signal: facts.gpc_signal,
    gpc_acknowledgement_observed: facts.gpc_acknowledgement_observed,
    frameworks: framework
  });
}

/**
 * Captures passive CMP facts from the shared homepage after its existing
 * observation window. This deliberately does not create a V2 session, make a
 * decision, or attempt an action.
 */
export async function captureSharedConsentObservation(
  page: Page,
  controls: ConsentV2RolloutControls = consentV2RolloutControls(),
  diagnostic = false,
  geo: ConsentV2SessionInput['geo'] = 'EU'
): Promise<SharedConsentObservation> {
  const captured = await captureConsentUiReadySnapshot(page, controls, true, diagnostic, geo);
  const { facts, frameworkObservations, contexts, selection } = captured.snapshot;
  const frameworks = frameworkStateFromObservations(frameworkObservations);
  const providerOperationsStartedAt = Date.now();
  const provider = await providerOperations(selection.provider, contexts);
  const finalProviderOperationsMs = Date.now() - providerOperationsStartedAt;
  captured.snapshot.stageDurations.provider_operations += finalProviderOperationsMs;
  captured.snapshot.stageDurations.total += finalProviderOperationsMs;
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
    us_privacy: usPrivacyObservation(geo, facts, frameworkObservations, selection),
    ...(diagnostic ? { diagnostic_observation: diagnosticObservation('shared', 'homepage_shared_observation', facts, frameworkObservations, selection, banner, actions, 'not_recorded', true, captured.readiness, captured.snapshot.semanticDiscovery, captured.snapshot.diagnosticControlCensus, captured.snapshot.stageDurations) } : {}) };
}

function available(action: AvailableAction | undefined) {
  return Boolean(action && action.availability !== 'not_present' && action.availability !== 'unknown');
}

/** Positive shared facts survive unavailable or unattributed fresh context.
 * A conflicting negative needs a complete observation from the same provider. */
export function mergeSharedConsentObservation(
  shared: SharedConsentObservation | null,
  fresh: Pick<ConsentV2SessionOutput, 'result' | 'telemetry'> | null
): MergedConsentObservation {
  if (!shared && !fresh) return { provider: null, provider_conflict: false, banner: { surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] }, actions: [], us_privacy: null };
  if (!fresh) return shared!;
  const freshProvider = fresh.telemetry.provider as CmpAdapterProviderId | 'generic' | null;
  const providerConflict = Boolean(shared?.provider_conflict || fresh.telemetry.provider_conflict || (shared?.provider && freshProvider && shared.provider !== freshProvider));
  const provider = providerConflict ? null : freshProvider || shared?.provider || null;
  const freshBanner = fresh.result.banner;
  const sharedVisible = shared?.banner.visibility === 'visible';
  const sameProviderComplete = Boolean(shared?.provider && freshProvider === shared.provider && fresh.telemetry.session_status === 'completed' && fresh.telemetry.timeline.initial_observation_completed_at !== null);
  const banner = sharedVisible && freshBanner.visibility === 'not_visible' && sameProviderComplete
    ? { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: ['shared_visible_fresh_not_visible'], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] }
    : sharedVisible && (!freshProvider || freshBanner.visibility === 'unknown')
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
  return { provider, provider_conflict: providerConflict, banner, actions, us_privacy: mergeUSPrivacyObservations(shared?.us_privacy, fresh.result.us_privacy) };
}

function actionPlanFor(provider: CmpAdapterProviderId, actions: AvailableAction[], banner: BannerState, context: unknown, action: ActionPlan['action'], category: ActionPlan['category'] = null, timings?: ConsentTimingValues) {
  const candidate = actions.find((item) => item.action === action && item.category === category && (item.availability === 'direct' || item.availability === 'api_only'));
  if (!candidate) return null;
  const target = actionTargetFor(context, action, category);
  if (provider === 'cookiebot' && candidate.availability === 'direct' && (!target?.target_ref || !target.attached || !target.visible || !target.enabled || !target.accessible_control || !target.frame_path?.length || target.shadow_mode === 'closed')) return null;
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

function tcfDiagnosticSummary(observation: ConsentFrameworkObservations['tcf']) {
  const purpose = observation.latest_event?.purpose_consents || { known: false, total_count: 0, granted_count: 0, denied_count: 0 };
  const vendor = observation.latest_event?.vendor_consents || { known: false, total_count: 0, granted_count: 0, denied_count: 0 };
  const pingState: 'stub' | 'loading' | 'loaded' | 'error' | 'unknown' = observation.ping?.cmp_status || (observation.ping?.cmp_loaded === true ? 'loaded' : observation.ping?.cmp_loaded === false ? 'stub' : 'unknown');
  const semanticState: 'stub' | 'loading' | 'loaded' | 'error' | 'unknown' = observation.latest_event?.cmp_status || 'unknown';
  const aggregateAvailability: 'populated' | 'empty' | 'unavailable' = (purpose.known && purpose.total_count > 0) || (vendor.known && vendor.total_count > 0) ? 'populated'
    : purpose.known || vendor.known ? 'empty' : 'unavailable';
  return {
    lifecycle: observation.lifecycle,
    cmp_loaded: observation.ping?.cmp_loaded ?? null,
    cmp_status: observation.latest_event?.cmp_status ?? observation.ping?.cmp_status ?? null,
    ping_state: pingState,
    latest_semantic_state: semanticState,
    lifecycle_reconciled: observation.lifecycle_reconciled === true,
    aggregate_availability: aggregateAvailability,
    event_status: observation.latest_event?.event_status ?? null,
    listener_registered: observation.listener_registered === true,
    listener_event_observed: observation.listener_event_observed === true,
    listener_registration_failed: observation.listener_registration_failed === true,
    event_count: Math.max(0, Math.min(100, observation.event_count)),
    purpose_consents: { ...purpose },
    vendor_consents: { ...vendor }
  };
}

function telemetry(result: FinalConsentAuditResult, tracking: TrackingConsistencyResult, facts: BrowserConsentFacts, generic: GenericConsentDetectionResult, frameworkObservations: ConsentFrameworkObservations, controls: ConsentV2RolloutControls, provider: CmpAdapterProviderId | undefined, conflict: boolean, blocked: boolean, actionsEnabled: boolean, rolloutGateEligible: boolean, timeline: ConsentV2Timeline, geo: ConsentV2SessionInput['geo'], capture: PreparedConsentV2Session, actionDiagnostics?: { action_execution_eligible: boolean; requested_action: string | null; execution_strategy: string | null; activation_occurred: boolean; semantic_discovery_attempted: boolean; semantic_candidate_count: number; semantic_actionable_count: number; requested_action_target_resolved: boolean; target_resolution_reason: NonNullable<ConsentV2Telemetry['target_resolution_reason']>; verification_capability: VerificationCapability; verification_strong_families: string[]; verification_supporting_families: string[]; verification_contradicting_families: string[]; verification_independence_groups: string[]; verification_reason_codes: string[]; tcf_capability_observation: ConsentFrameworkObservations['tcf'] }): ConsentV2Telemetry {
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
    rollout_gate_eligible: rolloutGateEligible,
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
    tcf_diagnostics: tcfDiagnosticSummary(frameworkObservations.tcf),
    consent_mode_classification: result.google_consent_mode.evidence[0] || 'unknown',
    ...(actionDiagnostics ? {
      action_execution_eligible: actionDiagnostics.action_execution_eligible,
      requested_action: actionDiagnostics.requested_action,
      semantic_discovery_attempted: actionDiagnostics.semantic_discovery_attempted,
      semantic_candidate_count: actionDiagnostics.semantic_candidate_count,
      semantic_actionable_count: actionDiagnostics.semantic_actionable_count,
      requested_action_target_resolved: actionDiagnostics.requested_action_target_resolved,
      target_resolution_reason: actionDiagnostics.target_resolution_reason,
      runtime_variant: provider === 'cookiebot' ? (facts.observations.some((item) => item.selector === '#CybotCookiebotDialog' && item.visible) ? 'standard_dialog' : 'custom_template') : null,
      reject_semantic: provider === 'cookiebot' && (interaction?.action === 'reject_all' || interaction?.action === 'only_necessary') ? interaction.action : null,
      execution_strategy: actionDiagnostics.execution_strategy,
      activation_occurred: actionDiagnostics.activation_occurred,
      verification_capability: actionDiagnostics.verification_capability.status,
      verification_capability_strong_families: actionDiagnostics.verification_capability.strong_families.slice(0, 4),
      verification_capability_reason_codes: actionDiagnostics.verification_capability.reason_codes.slice(0, 6),
      verification_strong_families: actionDiagnostics.verification_strong_families.slice(0, 8),
      verification_supporting_families: actionDiagnostics.verification_supporting_families.slice(0, 8),
      verification_contradicting_families: actionDiagnostics.verification_contradicting_families.slice(0, 8),
      verification_independence_groups: actionDiagnostics.verification_independence_groups.slice(0, 8),
      verification_reason_codes: actionDiagnostics.verification_reason_codes.slice(0, 8),
      post_reject_observation_complete: result.persistence.post_reload_observation_completed,
      tracking_consistency: tracking.status,
      tcf_capability_diagnostics: tcfDiagnosticSummary(actionDiagnostics.tcf_capability_observation)
    } : {}),
    consent_mode_diagnostics: (() => {
      const mode = capture.gcm.result();
      const coreValues = [mode.effective_state.ad_storage, mode.effective_state.analytics_storage, mode.effective_state.ad_user_data, mode.effective_state.ad_personalization];
      const effectiveStatus = coreValues.some((value) => value === 'unknown') ? 'unknown'
        : coreValues.every((value) => value !== 'unset') ? 'complete'
          : coreValues.every((value) => value === 'unset') ? 'none' : 'partial';
      const defaultCommand = mode.commands.find((command) => command.command === 'default');
      return {
        lifecycle: mode.lifecycle, classification: mode.classification,
        default_core_signals: mode.default_core_signals,
        effective_core_signals: { status: effectiveStatus },
        chronology: { default_issued_late: mode.default_issued_late, conflicting_defaults: mode.conflicting_defaults, update_only: mode.lifecycle === 'update_only' },
        wait_for_update: { present: defaultCommand?.state.wait_for_update_present || false, valid: typeof defaultCommand?.state.wait_for_update_ms === 'number' },
        network_observations: mode.network.length
      };
    })(),
    tracking_consistency: tracking.status,
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
    const initialCapture = await captureConsentUiReadySnapshot(page, rollout, !input.access_blocked && rollout.enabled, input.diagnostic === true, input.geo);
    capture.markInitialObservationCompleted();
    const { facts: before, frameworkObservations: initialFrameworkObservations, contexts, selection } = initialCapture.snapshot; observeNewGoogleConsentCommands(gcm, before, observedGoogleCommands);
    let frameworkObservations = initialFrameworkObservations; let frameworks = frameworkStateFromObservations(frameworkObservations);
    const initialUSPrivacy = usPrivacyObservation(input.geo, before, frameworkObservations, selection);
    const generic = genericDetection(before, frameworks, gcm); const shopify = await shopifyOperations(before); const provider = await providerOperations(selection.provider, contexts); const useGeneric = !selection.provider && !selection.conflict && rollout.providers.generic.detection_enabled && generic.status === 'detected';
    const baseMechanisms = input.access_blocked || !rollout.enabled ? [] : [...(shopify.mechanism ? [shopify.mechanism] : []), ...providerMechanism(selection.provider), ...(useGeneric && generic.mechanism ? [generic.mechanism] : [])]; const initial = selection.provider ? provider.state : selection.conflict ? unknownState() : shopify.state || provider.state; const banner = selection.provider ? provider.banner : selection.conflict ? { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: [], reason_codes: [ConsentAuditCodes.PROVIDER_CONFLICT, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] } : shopify.banner?.visibility === 'visible' ? shopify.banner : generic.action_plan.length ? { surface: generic.action_plan[0].surface_type, visibility: 'visible' as const, evidence: ['generic_detector_surface'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] } : unknownBanner(); const actions = selection.provider ? provider.actions : selection.conflict ? [] : shopify.actions.length ? shopify.actions : generic.actions;
    const providerActionGate = Boolean(selection.provider && consentV2ActionsEnabledFor(rollout, selection.provider as ConsentV2RolloutProvider, input.rollout_key || page.url()));
    const blocked = Boolean(input.access_blocked) || !rollout.enabled;
    if (blocked) { const mechanisms = input.access_blocked || !rollout.enabled ? [] : composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const result = buildResult(input, mechanisms, banner, actions, initial, null, [], { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }, { status: 'not_applicable', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] }, frameworks, gcm, requests, [input.access_blocked ? ConsentAuditCodes.BLOCKED_OR_CHALLENGED : ConsentAuditCodes.DETECTION_INCONCLUSIVE], initialUSPrivacy); const tracking = checkTrackingConsistency({ rejection_verification: result.rejection_verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: false, requests }); const telemetryResult = telemetry(result, tracking, before, generic, frameworkObservations, rollout, undefined, selection.conflict, blocked, false, providerActionGate, timeline, input.geo, capture); return { result, tracking, ledger, telemetry: telemetryResult, google_consent_mode: gcm.result(), ...(input.diagnostic ? { diagnostic_observation: diagnosticObservation('fresh', 'consent_fresh_observation', before, frameworkObservations, selection, banner, actions, telemetryResult.consent_mode_classification, false, initialCapture.readiness, initialCapture.snapshot.semanticDiscovery, initialCapture.snapshot.diagnosticControlCensus, initialCapture.snapshot.stageDurations) } : {}) }; }
    const actionAvailable = actions.some((item) => (item.action === 'reject_all' && ['direct', 'api_only', 'preferences_only'].includes(item.availability)) || (item.action === 'only_necessary' && item.availability === 'direct'));
    let verificationCapability = selection.provider
      ? assessRejectVerificationCapability({ providerState: provider.state, frameworks: frameworkObservations })
      : { status: 'unavailable', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_UNAVAILABLE] } as VerificationCapability;
    let tcfCapabilityObservation = frameworkObservations.tcf;
    let actionExecutionEligible = false;
    let actionBoundaryDiagnostics = { semantic_discovery_attempted: false, semantic_candidate_count: 0, semantic_actionable_count: 0, requested_action_target_resolved: false, target_resolution_reason: 'label_not_found' as NonNullable<ConsentV2Telemetry['target_resolution_reason']> };
    const requestedAction = actions.some((item) => item.action === 'reject_all' && ['direct', 'api_only'].includes(item.availability)) ? 'reject_all'
      : actions.some((item) => item.action === 'only_necessary' && item.availability === 'direct') ? 'only_necessary'
        : actionAvailable ? 'reject_all' : null;
    let executionStrategy: ConsentInteractionStrategy | null = null;
    let verificationSignals: ReturnType<typeof collectRejectVerificationSignals> = [];
    let after = before; const attempts: FinalConsentAuditResult['interactions'] = []; let attempt: FinalConsentAuditResult['interactions'][number] | null = null;
    let verification: VerificationResult = { status: 'inconclusive', evidence: [], reason_codes: providerActionGate && actionAvailable && verificationCapability.status !== 'available' ? verificationCapability.reason_codes : [ConsentAuditCodes.ACTION_INCONCLUSIVE] };
    let timestamp: number | null = null;
    if (selection.provider && providerActionGate && actionAvailable && verificationCapability.status === 'available') {
      timeline.reject_started_at = Date.now(); timeline.action_attempt_started_at = timeline.reject_started_at; gcm.markPreChoiceMeasurementWindowObserved();
      for (let transition = 0; transition < 2 && !attempt; transition += 1) {
        // Each state transition rebuilds facts, provider context, action inventory,
        // and target topology. No control reference survives a previous action.
        after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const observed = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, observed); frameworks = frameworkStateFromObservations(frameworkObservations); const live = await freshActionProviderContexts(page, after, frameworkObservations, selection.provider, input.geo); const liveContexts = live.contexts; const liveProvider = await providerOperations(selection.provider, liveContexts); actionBoundaryDiagnostics = targetResolutionDiagnostics(live.semanticDiscovery, liveContexts.get(selection.provider), requestedAction || 'reject_all', null, liveProvider.actions.some((item) => item.action === (requestedAction || 'reject_all') && item.availability === 'api_only')); verificationCapability = assessRejectVerificationCapability({ providerState: liveProvider.state, frameworks: frameworkObservations }); tcfCapabilityObservation = frameworkObservations.tcf; if (verificationCapability.status !== 'available') { actionExecutionEligible = false; verification = { status: 'inconclusive', evidence: [], reason_codes: verificationCapability.reason_codes }; break; } const machine = rejectStateMachineFor(selection.provider, liveProvider, liveContexts.get(selection.provider), timings);
        if (machine.status !== 'ready') {
          actionExecutionEligible = false;
          // Opening preferences is not a successful Reject. Record the missing
          // requested action explicitly so telemetry cannot report a false win.
          if (attempts.some((item) => item.action === 'open_preferences' && item.outcome === 'executed')) {
            attempt = { action: 'reject_all', origin: 'generic_ui', outcome: 'unsupported', category: null, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] };
            attempts.push(attempt);
          }
          break;
        }
        if (transition > 0 && machine.steps.length === 1 && machine.steps[0].action === 'open_preferences') {
          actionExecutionEligible = false;
          attempt = { action: 'reject_all', origin: 'generic_ui', outcome: 'unsupported', category: null, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] };
          attempts.push(attempt);
          break;
        }
        for (const step of machine.steps) {
          const freshFacts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, freshFacts, observedGoogleCommands); const freshFrameworks = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, freshFrameworks); frameworks = frameworkStateFromObservations(frameworkObservations); const fresh = await freshActionProviderContexts(page, freshFacts, frameworkObservations, selection.provider, input.geo); const freshContexts = fresh.contexts; const freshProvider = await providerOperations(selection.provider, freshContexts); verificationCapability = assessRejectVerificationCapability({ providerState: freshProvider.state, frameworks: frameworkObservations }); tcfCapabilityObservation = frameworkObservations.tcf; if (verificationCapability.status !== 'available') { actionExecutionEligible = false; verification = { status: 'inconclusive', evidence: [], reason_codes: verificationCapability.reason_codes }; break; } actionBoundaryDiagnostics = targetResolutionDiagnostics(fresh.semanticDiscovery, freshContexts.get(selection.provider), requestedAction || step.action, null, freshProvider.actions.some((item) => item.action === (requestedAction || step.action) && item.availability === 'api_only')); const plan = actionPlanFor(selection.provider, freshProvider.actions, freshProvider.banner, freshContexts.get(selection.provider), step.action, step.category, timings);
          if (!plan) { actionExecutionEligible = false; attempt = { action: step.action, origin: 'generic_ui', outcome: 'unsupported', category: step.category, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] }; attempts.push(attempt); break; }
          actionExecutionEligible = step.action !== 'open_preferences';
          const executed = await executeActionPlan(plan, adapterActionBridge(page, selection.provider, ledger, timings, freshProvider.state, input.geo)); attempts.push(executed.attempt); if (step.action !== 'open_preferences' && executed.activated_at !== null) executionStrategy = executed.strategy; if (executed.attempt.outcome !== 'executed' && executed.activated_at === null) actionExecutionEligible = false;
          if (executed.attempt.outcome !== 'executed' && executed.attempt.outcome !== 'aborted') { attempt = executed.attempt; break; }
          if (step.action !== 'open_preferences') { attempt = executed.attempt; timestamp = executed.activated_at; break; }
        }
      }
      timeline.reject_completed_at = Date.now();
      if (attempt && (attempt.outcome === 'executed' || attempt.outcome === 'aborted') && timestamp !== null) { timeline.user_choice_at = timestamp; gcm.markUserChoice(timestamp); }
      after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const afterFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, afterFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const afterContexts = await buildProviderContexts(page, after, frameworkObservations, undefined, input.geo); const afterState = (await providerOperations(selection.provider, afterContexts)).state; const newProviderEvents = after.provider_events.filter((event) => !before.provider_events.includes(event)); const cookiebotEvent = selection.provider === 'cookiebot' ? after.cookiebot_events.slice(before.cookiebot_events.length).find((event) => event === 'CookiebotOnDecline' || event === 'CookiebotOnAccept') : undefined; verificationSignals = collectRejectVerificationSignals({ timestamp, interactionExecuted: attempt?.outcome === 'executed', navigationInterrupted: attempt?.outcome === 'aborted', providerState: afterState, providerStateIndependenceGroup: selection.provider === 'cookiebot' ? 'cookiebot_runtime' : undefined, providerEventObserved: selection.provider === 'cookiebot' ? false : newProviderEvents.length > 0 || (after.onetrust?.provider_events.length || 0) > (before.onetrust?.provider_events.length || 0), providerEventRelation: cookiebotEvent === 'CookiebotOnDecline' ? 'matches_requested' : cookiebotEvent === 'CookiebotOnAccept' ? 'contradicts_requested' : undefined, providerActionCompleted: after.cookieyes?.is_user_action_completed === true, frameworks: frameworkObservations }); verification = verifyRequestedConsentAction({ requested_action: attempt?.action || 'reject_all', action_timestamp: timestamp, signals: verificationSignals, navigation_interrupted: attempt?.outcome === 'aborted' }); if (timestamp === null && verificationCapability.status !== 'available') verification = { status: 'inconclusive', evidence: [], reason_codes: verificationCapability.reason_codes }; markTrackingGatedWhenObserved(gcm); }
    const afterContexts = await buildProviderContexts(page, after, frameworkObservations, undefined, input.geo); const resulting = (await providerOperations(selection.provider, afterContexts)).state; const persistence = await verifySameContextReloadPersistence({ meaningful_action_attempt: attempt?.outcome === 'executed' || attempt?.outcome === 'aborted', semantic_verification: verification, after_action: { semantic_state: { provider: resulting.decision, tcf: tcfObservationDecision(frameworkObservations.tcf), gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', shopify_privacy: shopify.state?.decision, consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(after) }, settle_timeout_ms: timings.reloadSettleMs }, { async reloadSameContext() { timeline.reload_started_at = Date.now(); const beforeUrl = page.url(); try { await page.reload({ waitUntil: 'commit' }); return { reloaded: true, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: false }; } catch { return { reloaded: false, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: true }; } }, async waitForSettle(timeoutMs) { try { await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }); return 'settled'; } catch { return 'timeout'; } }, async readPostReloadSnapshot() { const facts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, facts, observedGoogleCommands); const reloadFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, reloadFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const contextsAfterReload = await buildProviderContexts(page, facts, frameworkObservations, undefined, input.geo); const state = (await providerOperations(selection.provider, contextsAfterReload)).state; return { semantic_state: { provider: state.decision, tcf: tcfObservationDecision(frameworkObservations.tcf), gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(facts) }; } });
    const mechanisms = composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result()));
    const contradiction = hasGcmContradiction(verification, gcm);
    const hasCmpIdentity = baseMechanisms.some((mechanism) => mechanism.mechanism === 'cmp' || mechanism.mechanism === 'custom');
    const finalUSPrivacy = mergeUSPrivacyObservations(initialUSPrivacy, usPrivacyObservation(input.geo, after, frameworkObservations, selection));
    const reasonCodes = [
      ...(hasCmpIdentity ? [] : [ConsentAuditCodes.NO_CMP_DETECTED]),
      ...(selection.conflict ? [ConsentAuditCodes.PROVIDER_CONFLICT] : []),
      ...verification.reason_codes, ...persistence.reason_codes,
      ...(contradiction ? [ConsentAuditCodes.STATE_CONTRADICTION] : [])
    ];
    const result = buildResult(input, mechanisms, banner, actions, initial, resulting, attempts, verification, persistence, frameworks, gcm, requests, reasonCodes, finalUSPrivacy);
    const tracking = checkTrackingConsistency({ rejection_verification: verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: persistence.post_reload_observation_completed, requests });
    const verificationStrongFamilies = [...new Set(verificationSignals.filter((signal) => signal.rank === 'strong' && signal.relation === 'matches_requested').map((signal) => signal.family))];
    const verificationSupportingFamilies = [...new Set(verificationSignals.filter((signal) => signal.rank === 'supporting' && signal.relation === 'matches_requested').map((signal) => signal.family))];
    const verificationContradictingFamilies = [...new Set(verificationSignals.filter((signal) => signal.relation === 'contradicts_requested').map((signal) => signal.family))];
    const verificationIndependenceGroups = [...new Set(verificationSignals.map((signal) => signal.independence_group).filter((group): group is string => Boolean(group)))];
    const telemetryResult = telemetry(result, tracking, before, generic, frameworkObservations, rollout, selection.provider, selection.conflict, false, actionExecutionEligible, providerActionGate, timeline, input.geo, capture, {
      action_execution_eligible: actionExecutionEligible,
      requested_action: requestedAction,
      ...actionBoundaryDiagnostics,
      execution_strategy: executionStrategy,
      activation_occurred: timestamp !== null,
      verification_capability: verificationCapability,
      verification_strong_families: verificationStrongFamilies,
      verification_supporting_families: verificationSupportingFamilies,
      verification_contradicting_families: verificationContradictingFamilies,
      verification_independence_groups: verificationIndependenceGroups,
      verification_reason_codes: verification.reason_codes,
      tcf_capability_observation: tcfCapabilityObservation
    });
    return { result, tracking, ledger, telemetry: telemetryResult, google_consent_mode: gcm.result(), ...(input.diagnostic ? { diagnostic_observation: diagnosticObservation('fresh', 'consent_fresh_observation', before, frameworkObservations, selection, banner, actions, telemetryResult.consent_mode_classification, true, initialCapture.readiness, initialCapture.snapshot.semanticDiscovery, initialCapture.snapshot.diagnosticControlCensus, initialCapture.snapshot.stageDurations) } : {}) };
  } finally { capture.dispose(); }
}

function adapterActionBridge(page: Page, provider: CmpAdapterProviderId, ledger: ConsentEvidenceLedger, timings: ConsentTimingValues, initial: ConsentState, geo: ConsentV2SessionInput['geo']): InteractionExecutionBridge {
  const refreshed = async () => {
    const facts = await captureBrowserConsentFacts(page); const frameworks = await observeConsentFrameworksInPage(page); const fresh = await freshActionProviderContexts(page, facts, frameworks, provider, geo); const contexts = fresh.contexts;
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
      const result = await cmpAdapterRegistry.invoke<{ outcome: 'executed' | 'not_executed' }>(provider, capability, { context: current.contexts.get(provider), requested_action: plan.action });
      return result.value?.outcome === 'executed' ? 'executed' : result.value?.outcome === 'not_executed' ? 'not_executed' : 'unsupported';
    },
    appendEvidence(event) { ledger.append({ phase: 'pre_action', source: 'provider_adapter', family: 'semantic', kind: event.kind === 'state_transition' ? 'state_change' : 'semantic_control', specificity: 'provider_specific', stability: 'stable', provenance: 'adapter', provider_candidate: provider, descriptor: { exists: true } }); },
    async waitForStabilization() { await page.waitForTimeout(timings.postActionSettleMs); const state = (await refreshed()).operations.state; return { state_changed: state.decision !== initial.decision, navigation_interrupted: page.isClosed() }; }
  };
}
function buildResult(input: ConsentV2SessionInput, mechanisms: MechanismResult[], banner: BannerState, actions: AvailableAction[], initial: ConsentState, resulting: ConsentState | null, interactions: FinalConsentAuditResult['interactions'], verification: VerificationResult, persistence: PersistenceResult, frameworks: FrameworkState, gcm: GoogleConsentModeObserver, requests: TrackingRequestEvidence[], reasonCodes: ConsentAuditCode[], usPrivacy: USPrivacyObservation | null): FinalConsentAuditResult { const observed = gcm.result(); return { context_clean: { status: 'verified', evidence: ['fresh_playwright_context'], reason_codes: [] }, geo_verified: { status: input.geo_verified === true ? 'verified' : 'inconclusive', evidence: [], reason_codes: input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED] }, mechanisms, banner, available_actions: actions, initial_state: initial, resulting_state: resulting, interactions, rejection_verification: verification, persistence, frameworks, google_consent_mode: { presence: observed.lifecycle === 'not_observed' ? 'not_present' : observed.classification === 'ambiguous' ? 'ambiguous' : 'present', defaults_observed: observed.commands.some((item) => item.command === 'default'), updates_observed: observed.commands.some((item) => item.command === 'update'), evidence: [observed.classification], reason_codes: observed.reason_codes }, us_privacy: usPrivacy, storage_changes: [], network_signals: requests.slice(0, 100).map((item) => ({ host: item.host, path: item.path, method: item.method, phase: item.phase, signal: item.kind === 'script' ? 'script' : 'tracking' })), reason_codes: [...new Set([...(input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED]), ...reasonCodes])] }; }
