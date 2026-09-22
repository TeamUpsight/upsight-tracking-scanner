import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright-core';
import { browserGeoProfile, configureBrowserGeo } from '../browser-session';
import { isValidStorefrontStatus, type AccessDecision } from '../navigation';
import { captureSharedConsentObservation, prepareConsentV2Session } from './v2-session';
import { observeConsentFrameworksInPage } from './browser-context-builders';
import { normalizeConsentMeasurement } from './tracking-consistency';
import { consentV2RolloutControls, type ConsentV2RolloutControls } from './rollout-controls';
import type { USPrivacyObservation } from './domain-types';
import { buildBrowserlessGpcExperimentUrl } from '../proxy/decodo';

export type GpcProfile = 'off' | 'on';
export async function openBrowserlessGpcExperimentSession(
  canonicalCdpUrl: string, profile: GpcProfile,
  connect: (url: string) => Promise<Browser> = (url) => chromium.connectOverCDP(url, { timeout: 8_000 })
) {
  const url = buildBrowserlessGpcExperimentUrl(canonicalCdpUrl, profile);
  return { browser: await connect(url), configurationVerified: true };
}
export type GpcHeaderState = 'absent' | '1' | 'other' | 'unknown';
export type GpcOutcome = 'transport_invalid' | 'identity_unmatched' | 'access_inconclusive' | 'no_observable_change' |
  'observable_ui_change' | 'observable_privacy_state_change' | 'observable_measurement_change' | 'multiple_observable_changes' | 'inconclusive';
export type GpcStage = 'context' | 'egress' | 'transport_setup' | 'navigation' | 'observation' | 'transport_verification';
export interface GpcArmTiming {
  context_ms: number | null;
  egress_ms: number | null;
  transport_setup_ms: number | null;
  navigation_ms: number | null;
  observation_ms: number | null;
  transport_verification_ms: number | null;
  total_ms: number;
  failed_stage: GpcStage | null;
}
export interface GpcExperimentTiming {
  budget_ms: number;
  arm_budget_ms: number;
  total_ms: number;
  control: GpcArmTiming | null;
  treatment: GpcArmTiming | null;
}

export interface GpcTransportEvidence {
  requested_profile: GpcProfile;
  top_level_sec_gpc: GpcHeaderState;
  first_party_requests: { observed: number; absent: number; value_1: number; other: number };
  dom_global_privacy_control: true | false | null;
  valid: boolean;
}

export interface GpcObservation {
  transport: GpcTransportEvidence;
  identity: { same_browser_session: boolean; browser_configuration_verified: boolean; browser_version?: string; locale: string; timezone: string; viewport: '1280x800'; usa_egress_verified: boolean; egress_fingerprint?: string | null };
  access: { page_valid: boolean; canonical_host: string | null; category: AccessDecision['category']; geo_verified: boolean; observation_complete: boolean };
  cmp: { provider: string | null; provider_conflict: boolean; banner_visibility: string; actions: string[] } | null;
  us_privacy: { choices: USPrivacyObservation['choices']; gpc_acknowledgement_observed: boolean | null } | null;
  gpp: { lifecycle: string; section_list: number[]; applicable_sections: number[]; signal_status: string | null } | null;
  measurement: { state: string | boolean; retained: number; full: number; limited: number; unknown: number; truncated: boolean } | null;
}

export interface GpcExperimentEvidence {
  enabled: true;
  state: 'completed' | 'inconclusive';
  control: GpcObservation | null;
  treatment: GpcObservation | null;
  identity_matched: boolean;
  access_matched: boolean;
  differences: Array<'acknowledgement' | 'cmp' | 'us_privacy' | 'gpp' | 'measurement'>;
  outcome: GpcOutcome;
  reason_code: string | null;
  timings?: GpcExperimentTiming;
}

const headerState = (value: unknown): GpcHeaderState => value === undefined ? 'absent' : value === '1' ? '1' : 'other';
const emptyCounts = () => ({ observed: 0, absent: 0, value_1: 0, other: 0 });

