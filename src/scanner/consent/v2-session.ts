import type { Page, Request } from 'playwright-core';
import type { EvidenceBundle, TrackingRequestEvidence } from '../../types';
import { consentTimingValues, type ConsentTimingValues } from '../../shared/config';
import { cmpAdapterRegistry, scoreProviderCandidates, type CmpAdapterProviderId, type ProviderEvidenceSignal } from './adapter-registry';
import './onetrust-adapter';
import './cookiebot-adapter';
import './usercentrics-adapter';
import './didomi-adapter';
import './cookieyes-adapter';
import './sourcepoint-adapter';
import { createActionPlan, executeActionPlan, type ActionPlan, type ConsentInteractionStrategy, type InteractionExecutionBridge } from './action-planner';
import { ConsentEvidenceLedger } from './evidence-ledger';
import { ConsentAuditCodes, type AvailableAction, type BannerState, type ConsentAuditCode, type ConsentDecision, type ConsentState, type FinalConsentAuditResult, type MechanismResult, type VerificationResult } from './domain-types';
import { GoogleConsentModeObserver } from './google-consent-mode-observer';
import { verifySameContextReloadPersistence, type PersistenceSnapshot } from './persistence-verification';
import { verifyRequestedConsentAction, type RejectVerificationSignal } from './reject-verification-engine';
import { checkTrackingConsistency, type TrackingConsistencyResult } from './tracking-consistency';
import { buildUnknownCmpFingerprint } from './unknown-cmp-fingerprint';
import { consentV2ActionsEnabledFor, consentV2RolloutControls, type ConsentV2RolloutControls, type ConsentV2RolloutProvider } from './rollout-controls';

type ProviderId = CmpAdapterProviderId | 'unknown';
type KnownAction = 'reject_all' | 'only_necessary';

interface SafePageSnapshot {
  globals: string[];
  assets: string[];
  cookie_names: string[];
  storage_keys: string[];
  roots: Record<string, boolean>;
  controls: Record<string, { visible: boolean; enabled: boolean }>;
  api_reject: Record<string, boolean>;
  sourcepoint_reject: boolean;
  semantic: { visible: boolean; reject: boolean; only_necessary: boolean; preferences: boolean };
  states: { cookiebot_declined: boolean | null; cookiebot_has_response: boolean | null; cookieyes_rejected: boolean | null; shopify_denied: boolean | null; onetrust_groups_present: boolean | null };
  frameworks: { tcf: boolean; gpp: boolean; usp: boolean };
  consent_commands: Array<{ command: 'default' | 'update'; state: Record<string, unknown> }>;
}

export interface ConsentV2SessionInput {
  geo: 'USA' | 'EU' | 'UK';
  geo_verified: boolean | null;
  page_valid: boolean | null;
  timings?: ConsentTimingValues;
  access_blocked?: boolean;
  rollout?: ConsentV2RolloutControls;
  rollout_key?: string;
}

export type ConsentV2Telemetry = NonNullable<EvidenceBundle['runtime']['consent_v2']>;

export interface ConsentV2SessionOutput {
  result: FinalConsentAuditResult;
  tracking: TrackingConsistencyResult;
  ledger: ConsentEvidenceLedger;
  telemetry: ConsentV2Telemetry;
}

const ROOTS: Record<Exclude<ProviderId, 'unknown'>, string[]> = {
  onetrust: ['#onetrust-banner-sdk', '#onetrust-consent-sdk', '#onetrust-pc-sdk', '.ot-sdk-container'],
  cookiebot: ['#CybotCookiebotDialog'],
  usercentrics: ['aside#usercentrics-cmp-ui'],
  didomi: ['#didomi-host', '#didomi-notice'],
  cookieyes: ['.cky-consent-container'],
  sourcepoint: ['[id^="sp_message_container_"]', '[id^="sp_message_iframe_"]']
};

const CONTROLS: Record<Exclude<ProviderId, 'unknown'>, string[]> = {
  onetrust: ['#onetrust-reject-all-handler'],
  cookiebot: ['#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'],
  usercentrics: [],
  didomi: [],
  cookieyes: ['.cky-btn-reject', '[data-cky-tag="reject-button"]'],
  sourcepoint: ['.sp_choice_type_13', '.sp_choice_type_REJECT_ALL']
};

function visible(value: Element | null) {
  if (!(value instanceof HTMLElement)) return false;
  const style = getComputedStyle(value);
  const box = value.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
}

function safePath(url: string) {
  try { return new URL(url).pathname || '/'; } catch { return '/'; }
}

