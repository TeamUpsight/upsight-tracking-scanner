import type { Page, Request } from 'playwright-core';
import type { EvidenceBundle, TrackingRequestEvidence } from '../../types';
import { consentTimingValues, type ConsentTimingValues } from '../../shared/config';
import { cmpAdapterRegistry, platformRuntimeRegistry, scoreProviderCandidates, type CmpAdapterProviderId } from './adapter-registry';
import './onetrust-adapter'; import './cookiebot-adapter'; import './usercentrics-adapter'; import './didomi-adapter'; import './cookieyes-adapter'; import './sourcepoint-adapter'; import './shopify-customer-privacy-runtime';
import { createActionPlan, executeActionPlan, type ActionPlan, type ConsentInteractionStrategy, type InteractionExecutionBridge } from './action-planner';
import { buildPersistenceStorage, buildProviderContexts, buildShopifyCustomerPrivacyContext, captureBrowserConsentFacts, installConsentCommandBootstrap, observeConsentFrameworksInPage, type BrowserConsentFacts } from './browser-context-builders';
import { ConsentEvidenceLedger } from './evidence-ledger';
import { ConsentAuditCodes, type AvailableAction, type BannerState, type ConsentAuditCode, type ConsentDecision, type ConsentState, type FinalConsentAuditResult, type FrameworkState, type MechanismResult, type PersistenceResult, type VerificationResult } from './domain-types';
import { detectGenericConsentMechanism, type GenericConsentDetectionResult } from './generic-consent-detector';
import { googleConsentModeMechanism, GoogleConsentModeObserver } from './google-consent-mode-observer';
import { frameworkMechanisms, frameworkStateFromObservations, mergeConsentFrameworkObservations } from './framework-observers';
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
export interface ConsentV2Timeline {
  session_started_at: number;
  navigation_started_at: number | null;
  dom_content_loaded_at: number | null;
  initial_observation_completed_at: number | null;
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
  const timeline: ConsentV2Timeline = { session_started_at: Date.now(), navigation_started_at: null, dom_content_loaded_at: null, initial_observation_completed_at: null, user_choice_at: null, reject_started_at: null, reject_completed_at: null, reload_started_at: null };
  const ledger = new ConsentEvidenceLedger(); const requests: TrackingRequestEvidence[] = []; const gcm = new GoogleConsentModeObserver();
  const listener = (request: Request) => {
    const timestamp = Date.now(); const url = request.url();
    gcm.observeMeasurementRequest({ url, timestamp });
    const captured = captureConsentTrackingRequest({ url, resource_type: request.resourceType(), method: request.method(), timestamp });
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

async function selectProvider(contexts: ReturnType<typeof buildProviderContexts>, controls: ConsentV2RolloutControls) {
  const evidence = cmpAdapterRegistry.collectProviderEvidence(contexts); const candidates = scoreProviderCandidates(evidence);
  for (const candidate of candidates.filter((item) => item.high_confidence)) { const provider = candidate.provider_id as CmpAdapterProviderId; if (!controls.providers[provider].detection_enabled) continue; const detected = await cmpAdapterRegistry.get(provider)?.detect({ evidence }); if (detected?.status === 'detected') return { provider, candidates }; }
  return { provider: undefined, candidates };
}
async function providerOperations(provider: CmpAdapterProviderId | undefined, contexts: ReturnType<typeof buildProviderContexts>) {
  if (!provider) return { state: unknownState(), banner: unknownBanner(), actions: [] as AvailableAction[], persistence: null as PersistenceResult | null };
  const context = contexts.get(provider); const [state, banner, actions, persistence] = await Promise.all([cmpAdapterRegistry.invoke<ConsentState>(provider, 'state_read', { context }), cmpAdapterRegistry.invoke<BannerState>(provider, 'banner_state', { context }), cmpAdapterRegistry.invoke<AvailableAction[]>(provider, 'available_actions', { context }), cmpAdapterRegistry.invoke<PersistenceResult>(provider, 'persistence_evidence', { context })]);
  return { state: state.value || unknownState(), banner: banner.value || unknownBanner(), actions: actions.value || [], persistence: persistence.value };
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
    let frameworkObservations = await observeConsentFrameworksInPage(page); let frameworks = frameworkStateFromObservations(frameworkObservations); const contexts = buildProviderContexts(page, before, frameworkObservations); const selection = rollout.enabled ? await selectProvider(contexts, rollout) : { provider: undefined, candidates: [] };
    const generic = genericDetection(before, frameworks, gcm); const shopify = await shopifyOperations(before); const provider = await providerOperations(selection.provider, contexts); const useGeneric = !selection.provider && rollout.providers.generic.detection_enabled && generic.status === 'detected';
    const baseMechanisms = input.access_blocked || !rollout.enabled ? [] : [...(shopify.mechanism ? [shopify.mechanism] : []), ...providerMechanism(selection.provider), ...(useGeneric && generic.mechanism ? [generic.mechanism] : [])]; const initial = provider.state.decision !== 'ambiguous' ? provider.state : shopify.state || provider.state; const banner = selection.provider ? provider.banner : shopify.banner?.visibility === 'visible' ? shopify.banner : generic.action_plan.length ? { surface: generic.action_plan[0].surface_type, visibility: 'visible' as const, evidence: ['generic_detector_surface'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] } : unknownBanner(); const actions = selection.provider ? provider.actions : shopify.actions.length ? shopify.actions : generic.actions;
    const blocked = Boolean(input.access_blocked) || !rollout.enabled;
    if (blocked) { const mechanisms = input.access_blocked || !rollout.enabled ? [] : composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const result = buildResult(input, mechanisms, banner, actions, initial, null, [], { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }, { status: 'not_applicable', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] }, frameworks, gcm, requests, [input.access_blocked ? ConsentAuditCodes.BLOCKED_OR_CHALLENGED : ConsentAuditCodes.DETECTION_INCONCLUSIVE]); const tracking = checkTrackingConsistency({ rejection_verification: result.rejection_verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: false, requests }); return { result, tracking, ledger, telemetry: telemetry(result, tracking, before, rollout, undefined, false, blocked, false, timeline), google_consent_mode: gcm.result() }; }
    const action = actions.find((item) => item.action === 'reject_all' && (item.availability === 'direct' || item.availability === 'api_only' || item.availability === 'preferences_only')); const actionEnabled = consentV2ActionsEnabledFor(rollout, (selection.provider || 'generic') as ConsentV2RolloutProvider, input.rollout_key || page.url()); let after = before; let attempt: FinalConsentAuditResult['interactions'][number] | null = null; let verification: VerificationResult = { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }; let timestamp: number | null = null;
    if (selection.provider && action && actionEnabled) { const plan = createActionPlan({ action: action.action as Exclude<typeof action.action, 'close'>, provider_or_mechanism: selection.provider, target: { surface_type: banner.surface === 'none' || banner.surface === 'unknown' ? 'banner' : banner.surface, target_ref: 'adapter_control', accessible_control: true, frame_path: ['top'], shadow_mode: 'unknown' }, eligible_strategies: action.availability === 'api_only' ? ['documented_provider_api'] : ['provider_selector', 'documented_provider_api'], timeout_ms: timings.postActionSettleMs, stabilization_ms: timings.postActionSettleMs, provider_api_reject_available: action.availability === 'api_only', user_facing_reject_available: action.availability === 'direct', prefer_user_facing: true }); timeline.reject_started_at = Date.now(); gcm.markPreChoiceMeasurementWindowObserved(); timestamp = Date.now(); timeline.user_choice_at = timestamp; gcm.markUserChoice(timestamp); const executed = await executeActionPlan(plan, adapterActionBridge(page, selection.provider, contexts, ledger, timings, initial)); attempt = executed.attempt; timeline.reject_completed_at = Date.now(); after = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, after, observedGoogleCommands); const afterFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, afterFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const afterContexts = buildProviderContexts(page, after, frameworkObservations); const afterState = (await providerOperations(selection.provider, afterContexts)).state; const adapterVerification = await cmpAdapterRegistry.invoke<VerificationResult>(selection.provider, 'verify_action', { context: afterContexts.get(selection.provider), timestamp }); verification = verifyRequestedConsentAction({ requested_action: action.action, action_timestamp: timestamp, signals: collectRejectVerificationSignals({ timestamp, interactionExecuted: executed.attempt.outcome === 'executed', navigationInterrupted: executed.attempt.outcome === 'aborted', providerState: afterState, adapterVerification: adapterVerification.value, frameworks: frameworkObservations }), navigation_interrupted: executed.attempt.outcome === 'aborted' }); markTrackingGatedWhenObserved(gcm); }
    const afterContexts = buildProviderContexts(page, after, frameworkObservations); const resulting = (await providerOperations(selection.provider, afterContexts)).state; const persistence = await verifySameContextReloadPersistence({ meaningful_action_attempt: attempt?.outcome === 'executed', semantic_verification: verification, after_action: { semantic_state: { provider: resulting.decision, tcf: frameworkObservations.tcf.latest_event ? (frameworkObservations.tcf.latest_event.purpose_consents.denied_count === frameworkObservations.tcf.latest_event.purpose_consents.total_count ? 'rejected' : 'ambiguous') : 'unavailable', gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', shopify_privacy: shopify.state?.decision, consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(after) }, settle_timeout_ms: timings.reloadSettleMs }, { async reloadSameContext() { timeline.reload_started_at = Date.now(); const beforeUrl = page.url(); try { await page.reload({ waitUntil: 'commit' }); return { reloaded: true, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: false }; } catch { return { reloaded: false, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: true }; } }, async waitForSettle(timeoutMs) { try { await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }); return 'settled'; } catch { return 'timeout'; } }, async readPostReloadSnapshot() { const facts = await captureBrowserConsentFacts(page); observeNewGoogleConsentCommands(gcm, facts, observedGoogleCommands); const reloadFrameworkObservations = await observeConsentFrameworksInPage(page); frameworkObservations = mergeConsentFrameworkObservations(frameworkObservations, reloadFrameworkObservations); frameworks = frameworkStateFromObservations(frameworkObservations); const contextsAfterReload = buildProviderContexts(page, facts, frameworkObservations); const state = (await providerOperations(selection.provider, contextsAfterReload)).state; return { semantic_state: { provider: state.decision, tcf: frameworkObservations.tcf.latest_event ? (frameworkObservations.tcf.latest_event.purpose_consents.denied_count === frameworkObservations.tcf.latest_event.purpose_consents.total_count ? 'rejected' : 'ambiguous') : 'unavailable', gpp: frameworkObservations.gpp.lifecycle === 'ready' ? 'ambiguous' : 'unavailable', consent_mode: gcm.result().commands.length ? 'ambiguous' : 'unavailable' }, storage: buildPersistenceStorage(facts) }; } });
    const mechanisms = composeMechanisms(baseMechanisms, frameworkMechanisms(frameworks), googleConsentModeMechanism(gcm.result())); const contradiction = hasGcmContradiction(verification, gcm); const hasCmpIdentity = baseMechanisms.some((mechanism) => mechanism.mechanism === 'cmp' || mechanism.mechanism === 'custom'); const result = buildResult(input, mechanisms, banner, actions, initial, resulting, attempt ? [attempt] : [], verification, persistence, frameworks, gcm, requests, [...(hasCmpIdentity ? [] : [ConsentAuditCodes.NO_CMP_DETECTED]), ...verification.reason_codes, ...persistence.reason_codes, ...(contradiction ? [ConsentAuditCodes.STATE_CONTRADICTION] : [])]); const tracking = checkTrackingConsistency({ rejection_verification: verification, user_choice_at: timeline.user_choice_at, post_reject_observation_completed: persistence.status !== 'not_applicable', requests }); return { result, tracking, ledger, telemetry: telemetry(result, tracking, before, rollout, selection.provider, selection.candidates.filter((item) => item.high_confidence).length > 1, false, actionEnabled, timeline), google_consent_mode: gcm.result() };
  } finally { capture.dispose(); }
}

function adapterActionBridge(page: Page, provider: CmpAdapterProviderId, contexts: ReturnType<typeof buildProviderContexts>, ledger: ConsentEvidenceLedger, timings: ConsentTimingValues, initial: ConsentState): InteractionExecutionBridge { return { async inspectTarget() { const banner = await cmpAdapterRegistry.invoke<BannerState>(provider, 'banner_state', { context: contexts.get(provider) }); const visible = banner.value?.visibility === 'visible'; return { attached: true, visible, enabled: true, surface_active: visible, frame_path: ['top'], shadow_mode: 'unknown', navigation_state: page.isClosed() ? 'interrupted' : 'idle' }; }, async executeStrategy(plan, strategy: ConsentInteractionStrategy) { if (strategy !== 'documented_provider_api' && strategy !== 'provider_selector') return 'unsupported'; const capability = plan.action === 'open_preferences' ? 'open_preferences' : plan.action === 'save_preferences' ? 'save_preferences' : 'reject'; const result = await cmpAdapterRegistry.invoke<{ outcome: 'executed' | 'not_executed' }>(provider, capability, { context: contexts.get(provider) }); return result.value?.outcome === 'executed' ? 'executed' : result.value?.outcome === 'not_executed' ? 'not_executed' : 'unsupported'; }, appendEvidence(event) { ledger.append({ phase: 'pre_action', source: 'provider_adapter', family: 'semantic', kind: event.kind === 'state_transition' ? 'state_change' : 'semantic_control', specificity: 'provider_specific', stability: 'stable', provenance: 'adapter', provider_candidate: provider, descriptor: { exists: true } }); }, async waitForStabilization() { await page.waitForTimeout(timings.postActionSettleMs); const facts = await captureBrowserConsentFacts(page); const frameworks = await observeConsentFrameworksInPage(page); const state = (await providerOperations(provider, buildProviderContexts(page, facts, frameworks))).state; return { state_changed: state.decision !== initial.decision, navigation_interrupted: page.isClosed() }; } }; }
function buildResult(input: ConsentV2SessionInput, mechanisms: MechanismResult[], banner: BannerState, actions: AvailableAction[], initial: ConsentState, resulting: ConsentState | null, interactions: FinalConsentAuditResult['interactions'], verification: VerificationResult, persistence: PersistenceResult, frameworks: FrameworkState, gcm: GoogleConsentModeObserver, requests: TrackingRequestEvidence[], reasonCodes: ConsentAuditCode[]): FinalConsentAuditResult { const observed = gcm.result(); return { context_clean: { status: 'verified', evidence: ['fresh_playwright_context'], reason_codes: [] }, geo_verified: { status: input.geo_verified === true ? 'verified' : 'inconclusive', evidence: [], reason_codes: input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED] }, mechanisms, banner, available_actions: actions, initial_state: initial, resulting_state: resulting, interactions, rejection_verification: verification, persistence, frameworks, google_consent_mode: { presence: observed.lifecycle === 'not_observed' ? 'not_present' : observed.classification === 'ambiguous' ? 'ambiguous' : 'present', defaults_observed: observed.commands.some((item) => item.command === 'default'), updates_observed: observed.commands.some((item) => item.command === 'update'), evidence: [observed.classification], reason_codes: observed.reason_codes }, storage_changes: [], network_signals: requests.slice(0, 100).map((item) => ({ host: item.host, path: item.path, method: item.method, phase: item.phase, signal: item.kind === 'script' ? 'script' : 'tracking' })), reason_codes: [...new Set([...(input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED]), ...reasonCodes])] }; }