/** The route changes wire intent; CDP records what Chromium actually sent. */
export async function installGpcProfile(context: BrowserContext, page: Page, profile: GpcProfile, targetHost: string, acceptLanguage?: string, nativeSessionOff = false) {
  await context.addInitScript((enabled: boolean) => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => enabled });
  }, profile === 'on');
  if (acceptLanguage || profile === 'on') await context.setExtraHTTPHeaders({
    ...(acceptLanguage ? { 'Accept-Language': acceptLanguage } : {}),
    ...(profile === 'on' ? { 'Sec-GPC': '1' } : {})
  });
  if (!(nativeSessionOff && profile === 'off')) await context.route('**/*', async (route) => {
    const headers = await route.request().allHeaders();
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'sec-gpc') delete headers[key];
    if (profile === 'on') headers['sec-gpc'] = '1';
    await route.continue({ headers });
  });
  const cdp = await context.newCDPSession(page);
  const urls = new Map<string, { firstParty: boolean; document: boolean }>();
  const earlyHeaders = new Map<string, Record<string, unknown>>();
  const states: GpcHeaderState[] = [];
  const counts = emptyCounts();
  const record = (requestId: string, headers: Record<string, unknown>) => {
    const match = urls.get(requestId);
    if (!match?.firstParty) return;
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'sec-gpc');
    const state = headerState(entry?.[1]);
    if (counts.observed < 50) {
      counts.observed++;
      if (state === 'absent') counts.absent++;
      else if (state === '1') counts.value_1++;
      else counts.other++;
    }
    if (match.document && states.length < 10) states.push(state);
  };
  cdp.on('Network.requestWillBeSent', (event) => {
    try {
      const host = new URL(event.request.url).hostname;
      urls.set(event.requestId, { firstParty: host === targetHost || host.endsWith('.' + targetHost), document: event.type === 'Document' });
      const early = earlyHeaders.get(event.requestId);
      if (early) { record(event.requestId, early); earlyHeaders.delete(event.requestId); }
    } catch { /* Unsupported URLs are not target requests. */ }
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
    if (urls.has(event.requestId)) record(event.requestId, event.headers as Record<string, unknown>);
    else if (earlyHeaders.size < 50) earlyHeaders.set(event.requestId, event.headers as Record<string, unknown>);
  });
  await cdp.send('Network.enable');
  return async (): Promise<GpcTransportEvidence> => {
    const dom = await page.evaluate(() => {
      const value = (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl;
      return value === true ? true : value === false ? false : null;
    }).catch(() => null);
    const top = states.length && states.every((state) => state === states[0]) ? states[0] : 'unknown';
    const expected = profile === 'on' ? '1' : 'absent';
    await cdp.detach().catch(() => {});
    return { requested_profile: profile, top_level_sec_gpc: top, first_party_requests: counts,
      dom_global_privacy_control: dom, valid: top === expected && dom === (profile === 'on') && counts.other === 0 &&
        (profile === 'on' ? counts.absent === 0 : counts.value_1 === 0) };
  };
}