function providerEvidence(snapshot: SafePageSnapshot): ProviderEvidenceSignal[] {
  const signals: ProviderEvidenceSignal[] = [];
  const add = (provider_id: CmpAdapterProviderId, family: ProviderEvidenceSignal['family'], kind: ProviderEvidenceSignal['kind']) =>
    signals.push({ provider_id, family, kind, specificity: 'provider_specific' });
  const hasGlobal = (name: string) => snapshot.globals.includes(name);
  const hasAsset = (pattern: RegExp) => snapshot.assets.some((asset) => pattern.test(asset));
  const hasCookie = (name: string) => snapshot.cookie_names.includes(name);
  if (hasGlobal('OneTrust') || hasGlobal('Optanon')) add('onetrust', 'typed_provider_api', 'typed_documented_provider_api');
  if (hasAsset(/cookielaw\.org|onetrust\.com|otsdkstub|optanon/i)) add('onetrust', 'provider_asset', 'unique_provider_script_or_config');
  if (ROOTS.onetrust.some((root) => snapshot.roots[root] !== undefined)) add('onetrust', 'provider_root', 'stable_provider_root');
  if (hasCookie('OptanonConsent') || hasCookie('OptanonAlertBoxClosed')) add('onetrust', 'provider_persistence', 'provider_persistence_key');
  if (hasGlobal('Cookiebot')) add('cookiebot', 'typed_provider_api', 'typed_documented_provider_api');
  if (hasAsset(/consent\.cookiebot\.com\/uc\.js/i)) add('cookiebot', 'provider_asset', 'unique_provider_script_or_config');
  if (snapshot.roots['#CybotCookiebotDialog'] !== undefined) add('cookiebot', 'provider_root', 'stable_provider_root');
  if (hasCookie('CookieConsent')) add('cookiebot', 'provider_persistence', 'provider_persistence_key');
  if (hasGlobal('UC_UI')) add('usercentrics', 'typed_provider_api', 'typed_documented_provider_api');
  if (hasAsset(/web\.cmp\.usercentrics\.eu\/ui\/loader\.js/i)) add('usercentrics', 'provider_asset', 'unique_provider_script_or_config');
  if (snapshot.roots['aside#usercentrics-cmp-ui'] !== undefined) add('usercentrics', 'provider_root', 'stable_provider_root');
  if (hasGlobal('Didomi')) add('didomi', 'typed_provider_api', 'typed_documented_provider_api');
  if (hasAsset(/didomi|privacy-center/i)) add('didomi', 'provider_asset', 'unique_provider_script_or_config');
  if (ROOTS.didomi.some((root) => snapshot.roots[root] !== undefined)) add('didomi', 'provider_root', 'stable_provider_root');
  if (hasCookie('didomi_token') || hasCookie('didomi_dcs')) add('didomi', 'provider_persistence', 'provider_persistence_key');
  if (hasGlobal('CookieYes')) add('cookieyes', 'typed_provider_api', 'typed_documented_provider_api');
  if (hasAsset(/cdn-cookieyes\.com\/client_data/i)) add('cookieyes', 'provider_asset', 'unique_provider_script_or_config');
  if (snapshot.roots['.cky-consent-container'] !== undefined) add('cookieyes', 'provider_root', 'stable_provider_root');
  if (hasCookie('cookieyes-consent')) add('cookieyes', 'provider_persistence', 'provider_persistence_key');
  if (hasGlobal('_sp_')) add('sourcepoint', 'typed_provider_api', 'typed_documented_provider_api');
  if (hasGlobal('_sp_queue') || hasAsset(/privacy-mgmt|sourcepoint/i)) add('sourcepoint', 'provider_asset', 'unique_provider_script_or_config');
  if (ROOTS.sourcepoint.some((root) => snapshot.roots[root] !== undefined)) add('sourcepoint', 'provider_root', 'stable_provider_root');
  return signals;
}

function decision(snapshot: SafePageSnapshot): ConsentDecision {
  if (snapshot.states.cookiebot_declined === true || snapshot.states.cookieyes_rejected === true || snapshot.states.shopify_denied === true) return 'rejected';
  if (snapshot.states.cookiebot_has_response === false) return 'unanswered';
  return 'ambiguous';
}

function storage(snapshot: SafePageSnapshot): PersistenceSnapshot['storage'] {
  return [...new Set([...snapshot.cookie_names.map((key_name) => ({ storage_type: 'cookie' as const, key_name })), ...snapshot.storage_keys.map((key_name) => ({ storage_type: 'local_storage' as const, key_name }))])]
    .filter((entry) => /consent|cookie|privacy|ucdata|ucstring|didomi/i.test(entry.key_name))
    .slice(0, 20)
    .map((entry) => ({ ...entry, domain: null, path: null, expiry_class: 'unknown' as const, secure: null, http_only: null, same_site: null, exists: true }));
}

