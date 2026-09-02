import type { Page, Request } from 'playwright-core';
import type { EvidenceBundle, TrackingRequestEvidence } from '../../types';
import { consentTimingValues, type ConsentTimingValues } from '../../shared/config';
import { cmpAdapterRegistry, platformRuntimeRegistry, scoreProviderCandidates, type CmpAdapterProviderId } from './adapter-registry';
import './onetrust-adapter'; import './cookiebot-adapter'; import './usercentrics-adapter'; import './didomi-adapter'; import './cookieyes-adapter'; import './sourcepoint-adapter'; import './shopify-customer-privacy-runtime';
import { buildRejectStateMachine, executeActionPlan, planFromAvailableAction, type ActionPlan, type ConsentInteractionStrategy, type InteractionExecutionBridge } from './action-planner';
import { actionTargetFor, buildPersistenceStorage, buildProviderContexts, buildShopifyCustomerPrivacyContext, captureBrowserConsentFacts, installConsentCommandBootstrap, observeConsentFrameworksInPage, type BrowserConsentFacts } from './browser-context-builders';
import { ConsentEvidenceLedger } from './evidence-ledger';
import { ConsentAuditCodes, type AvailableAction, type BannerState, type ConsentAuditCode, type ConsentDecision, type ConsentState, type FinalConsentAuditResult, type FrameworkState, type MechanismResult, type PersistenceResult, type VerificationResult } from './domain-types';
import { detectGenericConsentMechanism, type GenericConsentDetectionResult } from './generic-consent-detector';
import { googleConsentModeMechanism, GoogleConsentModeObserver } from './google-consent-mode-observer';
import { frameworkMechanisms, frameworkStateFromObservations, mergeConsentFrameworkObservations, tcfObservationDecision } from './framework-observers';
import { shopifyCustomerPrivacyMechanism } from './shopify-customer-privacy-runtime';
import { verifySameContextReloadPersistence } from './persistence-verification';
import { verifyRequestedConsentAction } from './reject-verification-engine';
import { collectRejectVerificationSignals } from './verification-evidence';
import { captureConsentTrackingRequest, checkTrackingConsistency, type TrackingConsistencyResult } from './tracking-consistency';
import { buildUnknownCmpFingerprint } from './unknown-cmp-fingerprint';
import { consentV2ActionsEnabledFor, consentV2RolloutControls, type ConsentV2RolloutControls, type ConsentV2RolloutProvider } from './rollout-controls';