export function compareGpcObservations(control: GpcObservation | null, treatment: GpcObservation | null): GpcExperimentEvidence {
  const result: GpcExperimentEvidence = { enabled: true, state: 'inconclusive', control, treatment, identity_matched: false,
    access_matched: false, differences: [], outcome: 'inconclusive', reason_code: 'OBSERVATION_INCOMPLETE' };
  if (!control || !treatment) return result;
  if (!control.transport.valid || !treatment.transport.valid) return { ...result, outcome: 'transport_invalid', reason_code: 'GPC_HTTP_DOM_MISMATCH' };
  const browserMatched = (control.identity.same_browser_session && treatment.identity.same_browser_session) ||
    (!control.identity.same_browser_session && !treatment.identity.same_browser_session &&
      Boolean(control.identity.browser_version && control.identity.browser_version === treatment.identity.browser_version));
  const identityMatched = browserMatched &&
    control.identity.browser_configuration_verified && treatment.identity.browser_configuration_verified &&
    control.identity.usa_egress_verified && treatment.identity.usa_egress_verified &&
    Boolean(control.identity.egress_fingerprint && control.identity.egress_fingerprint === treatment.identity.egress_fingerprint) &&
    control.identity.locale === treatment.identity.locale && control.identity.timezone === treatment.identity.timezone && control.identity.viewport === treatment.identity.viewport;
  result.identity_matched = identityMatched;
  if (!identityMatched) return { ...result, outcome: 'identity_unmatched', reason_code: 'EGRESS_OR_BROWSER_IDENTITY_UNMATCHED' };
  const accessMatched = control.access.page_valid && treatment.access.page_valid && control.access.geo_verified && treatment.access.geo_verified &&
    control.access.observation_complete && treatment.access.observation_complete && control.access.category === 'none' && treatment.access.category === 'none' &&
    Boolean(control.access.canonical_host && control.access.canonical_host === treatment.access.canonical_host);
  result.access_matched = accessMatched;
  if (!accessMatched) return { ...result, outcome: 'access_inconclusive', reason_code: 'ACCESS_NOT_COMPARABLE' };
  const changed = <T>(left: T, right: T) => JSON.stringify(left) !== JSON.stringify(right);
  if (changed(control.us_privacy?.gpc_acknowledgement_observed, treatment.us_privacy?.gpc_acknowledgement_observed)) result.differences.push('acknowledgement');
  if (changed(control.cmp, treatment.cmp)) result.differences.push('cmp');
  if (changed(control.us_privacy?.choices, treatment.us_privacy?.choices)) result.differences.push('us_privacy');
  if (changed(control.gpp, treatment.gpp)) result.differences.push('gpp');
  if (changed(control.measurement, treatment.measurement)) result.differences.push('measurement');
  const groups = [result.differences.includes('cmp'), result.differences.some((item) => ['acknowledgement', 'us_privacy', 'gpp'].includes(item)), result.differences.includes('measurement')].filter(Boolean).length;
  const outcome: GpcOutcome = groups > 1 ? 'multiple_observable_changes' : result.differences.includes('measurement') ? 'observable_measurement_change' :
    result.differences.some((item) => ['acknowledgement', 'us_privacy', 'gpp'].includes(item)) ? 'observable_privacy_state_change' :
      result.differences.includes('cmp') ? 'observable_ui_change' : 'no_observable_change';
  return { ...result, state: 'completed', outcome, reason_code: null };
}

export const GPC_ARM_MIN_BUDGET_MS = 24_000;
export const GPC_ARM_MAX_BUDGET_MS = 30_000;
export const GPC_FINALIZATION_MARGIN_MS = 2_000;

const STAGE_BUDGET_MS: Record<GpcStage, number> = {
  context: 12_000,
  egress: 6_000,
  transport_setup: 4_000,
  navigation: 7_000,
  observation: 10_000,
  transport_verification: 3_000
};

class GpcStageTimeout extends Error {
  constructor(readonly reasonCode: string) { super(reasonCode); }
}

function emptyArmTiming(): GpcArmTiming {
  return { context_ms: null, egress_ms: null, transport_setup_ms: null, navigation_ms: null,
    observation_ms: null, transport_verification_ms: null, total_ms: 0, failed_stage: null };
}