function state(snapshot: SafePageSnapshot): ConsentState {
  const current = decision(snapshot);
  return { decision: current, categories: [], evidence: current === 'ambiguous' ? [] : ['runtime_semantic_state'], reason_codes: [] };
}

function frameworkState(snapshot: SafePageSnapshot) {
  const evidence: string[] = [];
  const reason_codes: ConsentAuditCode[] = [];
  if (snapshot.frameworks.tcf) { evidence.push('tcf_api'); reason_codes.push(ConsentAuditCodes.TCF_PRESENT); }
  if (snapshot.frameworks.gpp) { evidence.push('gpp_api'); reason_codes.push(ConsentAuditCodes.GPP_PRESENT); }
  if (snapshot.frameworks.usp) { evidence.push('usp_api'); reason_codes.push(ConsentAuditCodes.USP_PRESENT); }
  return { tcf: snapshot.frameworks.tcf ? 'present' as const : 'not_present' as const, gpp: snapshot.frameworks.gpp ? 'present' as const : 'not_present' as const, usp: snapshot.frameworks.usp ? 'present' as const : 'not_present' as const, evidence, reason_codes };
}

async function snapshot(page: Page): Promise<SafePageSnapshot> {
  const base = await page.evaluate(({ roots, controls }) => {
    const asVisible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const actionable = (selector: string) => { const element = document.querySelector(selector) as HTMLButtonElement | null; return { visible: asVisible(element), enabled: Boolean(element && !element.disabled) }; };
    const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const controlsInConsentSurface = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i]'));
    const semanticAction = (terms: string[]) => controlsInConsentSurface.some((surface) => Array.from(surface.querySelectorAll('button, [role="button"], a')).some((control) => {
      const text = normalize(control.getAttribute('aria-label') || control.textContent || '');
      return asVisible(control) && terms.includes(text);
    }));
    const w = window as any;
    const cb = w.Cookiebot;
    let cookieYesRejected: boolean | null = null;
    try { const value = typeof w.getCkyConsent === 'function' ? w.getCkyConsent() : null; const categories = value?.categories || value; const optional = ['analytics', 'advertisement', 'performance']; const values = optional.map((key) => categories?.[key]).filter((value) => typeof value === 'boolean'); if (values.length) cookieYesRejected = values.every((value) => value === false); } catch {}
    let shopifyDenied: boolean | null = null;
    try { const value = w.Shopify?.customerPrivacy?.currentVisitorConsent?.(); const optional = ['analytics', 'marketing', 'preferences', 'sale_of_data']; const values = optional.map((key) => value?.[key]).filter((item) => item === 'yes' || item === 'no'); if (values.length) shopifyDenied = values.every((item) => item === 'no'); } catch {}
    const commands: Array<{ command: 'default' | 'update'; state: Record<string, unknown> }> = [];
    for (const entry of Array.isArray(w.dataLayer) ? w.dataLayer.slice(-100) : []) {
      if (Array.isArray(entry) && entry[0] === 'consent' && (entry[1] === 'default' || entry[1] === 'update') && entry[2] && typeof entry[2] === 'object') commands.push({ command: entry[1], state: entry[2] });
    }
    return {
      globals: ['OneTrust', 'Optanon', 'Cookiebot', 'UC_UI', 'Didomi', 'CookieYes', '_sp_', '_sp_queue'].filter((name) => Boolean(w[name])),
      assets: Array.from(document.scripts).map((script) => script.src).filter(Boolean).slice(0, 200),
      cookie_names: document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean).slice(0, 100),
      storage_keys: Object.keys(localStorage).slice(0, 100),
      roots: Object.fromEntries(roots.flatMap((root) => { const element = document.querySelector(root); return element ? [[root, asVisible(element)]] : []; })),
      controls: Object.fromEntries(controls.flatMap((selector) => { const element = document.querySelector(selector); return element ? [[selector, actionable(selector)]] : []; })),
      api_reject: { onetrust: typeof w.OneTrust?.RejectAll === 'function', didomi: typeof w.Didomi?.setUserDisagreeToAll === 'function', cookieyes: typeof w.performBannerAction === 'function' },
      sourcepoint_reject: false,
      semantic: { visible: controlsInConsentSurface.some(asVisible), reject: semanticAction(['reject all', 'decline all', 'deny all']), only_necessary: semanticAction(['only necessary', 'necessary only', 'use necessary only']), preferences: semanticAction(['preferences', 'manage preferences', 'cookie settings', 'customize']) },
      states: { cookiebot_declined: typeof cb?.declined === 'boolean' ? cb.declined : null, cookiebot_has_response: typeof cb?.hasResponse === 'boolean' ? cb.hasResponse : null, cookieyes_rejected: cookieYesRejected, shopify_denied: shopifyDenied, onetrust_groups_present: typeof w.OnetrustActiveGroups === 'string' ? Boolean(w.OnetrustActiveGroups) : null },
      frameworks: { tcf: typeof w.__tcfapi === 'function', gpp: typeof w.__gpp === 'function', usp: typeof w.__uspapi === 'function' }, consent_commands: commands
    };
  }, { roots: Object.values(ROOTS).flat(), controls: Object.values(CONTROLS).flat() });
  let sourcepointReject = false;
  for (const frame of page.frames()) {
    if (await frame.locator('.sp_choice_type_13, .sp_choice_type_REJECT_ALL').first().isVisible().catch(() => false)) { sourcepointReject = true; break; }
  }
  const ucControls = page.locator('aside#usercentrics-cmp-ui').locator('button, [role="button"]');
  const ucCount = Math.min(await ucControls.count().catch(() => 0), 40);
  let ucReject = false;
  for (let index = 0; index < ucCount; index += 1) {
    const control = ucControls.nth(index);
    if (await control.evaluate((element) => {
      const text = (element.getAttribute('aria-label') || element.textContent || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
      return text === 'reject all' || text === 'decline all' || text === 'deny all';
    }).catch(() => false)) { ucReject = true; break; }
  }
  return { ...base, sourcepoint_reject: sourcepointReject, semantic: { ...base.semantic, reject: base.semantic.reject || ucReject } };
}