export interface ConsentV2SessionInput { geo: 'USA' | 'EU' | 'UK'; geo_verified: boolean | null; page_valid: boolean | null; timings?: ConsentTimingValues; access_blocked?: boolean; rollout?: ConsentV2RolloutControls; rollout_key?: string; }
export type ConsentV2Telemetry = NonNullable<EvidenceBundle['runtime']['consent_v2']>;
export interface ConsentV2SessionOutput { result: FinalConsentAuditResult; tracking: TrackingConsistencyResult; ledger: ConsentEvidenceLedger; telemetry: ConsentV2Telemetry; google_consent_mode: ReturnType<GoogleConsentModeObserver['result']>; }
type ProviderContexts = Map<CmpAdapterProviderId, unknown>;
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
  const ledger = new ConsentEvidenceLedger(); const requests: TrackingRequestEvidence[] = []; const gcm = new GoogleConsentModeObserver();
  const listener = (request: Request) => {
    const timestamp = Date.now(); const url = request.url();
    // postData is immediately reduced by the owning observers/classifier and
    // is never appended to requests, the ledger, telemetry, or persistence.
    const postData = request.method().toUpperCase() === 'POST' ? request.postData() : null;
    gcm.observeMeasurementRequest({ url, body: postData || undefined, timestamp });
    const captured = captureConsentTrackingRequest({ url, resource_type: request.resourceType(), method: request.method(), post_data: postData, timestamp });
    if (captured && requests.length < 100) requests.push(captured);
  };
  let disposed = false;
  page.on('request', listener);
  return {
    timeline, ledger, requests, gcm,
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
  const plausible = candidates.filter((candidate) => candidate.score >= 85 && candidate.independent_families.length >= 2 && !candidate.strong_conflict)
    .map((candidate) => candidate.provider_id as CmpAdapterProviderId)
    .filter((provider) => controls.providers[provider].detection_enabled);
  if (plausible.length === 0) return { provider: undefined, candidates, conflict: false };
  // Scoring intentionally marks tied candidates inconclusive. Resolve those
  // ties from active browser surfaces rather than falling back to registry order.
  const detected = await Promise.all(plausible.map(async (provider) => ({ provider, operations: await providerOperations(provider, contexts) })));
  if (detected.length === 1) return { provider: detected[0].provider, candidates, conflict: false };
  const active = detected.filter((item) => item.operations.banner.visibility === 'visible' || item.operations.actions.some((action) => action.availability === 'direct'));
  if (active.length === 1) return { provider: active[0].provider, candidates, conflict: true };
  return { provider: undefined, candidates, conflict: detected.length > 1 };
}
async function providerOperations(provider: CmpAdapterProviderId | undefined, contexts: ProviderContexts) {
  if (!provider) return { state: unknownState(), banner: unknownBanner(), actions: [] as AvailableAction[], persistence: null as PersistenceResult | null };
  const context = contexts.get(provider); const [state, banner, actions, persistence] = await Promise.all([cmpAdapterRegistry.invoke<ConsentState>(provider, 'state_read', { context }), cmpAdapterRegistry.invoke<BannerState>(provider, 'banner_state', { context }), cmpAdapterRegistry.invoke<AvailableAction[]>(provider, 'available_actions', { context }), cmpAdapterRegistry.invoke<PersistenceResult>(provider, 'persistence_evidence', { context })]);
  return { state: state.value || unknownState(), banner: banner.value || unknownBanner(), actions: actions.value || [], persistence: persistence.value };
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

function telemetry(result: FinalConsentAuditResult, tracking: TrackingConsistencyResult, facts: BrowserConsentFacts, controls: ConsentV2RolloutControls, provider: CmpAdapterProviderId | undefined, conflict: boolean, blocked: boolean, actionsEnabled: boolean, timeline: ConsentV2Timeline): ConsentV2Telemetry { const fingerprint = result.mechanisms.some((item) => item.mechanism === 'custom') ? buildUnknownCmpFingerprint({ mechanism_score: 70, provider_attribution: 'unknown_candidate', geo: null, available_actions: result.available_actions, storage_key_names: facts.storage_keys, candidate_global_names: facts.globals }) : null; const reject = result.available_actions.find((item) => item.action === 'reject_all'); return { enabled: controls.enabled, observation_only: !actionsEnabled, provider: provider || (result.mechanisms.some((item) => item.mechanism === 'custom') ? 'generic' : null), provider_confidence: provider ? 'high' : result.mechanisms.some((item) => item.mechanism === 'custom') ? 'medium' : null, provider_conflict: conflict, banner_visibility: result.banner.visibility, reject_availability: reject?.availability || 'not_present', interaction_outcome: result.interactions[0]?.outcome || 'not_attempted', verification: result.rejection_verification.status, persistence: result.persistence.status, generic_fallback: result.mechanisms.some((item) => item.mechanism === 'custom'), selector_or_action_failure: result.interactions.some((item) => item.outcome !== 'executed'), tcf_present: facts.globals.includes('__tcfapi'), gpp_present: facts.globals.includes('__gpp'), consent_mode_classification: result.google_consent_mode.evidence[0] || 'unknown', tracking_consistency: tracking.status, unknown_cmp_fingerprint: fingerprint?.fingerprint || null, geo_unverified: result.geo_verified.status !== 'verified', blocked_or_challenged: blocked, timeline: { ...timeline } }; }

/** Production composition root. Provider, framework, Shopify, and generic semantics stay in their owning modules. */
export async function runConsentV2Session(page: Page, input: ConsentV2SessionInput, prepared?: PreparedConsentV2Session): Promise<ConsentV2SessionOutput> {
  const timings = input.timings || consentTimingValues(); const rollout = input.rollout || consentV2RolloutControls(); const capture = prepared || await prepareConsentV2Session(page); const { ledger, requests, gcm, timeline } = capture;
  try {
    capture.markInitialObservationCompleted();
    ledger.append({ phase: 'baseline', source: 'page', family: 'semantic', kind: 'presence', specificity: 'generic', stability: 'stable', provenance: 'browser_api', descriptor: { exists: true } });
    const observedGoogleCommands = new Set<string>();
    const before = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, before, observedGoogleCommands);
    let frameworkObservations = await observeConsentFrameworksInPage(page); let frameworks = frameworkStateFromObservations(frameworkObservations); const contexts = await buildProviderContexts(page, before, frameworkObservations); const selection = rollout.enabled ? await selectProvider(contexts, rollout) : { provider: undefined, candidates: [], conflict: false };
    const generic = genericDetection(before, frameworks, gcm); const shopify = await shopifyOperations(before); const provider = await providerOperations(selection.provider, contexts); const useGeneric = !selection.provider && !selection.conflict && rollout.providers.generic.detection_enabled && generic.status === 'detected';
    const baseMechanisms = input.access_blocked || !rollout.enabled ? [] : [...(shopify.mechanism ? [shopify.mechanism] : []), ...providerMechanism(selection.provider), ...(useGeneric && generic.mechanism ? [generic.mechanism] : [])]; const initial = selection.provider ? provider.state : selection.conflict ? unknownState() : shopify.state || provider.state; const banner = selection.provider ? provider.banner : selection.conflict ? { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: [], reason_codes: [ConsentAuditCodes.PROVIDER_CONFLICT, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] } : shopify.banner?.visibility === 'visible' ? shopify.banner : generic.action_plan.length ? { surface: generic.action_plan[0].surface_type, visibility: 'visible' as const, evidence: ['generic_detector_surface'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] } : unknownBanner(); const actions = selection.provider ? provider.actions : selection.conflict ? [] : shopify.actions.length ? shopify.actions : generic.actions;
    const blocked = Boolean(input.access_blocked) || !rollout.enabled;
    if (blocked) { const mechanisms = input.access_blocked || !rollout.enabled ? [] : composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const result = buildResult(input, mechanisms, banner, actions, initial, null, [], { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }, { status: 'not_applicable', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] }, frameworks, gcm, requests, [input.access_blocked ? ConsentAuditCodes.BLOCKED_OR_CHALLENGED : ConsentAuditCodes.DETECTION_INCONCLUSIVE]); const tracking = checkTrackingConsistency({ rejection_verification: result.rejection_verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: false, requests }); return { result, tracking, ledger, telemetry: telemetry(result, tracking, before, rollout, undefined, selection.conflict, blocked, false, timeline), google_consent_mode: gcm.result() }; }
    const actionEnabled = consentV2ActionsEnabledFor(rollout, (selection.provider || 'generic') as ConsentV2RolloutProvider, input.rollout_key || page.url()); let after = before; const attempts: FinalConsentAuditResult['interactions'] = []; let attempt: FinalConsentAuditResult['interactions'][number] | null = null; let verification: VerificationResult = { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }; let timestamp: number | null = null;
    if (selection.provider && actionEnabled) {
      timeline.reject_started_at = Date.now(); timeline.action_attempt_started_at = timeline.reject_started_at; gcm.markPreChoiceMeasurementWindowObserved();
      for (let transition = 0; transition < 2 && !attempt; transition += 1) {
        // Each state transition rebuilds facts, provider context, action inventory,
        // and target topology. No control reference survives a previous action.
        after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const observed = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, observed); frameworks = frameworkStateFromObservations(frameworkObservations); const liveContexts = await buildProviderContexts(page, after, frameworkObservations); const liveProvider = await providerOperations(selection.provider, liveContexts); const machine = rejectStateMachineFor(selection.provider, liveProvider, liveContexts.get(selection.provider), timings);
        if (machine.status !== 'ready') break;
        if (transition > 0 && machine.steps.length === 1 && machine.steps[0].action === 'open_preferences') break;
        for (const step of machine.steps) {
          const freshFacts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, freshFacts, observedGoogleCommands); const freshFrameworks = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, freshFrameworks); frameworks = frameworkStateFromObservations(frameworkObservations); const freshContexts = await buildProviderContexts(page, freshFacts, frameworkObservations); const freshProvider = await providerOperations(selection.provider, freshContexts); const plan = actionPlanFor(selection.provider, freshProvider.actions, freshProvider.banner, freshContexts.get(selection.provider), step.action, step.category, timings);
          if (!plan) { attempt = { action: step.action, origin: 'generic_ui', outcome: 'unsupported', category: step.category, reason_codes: [ConsentAuditCodes.INTERACTION_UNSUPPORTED, ConsentAuditCodes.ACTION_NOT_EXPOSED] }; attempts.push(attempt); break; }
          const executed = await executeActionPlan(plan, adapterActionBridge(page, selection.provider, ledger, timings, freshProvider.state)); attempts.push(executed.attempt);
          if (executed.attempt.outcome !== 'executed' && executed.attempt.outcome !== 'aborted') { attempt = executed.attempt; break; }
          if (step.action !== 'open_preferences') { attempt = executed.attempt; break; }
        }
      }
      timeline.reject_completed_at = Date.now();
      if (attempt && (attempt.outcome === 'executed' || attempt.outcome === 'aborted')) { timestamp = timeline.action_attempt_started_at; timeline.user_choice_at = timestamp; gcm.markUserChoice(timestamp); }
      after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const afterFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, afterFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const afterContexts = await buildProviderContexts(page, after, frameworkObservations); const afterState = (await providerOperations(selection.provider, afterContexts)).state; const adapterVerification = await cmpAdapterRegistry.invoke<VerificationResult>(selection.provider, 'verify_action', { context: afterContexts.get(selection.provider), timestamp }); verification = verifyRequestedConsentAction({ requested_action: attempt?.action || 'reject_all', action_timestamp: timestamp, signals: collectRejectVerificationSignals({ timestamp, interactionExecuted: attempt?.outcome === 'executed', navigationInterrupted: attempt?.outcome === 'aborted', providerState: afterState, adapterVerification: adapterVerification.value, frameworks: frameworkObservations }), navigation_interrupted: attempt?.outcome === 'aborted' }); markTrackingGatedWhenObserved(gcm); }
    const afterContexts = await buildProviderContexts(page, after, frameworkObservations); const resulting = (await providerOperations(selection.provider, afterContexts)).state; const persistence = await verifySameContextReloadPersistence({ meaningful_action_attempt: attempt?.outcome === 'executed' || attempt?.outcome === 'aborted', semantic_verification: verification, after_action: { semantic_state: { provider: resulting.decision, tcf: tcfObservationDecision(frameworkObservations.tcf), gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', shopify_privacy: shopify.state?.decision, consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(after) }, settle_timeout_ms: timings.reloadSettleMs }, { async reloadSameContext() { timeline.reload_started_at = Date.now(); const beforeUrl = page.url(); try { await page.reload({ waitUntil: 'commit' }); return { reloaded: true, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: false }; } catch { return { reloaded: false, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: true }; } }, async waitForSettle(timeoutMs) { try { await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }); return 'settled'; } catch { return 'timeout'; } }, async readPostReloadSnapshot() { const facts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, facts, observedGoogleCommands); const reloadFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, reloadFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const contextsAfterReload = await buildProviderContexts(page, facts, frameworkObservations); const state = (await providerOperations(selection.provider, contextsAfterReload)).state; return { semantic_state: { provider: state.decision, tcf: tcfObservationDecision(frameworkObservations.tcf), gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(facts) }; } });
    const mechanisms = composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const contradiction = hasGcmContradiction(verification, gcm); const hasCmpIdentity = baseMechanisms.some((mechanism) => mechanism.mechanism === 'cmp' || mechanism.mechanism === 'custom'); const result = buildResult(input, mechanisms, banner, actions, initial, resulting, attempts, verification, persistence, frameworks, gcm, requests, [...(hasCmpIdentity ? [] : [ConsentAuditCodes.NO_CMP_DETECTED]), ...(selection.conflict ? [ConsentAuditCodes.PROVIDER_CONFLICT] : []), ...verification.reason_codes, ...persistence.reason_codes, ...(contradiction ? [ConsentAuditCodes.STATE_CONTRADICTION] : [])]); const tracking = checkTrackingConsistency({ rejection_verification: verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: persistence.post_reload_observation_completed, requests }); return { result, tracking, ledger, telemetry: telemetry(result, tracking, before, rollout, selection.provider, selection.conflict, false, actionEnabled, timeline), google_consent_mode: gcm.result() };
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