export async function runGpcExperiment(input: {
  browser: Browser;
  /** Separate Browserless processes for native, browser-level GPC control. */
  openBrowserSession?: (profile: GpcProfile) => Promise<{ browser: Browser; configurationVerified: boolean }>;
  url: string;
  targetHost: string;
  proxyCountry: string;
  controls?: ConsentV2RolloutControls;
  /** Ephemeral same-egress token: compared in memory, never persisted. */
  verifyEgress: (context: BrowserContext) => Promise<{ country: string | null; fingerprint: string | null }>;
  inspectAccess: (page: Page, response: Response | null) => Promise<AccessDecision>;
  navigationTimeoutMs?: number;
  budgetMs?: number;
  armBudgetMs?: number;
}): Promise<GpcExperimentEvidence> {
  const startedAt = Date.now();
  const armBudgetMs = Math.max(1, Math.floor(input.armBudgetMs ?? GPC_ARM_MAX_BUDGET_MS));
  const budgetMs = Math.max(1, Math.floor(input.budgetMs ?? armBudgetMs * 2));
  const totalDeadline = startedAt + budgetMs;
  const controls = input.controls || consentV2RolloutControls();
  const expected = browserGeoProfile(input.proxyCountry);
  const timings: GpcExperimentTiming = { budget_ms: budgetMs, arm_budget_ms: armBudgetMs, total_ms: 0, control: null, treatment: null };
  const observe = async (profile: GpcProfile): Promise<GpcObservation> => {
    const label = profile === 'off' ? 'CONTROL' : 'TREATMENT';
    const armStarted = Date.now();
    const armDeadline = armStarted + armBudgetMs;
    const timing = emptyArmTiming();
    timings[profile === 'off' ? 'control' : 'treatment'] = timing;
    let activeContext: BrowserContext | null = null;
    let activeBrowser: Browser | null = null;
    let sessionConfigurationVerified = true;
    let armExpired = false;
    let prepared: Awaited<ReturnType<typeof prepareConsentV2Session>> | null = null;
    const stage = async <T>(name: GpcStage, operation: () => Promise<T>): Promise<T> => {
      const stageStarted = Date.now();
      const remainingTotal = totalDeadline - stageStarted;
      const remainingArm = armDeadline - stageStarted;
      const limit = STAGE_BUDGET_MS[name];
      const totalLimited = remainingTotal <= remainingArm && remainingTotal <= limit;
      const reasonCode = totalLimited ? 'TOTAL_EXPERIMENT_BUDGET_EXCEEDED' : label + '_' + name.toUpperCase() + '_TIMEOUT';
      const allowance = Math.min(remainingTotal, remainingArm, limit);
      const key = (name + '_ms') as keyof Pick<GpcArmTiming, 'context_ms' | 'egress_ms' | 'transport_setup_ms' | 'navigation_ms' | 'observation_ms' | 'transport_verification_ms'>;
      if (allowance <= 0) {
        timing.failed_stage = name;
        timing[key] = 0;
        armExpired = true;
        throw new GpcStageTimeout(reasonCode);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new GpcStageTimeout(reasonCode)), allowance); })
        ]);
      } catch (error) {
        timing.failed_stage = name;
        const timeout = error instanceof GpcStageTimeout
          ? error
          : /Timeout|timed out/i.test(String((error as Error)?.message || error))
            ? new GpcStageTimeout(label + '_' + name.toUpperCase() + '_TIMEOUT')
            : null;
        if (timeout) {
          armExpired = true;
          if (activeContext) void activeContext.close().catch(() => {});
        }
        throw timeout || error;
      } finally {
        if (timer) clearTimeout(timer);
        timing[key] = Date.now() - stageStarted;
      }
    };
    try {
      const { context, page, geoApplied } = await stage('context', async () => {
        const opened = input.openBrowserSession ? await input.openBrowserSession(profile) : null;
        sessionConfigurationVerified = opened?.configurationVerified ?? true;
        const experimentBrowser = opened?.browser || input.browser;
        if (input.openBrowserSession) {
          activeBrowser = experimentBrowser;
          if (armExpired) { void experimentBrowser.close().catch(() => {}); throw new GpcStageTimeout(label + '_CONTEXT_TIMEOUT'); }
        }
        const opening = experimentBrowser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
        void opening.then((lateContext) => {
          if (armExpired) void lateContext.close().catch(() => {});
          else activeContext = lateContext;
        }).catch(() => {});
        const context = await opening;
        activeContext = context;
        const page = await context.newPage();
        const geoApplied = await configureBrowserGeo(context, page, input.proxyCountry);
        return { context, page, geoApplied };
      });
      const egress = await stage('egress', () => input.verifyEgress(context));
      const readTransport = await stage('transport_setup', async () => {
        const read = await installGpcProfile(context, page, profile, input.targetHost, expected.acceptLanguage, Boolean(input.openBrowserSession));
        prepared = await prepareConsentV2Session(page);
        return read;
      });
      const response = await stage('navigation', async () => {
        prepared.markNavigationStarted();
        const navigated = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.navigationTimeoutMs || 7_000 });
        prepared.markDOMContentLoaded();
        return navigated;
      });
      const observed = await stage('observation', async () => {
        const consent = await captureSharedConsentObservation(page, controls, false, 'USA');
        prepared.markInitialObservationCompleted();
        const framework = await observeConsentFrameworksInPage(page);
        const access = await input.inspectAccess(page, response);
        const host = new URL(page.url()).hostname.toLowerCase();
        const measurement = normalizeConsentMeasurement(prepared.requests, 'fresh', null, prepared.gcm.result(), prepared.request_buffer.truncated, prepared.request_buffer.observed);
        return { consent, framework, access, host, measurement };
      });
      const transport = await stage('transport_verification', readTransport);
      return {
          transport,
          identity: { same_browser_session: !input.openBrowserSession, browser_configuration_verified: geoApplied.localeApplied && geoApplied.timezoneApplied && sessionConfigurationVerified,
            ...(input.openBrowserSession ? { browser_version: activeBrowser!.version().match(/\d+(?:\.\d+){1,3}/)?.[0] } : {}),
            locale: expected.locale, timezone: expected.timezoneId, viewport: '1280x800', usa_egress_verified: egress.country === 'us', egress_fingerprint: egress.fingerprint },
          access: { page_valid: isValidStorefrontStatus(response?.status() ?? null) && observed.host === input.targetHost,
            canonical_host: observed.host, category: observed.access.category, geo_verified: egress.country === 'us', observation_complete: true },
          cmp: { provider: observed.consent.provider, provider_conflict: observed.consent.provider_conflict, banner_visibility: observed.consent.banner.visibility,
            actions: observed.consent.actions.filter((action) => action.availability === 'direct').map((action) => action.action).sort().slice(0, 10) },
          us_privacy: observed.consent.us_privacy ? { choices: observed.consent.us_privacy.choices.slice(0, 20), gpc_acknowledgement_observed: observed.consent.us_privacy.gpc.gpc_acknowledgement_observed } : null,
          gpp: { lifecycle: observed.framework.gpp.lifecycle, section_list: observed.framework.gpp.ping?.section_list || [], applicable_sections: observed.framework.gpp.ping?.applicable_sections || [], signal_status: observed.framework.gpp.ping?.signal_status || null },
          measurement: { state: observed.measurement.state, retained: observed.measurement.tracking_requests_retained, full: observed.measurement.full_measurement_count,
            limited: observed.measurement.limited_measurement_count, unknown: observed.measurement.unknown_measurement_count, truncated: observed.measurement.truncated }
      };
    } finally {
      prepared?.dispose();
      if (activeContext) {
        // Cleanup is best-effort and must not consume the canonical audit's
        // reserved finalization time if a remote CDP close stalls.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            activeContext.close().catch(() => {}),
            new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 500); })
          ]);
        } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      }
      if (activeBrowser) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            activeBrowser.close().catch(() => {}),
            new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 500); })
          ]);
        } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      }
      timing.total_ms = Date.now() - armStarted;
    }
  };
  let control: GpcObservation | null = null;
  let treatment: GpcObservation | null = null;
  const failures: string[] = [];
  try { control = await observe('off'); } catch (error) {
    failures.push(error instanceof GpcStageTimeout ? error.reasonCode : 'CONTROL_' + (timings.control?.failed_stage || 'OBSERVATION').toUpperCase() + '_FAILED');
  }
  if (Date.now() < totalDeadline) {
    try { treatment = await observe('on'); } catch (error) {
      failures.push(error instanceof GpcStageTimeout ? error.reasonCode : 'TREATMENT_' + (timings.treatment?.failed_stage || 'OBSERVATION').toUpperCase() + '_FAILED');
    }
  } else if (!treatment) {
    failures.push('TOTAL_EXPERIMENT_BUDGET_EXCEEDED');
  }
  const result = compareGpcObservations(control, treatment);
  timings.total_ms = Date.now() - startedAt;
  result.timings = timings;
  if (failures.length) result.reason_code = failures.find((reason) => reason !== 'TOTAL_EXPERIMENT_BUDGET_EXCEEDED') || failures[0];
  if (timings.total_ms > budgetMs && result.state === 'completed') {
    result.state = 'inconclusive';
    result.outcome = 'inconclusive';
    result.differences = [];
    result.reason_code = 'TOTAL_EXPERIMENT_BUDGET_EXCEEDED';
  }
  // Tokens only exist to compare identity in memory; debug evidence retains
  // the matched boolean, not an IP, hash, proxy identifier, or token.
  if (control) delete control.identity.egress_fingerprint;
  if (treatment) delete treatment.identity.egress_fingerprint;
  return result;
}