async function selectedProvider(snapshot: SafePageSnapshot, controls: ConsentV2RolloutControls) {
  const evidence = providerEvidence(snapshot);
  const candidates = scoreProviderCandidates(evidence);
  for (const candidate of candidates.filter((item) => item.high_confidence)) {
    const provider = candidate.provider_id as CmpAdapterProviderId;
    if (!controls.providers[provider].detection_enabled) continue;
    const detection = await cmpAdapterRegistry.get(provider)?.detect({ evidence });
    if (detection?.status === 'detected') return provider;
  }
  return undefined;
}

function rolloutProvider(provider: CmpAdapterProviderId | undefined): ConsentV2RolloutProvider {
  return provider || 'generic';
}

function telemetryFor(
  result: FinalConsentAuditResult,
  tracking: TrackingConsistencyResult,
  snapshot: SafePageSnapshot,
  controls: ConsentV2RolloutControls,
  provider: CmpAdapterProviderId | undefined,
  providerConflict: boolean,
  blocked: boolean,
  actionsEnabled: boolean
): ConsentV2Telemetry {
  const knownProvider = result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates.find((candidate) => candidate.attribution === 'identified');
  const reject = result.available_actions.find((action) => action.action === 'reject_all');
  const interaction = result.interactions.find((item) => item.action === 'reject_all' || item.action === 'only_necessary');
  const generic = result.mechanisms.some((item) => item.mechanism === 'custom' && item.provider?.attribution === 'unknown_candidate');
  const fingerprint = generic ? buildUnknownCmpFingerprint({
    mechanism_score: 70,
    provider_attribution: 'unknown_candidate',
    geo: null,
    script_hosts: snapshot.assets,
    storage_key_names: [...snapshot.cookie_names, ...snapshot.storage_keys],
    candidate_global_names: snapshot.globals,
    available_actions: result.available_actions,
    tcf: { presence: snapshot.frameworks.tcf ? 'present' : 'absent' },
    gpp: { presence: snapshot.frameworks.gpp ? 'ready' : 'absent' },
    failure_reason_codes: result.reason_codes
  })?.fingerprint || null : null;
  return {
    enabled: controls.enabled,
    observation_only: !actionsEnabled,
    provider: knownProvider?.provider_name || null,
    provider_confidence: knownProvider?.confidence || null,
    provider_conflict: providerConflict,
    banner_visibility: result.banner.visibility,
    reject_availability: reject?.availability || 'unknown',
    interaction_outcome: interaction?.outcome || 'not_attempted',
    verification: result.rejection_verification.status,
    persistence: result.persistence.status,
    generic_fallback: generic,
    selector_or_action_failure: Boolean(interaction && interaction.outcome !== 'executed') || result.rejection_verification.reason_codes.includes(ConsentAuditCodes.ACTION_NOT_EXPOSED),
    tcf_present: snapshot.frameworks.tcf,
    gpp_present: snapshot.frameworks.gpp,
    consent_mode_classification: result.google_consent_mode.evidence[0] || 'unknown',
    tracking_consistency: tracking.status,
    unknown_cmp_fingerprint: fingerprint,
    geo_unverified: result.geo_verified.status !== 'verified',
    blocked_or_challenged: blocked
  };
}

function mechanism(snapshot: SafePageSnapshot, provider: CmpAdapterProviderId | undefined, blocked: boolean): MechanismResult[] {
  if (blocked) return [];
  if (provider) return [{ mechanism: 'cmp', detection: { status: 'verified', evidence: ['provider_specific_evidence'], reason_codes: [ConsentAuditCodes.CMP_DETECTED] }, provider: { attribution: 'identified', confidence: 'high', candidates: [{ provider_name: provider, attribution: 'identified', confidence: 'high', evidence: ['independent_provider_families'], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }, adapter_maturity: cmpAdapterRegistry.getCapability(provider, 'detection').maturity }];
  if (snapshot.semantic.visible && (snapshot.semantic.reject || snapshot.semantic.only_necessary || snapshot.semantic.preferences)) return [{ mechanism: 'custom', detection: { status: 'verified', evidence: ['visible_consent_surface', 'semantic_action'], reason_codes: [ConsentAuditCodes.CMP_DETECTED] }, provider: { attribution: 'unknown_candidate', confidence: 'medium', candidates: [{ provider_name: 'unknown', attribution: 'unknown_candidate', confidence: 'medium', evidence: ['generic_surface'], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN] }], reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN] }, adapter_maturity: 'unvalidated' }];
  return [];
}

function banner(snapshot: SafePageSnapshot, provider: CmpAdapterProviderId | undefined): BannerState {
  const roots = provider ? ROOTS[provider] : [];
  const isVisible = provider ? roots.some((root) => snapshot.roots[root]) : snapshot.semantic.visible;
  return { surface: isVisible ? 'banner' : 'none', visibility: isVisible ? 'visible' : 'not_visible', evidence: isVisible ? ['rendered_consent_surface'] : [], reason_codes: [isVisible ? ConsentAuditCodes.BANNER_VISIBLE : ConsentAuditCodes.BANNER_NOT_VISIBLE] };
}

function actions(snapshot: SafePageSnapshot, provider: CmpAdapterProviderId | undefined): AvailableAction[] {
  const uiDirect = provider === 'sourcepoint'
    ? snapshot.sourcepoint_reject
    : provider ? CONTROLS[provider].some((selector) => snapshot.controls[selector]?.visible && snapshot.controls[selector]?.enabled) || (provider === 'usercentrics' && snapshot.semantic.reject) : snapshot.semantic.reject;
  const apiOnly = Boolean(provider && snapshot.api_reject[provider]);
  const direct = uiDirect || apiOnly;
  const necessary = !direct && snapshot.semantic.only_necessary;
  return [
    { action: 'reject_all', availability: uiDirect ? 'direct' : apiOnly ? 'api_only' : snapshot.semantic.preferences ? 'preferences_only' : 'not_present', category: null, evidence: uiDirect ? ['explicit_reject_control'] : apiOnly ? ['documented_provider_api'] : [], reason_codes: [uiDirect || apiOnly ? ConsentAuditCodes.REJECT_AVAILABLE : snapshot.semantic.preferences ? ConsentAuditCodes.REJECT_PREFERENCES_ONLY : ConsentAuditCodes.REJECT_NOT_AVAILABLE] },
    { action: 'only_necessary', availability: necessary ? 'direct' : 'not_present', category: null, evidence: necessary ? ['explicit_necessary_control'] : [], reason_codes: [] },
    { action: 'open_preferences', availability: snapshot.semantic.preferences ? 'direct' : 'not_present', category: null, evidence: [], reason_codes: snapshot.semantic.preferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : [] }
  ];
}

function selectorFor(provider: CmpAdapterProviderId | undefined, action: KnownAction) {
  if (!provider) return null;
  if (action === 'reject_all') return CONTROLS[provider][0] || null;
  return null;
}

async function semanticLocator(page: Page, action: KnownAction) {
  const names = action === 'only_necessary' ? ['only necessary', 'necessary only', 'use necessary only'] : ['reject all', 'decline all', 'deny all'];
  const candidates = page.locator('[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i]').locator('button, [role="button"], a');
  const count = Math.min(await candidates.count(), 80);
  for (let index = 0; index < count; index += 1) {
    const locator = candidates.nth(index);
    const match = await locator.evaluate((element, values) => {
      const text = (element.getAttribute('aria-label') || element.textContent || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
      return values.includes(text);
    }, names).catch(() => false);
    if (match) return locator;
  }
  return null;
}

async function activate(page: Page, provider: CmpAdapterProviderId | undefined, action: KnownAction, strategy: ConsentInteractionStrategy) {
  if (strategy === 'documented_provider_api') {
    if (provider === 'onetrust') return page.evaluate(() => { const api = (window as any).OneTrust; if (typeof api?.RejectAll !== 'function') return false; api.RejectAll(); return true; }).catch(() => false);
    if (provider === 'didomi') return page.evaluate(() => { const api = (window as any).Didomi; if (typeof api?.setUserDisagreeToAll !== 'function') return false; api.setUserDisagreeToAll(); return true; }).catch(() => false);
    if (provider === 'cookieyes') return page.evaluate(() => { const api = (window as any).performBannerAction; if (typeof api !== 'function') return false; api('reject'); return true; }).catch(() => false);
    return false;
  }
  if (provider === 'sourcepoint') {
    for (const frame of page.frames()) { const target = frame.locator('.sp_choice_type_13, .sp_choice_type_REJECT_ALL').first(); if (await target.isVisible().catch(() => false)) { await target.click(); return true; } }
    return false;
  }
  if (provider === 'usercentrics') {
    const names = action === 'only_necessary' ? ['only necessary', 'necessary only', 'use necessary only'] : ['reject all', 'decline all', 'deny all'];
    const controls = page.locator('aside#usercentrics-cmp-ui').locator('button, [role="button"]');
    const count = Math.min(await controls.count().catch(() => 0), 40);
    for (let index = 0; index < count; index += 1) {
      const target = controls.nth(index);
      if (await target.evaluate((element, values) => {
        const text = (element.getAttribute('aria-label') || element.textContent || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
        return values.includes(text);
      }, names).catch(() => false)) { await target.click(); return true; }
    }
    return false;
  }
  const selector = selectorFor(provider, action);
  const target = selector ? page.locator(selector).first() : await semanticLocator(page, action);
  if (!target || !await target.isVisible().catch(() => false) || !await target.isEnabled().catch(() => false)) return false;
  await target.click(); return true;
}

/** Production-only bridge: no raw page HTML, storage values, consent strings, or query strings leave the browser. */
export async function runConsentV2Session(page: Page, input: ConsentV2SessionInput): Promise<ConsentV2SessionOutput> {
  const timings = input.timings || consentTimingValues();
  const rollout = input.rollout || consentV2RolloutControls();
  const ledger = new ConsentEvidenceLedger();
  const trackingRequests: TrackingRequestEvidence[] = [];
  const gcm = new GoogleConsentModeObserver();
  const requestListener = (request: Request) => {
    const url = request.url(); let parsed: URL; try { parsed = new URL(url); } catch { return; }
    gcm.observeMeasurementRequest({ url, timestamp: Date.now() });
    if (trackingRequests.length < 100) trackingRequests.push({ vendor: /facebook\.com|connect\.facebook/i.test(parsed.hostname) ? 'meta' : /google-analytics\.com/i.test(parsed.hostname) ? 'ga4' : /googleadservices|doubleclick/i.test(parsed.hostname) ? 'google_ads' : 'unknown', kind: request.resourceType() === 'script' ? 'script' : 'collection', collector: 'third_party', host: parsed.hostname, path: safePath(url), method: request.method(), phase: 'consent_v2', timestamp: Date.now(), event: parsed.searchParams.get('en') || parsed.searchParams.get('ev') || undefined });
  };
  page.on('request', requestListener);
  try {
    ledger.append({ phase: 'baseline', source: 'page', family: 'semantic', kind: 'presence', specificity: 'generic', stability: 'stable', provenance: 'browser_api', descriptor: { exists: true } });
    const before = await snapshot(page);
    before.consent_commands.forEach((command) => gcm.observeGtagCall('consent', command.command, command.state));
    const candidates = scoreProviderCandidates(providerEvidence(before));
    const provider = rollout.enabled ? await selectedProvider(before, rollout) : undefined;
    const detectionSuppressed = !rollout.enabled || candidates.some((candidate) => candidate.high_confidence && !rollout.providers[candidate.provider_id as CmpAdapterProviderId].detection_enabled) || (!rollout.providers.generic.detection_enabled && !provider && before.semantic.visible);
    const mechanisms = !provider && !rollout.providers.generic.detection_enabled ? [] : mechanism(before, provider, Boolean(input.access_blocked));
    const initialState = state(before);
    const initialBanner = banner(before, provider);
    const available = actions(before, provider);
    ledger.append({ phase: 'detected', source: 'runtime', family: 'global', kind: 'global_name', specificity: provider ? 'provider_specific' : 'generic', stability: 'stable', provenance: 'browser_api', provider_candidate: provider || null, descriptor: { exists: Boolean(provider) } });
    if (!rollout.enabled || input.access_blocked) {
      const result = emptyResult(input, before, [], initialBanner, available, initialState, [ConsentAuditCodes.BLOCKED_OR_CHALLENGED]);
      if (!rollout.enabled) result.reason_codes = [ConsentAuditCodes.DETECTION_INCONCLUSIVE];
      const tracking = checkTrackingConsistency({ rejection_verification: result.rejection_verification, reject_timestamp: null, post_reject_observation_completed: false, requests: trackingRequests });
      return { result, tracking, ledger, telemetry: telemetryFor(result, tracking, before, rollout, provider, candidates.filter((item) => item.high_confidence).length > 1, Boolean(input.access_blocked), false) };
    }
    const action: KnownAction | null = available.some((entry) => entry.action === 'reject_all' && (entry.availability === 'direct' || entry.availability === 'api_only'))
      ? 'reject_all'
      : available.some((entry) => entry.action === 'only_necessary' && entry.availability === 'direct')
        ? 'only_necessary'
        : null;
    let attempt: FinalConsentAuditResult['interactions'][number] | null = null;
    let verification: VerificationResult = { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] };
    let after = before;
    let actionTimestamp: number | null = null;
    const actionEnabled = consentV2ActionsEnabledFor(rollout, rolloutProvider(provider), input.rollout_key || page.url());
    if (action && actionEnabled) {
      const selector = selectorFor(provider, action);
      const strategies: ConsentInteractionStrategy[] = provider && ['onetrust', 'didomi', 'cookieyes'].includes(provider) ? ['documented_provider_api', 'provider_selector', 'semantic_accessibility'] : ['provider_selector', 'semantic_accessibility'];
      const plan = createActionPlan({ action, provider_or_mechanism: provider || 'custom', target: { surface_type: 'banner', target_ref: selector || 'semantic', accessible_control: true, frame_path: ['top'], shadow_mode: 'unknown' }, eligible_strategies: strategies, timeout_ms: timings.postActionSettleMs, stabilization_ms: timings.postActionSettleMs, provider_api_reject_available: strategies.includes('documented_provider_api'), user_facing_reject_available: Boolean(selector || before.semantic.reject || before.semantic.only_necessary) });
      const bridge: InteractionExecutionBridge = {
        async inspectTarget(_plan: ActionPlan) { const active = (await snapshot(page)); return { attached: true, visible: banner(active, provider).visibility === 'visible', enabled: true, surface_active: banner(active, provider).visibility === 'visible', frame_path: ['top'], shadow_mode: 'unknown', navigation_state: page.isClosed() ? 'interrupted' : 'idle' }; },
        async executeStrategy(_plan, strategy) { try { return await activate(page, provider, action, strategy) ? 'executed' : 'not_executed'; } catch { return 'unsupported'; } },
        appendEvidence(event) { ledger.append({ phase: 'pre_action', source: 'provider_adapter', family: 'semantic', kind: event.kind === 'state_transition' ? 'state_change' : 'semantic_control', specificity: provider ? 'provider_specific' : 'generic', stability: 'stable', provenance: 'adapter', provider_candidate: provider || null, descriptor: { exists: true } }); },
        async waitForStabilization() { await page.waitForTimeout(timings.postActionSettleMs); return { state_changed: decision(await snapshot(page)) !== initialState.decision, navigation_interrupted: page.isClosed() }; }
      };
      const execution = await executeActionPlan(plan, bridge); attempt = execution.attempt; actionTimestamp = Date.now(); gcm.markUserChoice(actionTimestamp); after = await snapshot(page);
      const signals: RejectVerificationSignal[] = [];
      if (after.states.cookiebot_declined === true) signals.push({ family: 'provider_state', rank: 'strong', relation: 'matches_requested', authoritative: true, observed_at: actionTimestamp });
      if (after.states.cookieyes_rejected === true) signals.push({ family: 'provider_category_state', rank: 'strong', relation: 'matches_requested', authoritative: true, observed_at: actionTimestamp });
      if (after.states.cookiebot_declined === false && before.states.cookiebot_declined === true) signals.push({ family: 'provider_state', rank: 'strong', relation: 'contradicts_requested', authoritative: true, observed_at: actionTimestamp });
      if (storage(after).length) signals.push({ family: 'storage', rank: 'supporting', relation: 'matches_requested', observed_at: actionTimestamp });
      if (execution.attempt.outcome === 'executed') signals.push({ family: 'interaction', rank: 'weak', relation: 'matches_requested', observed_at: actionTimestamp });
      verification = verifyRequestedConsentAction({ requested_action: action, action_timestamp: actionTimestamp, signals, navigation_interrupted: execution.attempt.outcome === 'aborted' });
      ledger.append({ phase: 'post_action', source: 'runtime', family: 'semantic', kind: 'state_change', specificity: provider ? 'provider_specific' : 'generic', stability: 'stable', provenance: 'browser_api', provider_candidate: provider || null, descriptor: { exists: decision(after) === 'rejected' } });
    }
    const afterState = state(after);
    const persistence = await verifySameContextReloadPersistence({ meaningful_action_attempt: Boolean(attempt && attempt.outcome === 'executed'), semantic_verification: verification, after_action: { semantic_state: { provider: afterState.decision }, storage: storage(after) }, settle_timeout_ms: timings.reloadSettleMs }, {
      async reloadSameContext() { const beforeUrl = page.url(); try { await page.reload({ waitUntil: 'commit' }); return { reloaded: true, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: false }; } catch { return { reloaded: false, same_context: true, origin_before: beforeUrl, origin_after: page.url(), navigation_interrupted: true }; } },
      async waitForSettle(timeoutMs) { try { await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }); await page.waitForTimeout(Math.min(timeoutMs, timings.reloadSettleMs)); return 'settled'; } catch { return 'timeout'; } },
      async readPostReloadSnapshot() { const reloaded = await snapshot(page); ledger.append({ phase: 'post_reload', source: 'page', family: 'storage', kind: 'storage_key', specificity: provider ? 'provider_specific' : 'generic', stability: 'tenant_variant', provenance: 'browser_api', provider_candidate: provider || null, descriptor: { exists: storage(reloaded).length > 0 } }); return { semantic_state: { provider: decision(reloaded) }, storage: storage(reloaded) }; }
    });
    const gcmResult = gcm.result();
    const result: FinalConsentAuditResult = { context_clean: { status: 'verified', evidence: ['fresh_playwright_context'], reason_codes: [] }, geo_verified: { status: input.geo_verified === true ? 'verified' : 'inconclusive', evidence: [], reason_codes: input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED] }, mechanisms, banner: initialBanner, available_actions: available, initial_state: initialState, resulting_state: afterState, interactions: attempt ? [attempt] : [], rejection_verification: verification, persistence, frameworks: frameworkState(before), google_consent_mode: { presence: gcmResult.lifecycle === 'not_observed' ? 'not_present' : gcmResult.classification === 'ambiguous' ? 'ambiguous' : 'present', defaults_observed: gcmResult.commands.some((entry) => entry.command === 'default'), updates_observed: gcmResult.commands.some((entry) => entry.command === 'update'), evidence: [gcmResult.classification], reason_codes: gcmResult.reason_codes }, storage_changes: [], network_signals: trackingRequests.slice(0, 100).map((request) => ({ host: request.host, path: request.path, method: request.method, phase: request.phase, signal: request.kind === 'script' ? 'script' : 'tracking' })), reason_codes: [...new Set([...(input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED]), ...(detectionSuppressed ? [ConsentAuditCodes.DETECTION_INCONCLUSIVE] : mechanisms.length ? [] : [ConsentAuditCodes.NO_CMP_DETECTED]), ...verification.reason_codes, ...persistence.reason_codes])]
    };
    const tracking = checkTrackingConsistency({ rejection_verification: verification, reject_timestamp: actionTimestamp, post_reject_observation_completed: persistence.status !== 'not_applicable', requests: trackingRequests });
    return { result, tracking, ledger, telemetry: telemetryFor(result, tracking, before, rollout, provider, candidates.filter((item) => item.high_confidence).length > 1, false, actionEnabled) };
  } finally { page.off('request', requestListener); }
}

function emptyResult(input: ConsentV2SessionInput, snapshot: SafePageSnapshot, mechanisms: MechanismResult[], bannerState: BannerState, available: AvailableAction[], initial: ConsentState, reasonCodes: ConsentAuditCode[]): FinalConsentAuditResult {
  return { context_clean: { status: 'verified', evidence: ['fresh_playwright_context'], reason_codes: [] }, geo_verified: { status: input.geo_verified === true ? 'verified' : 'inconclusive', evidence: [], reason_codes: input.geo_verified === true ? [] : [ConsentAuditCodes.GEO_UNVERIFIED] }, mechanisms, banner: bannerState, available_actions: available, initial_state: initial, resulting_state: null, interactions: [], rejection_verification: { status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] }, persistence: { status: 'not_applicable', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] }, frameworks: frameworkState(snapshot), google_consent_mode: { presence: 'unknown', defaults_observed: null, updates_observed: null, evidence: [], reason_codes: [] }, storage_changes: [], network_signals: [], reason_codes: reasonCodes };
}
