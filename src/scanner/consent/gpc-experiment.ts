import type { Browser, BrowserContext, Page, Response } from 'playwright-core';
import { browserGeoProfile, configureBrowserGeo } from '../browser-session';
import { isValidStorefrontStatus, type AccessDecision } from '../navigation';
import { captureSharedConsentObservation, prepareConsentV2Session } from './v2-session';
import { observeConsentFrameworksInPage } from './browser-context-builders';
import { normalizeConsentMeasurement } from './tracking-consistency';
import { consentV2RolloutControls, type ConsentV2RolloutControls } from './rollout-controls';
import type { USPrivacyObservation } from './domain-types';

export type GpcProfile = 'off' | 'on';
export type GpcHeaderState = 'absent' | '1' | 'other' | 'unknown';
export type GpcOutcome = 'transport_invalid' | 'identity_unmatched' | 'access_inconclusive' | 'no_observable_change' |
  'observable_ui_change' | 'observable_privacy_state_change' | 'observable_measurement_change' | 'multiple_observable_changes' | 'inconclusive';

export interface GpcTransportEvidence {
  requested_profile: GpcProfile;
  top_level_sec_gpc: GpcHeaderState;
  first_party_requests: { observed: number; absent: number; value_1: number; other: number };
  dom_global_privacy_control: true | false | null;
  valid: boolean;
}

export interface GpcObservation {
  transport: GpcTransportEvidence;
  identity: { same_browser_session: boolean; browser_configuration_verified: boolean; locale: string; timezone: string; viewport: '1280x800'; usa_egress_verified: boolean; egress_fingerprint?: string | null };
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
}

const headerState = (value: unknown): GpcHeaderState => value === undefined ? 'absent' : value === '1' ? '1' : 'other';
const emptyCounts = () => ({ observed: 0, absent: 0, value_1: 0, other: 0 });

/** The route changes wire intent; CDP records what Chromium actually sent. */
export async function installGpcProfile(context: BrowserContext, page: Page, profile: GpcProfile, targetHost: string, acceptLanguage?: string) {
  await context.addInitScript((enabled: boolean) => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: () => enabled });
  }, profile === 'on');
  if (acceptLanguage || profile === 'on') await context.setExtraHTTPHeaders({
    ...(acceptLanguage ? { 'Accept-Language': acceptLanguage } : {}),
    ...(profile === 'on' ? { 'Sec-GPC': '1' } : {})
  });
  await context.route('**/*', async (route) => {
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
  const identityMatched = control.identity.same_browser_session && treatment.identity.same_browser_session &&
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

export async function runGpcExperiment(input: {
  browser: Browser;
  url: string;
  targetHost: string;
  proxyCountry: string;
  controls?: ConsentV2RolloutControls;
  /** Ephemeral same-egress token: compared in memory, never persisted. */
  verifyEgress: (context: BrowserContext) => Promise<{ country: string | null; fingerprint: string | null }>;
  inspectAccess: (page: Page, response: Response | null) => Promise<AccessDecision>;
  navigationTimeoutMs?: number;
  budgetMs?: number;
}): Promise<GpcExperimentEvidence> {
  const controls = input.controls || consentV2RolloutControls();
  const expected = browserGeoProfile(input.proxyCountry);
  let activeContext: BrowserContext | null = null;
  let timedOut = false;
  let rejectBudget!: (error: Error) => void;
  const budgetExpired = new Promise<never>((_, reject) => { rejectBudget = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    rejectBudget(new Error('EXPERIMENT_BUDGET_EXCEEDED'));
    if (activeContext) void activeContext.close().catch(() => {});
  }, input.budgetMs || 20_000);
  const observe = async (profile: GpcProfile): Promise<GpcObservation> => {
    const opening = input.browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    void opening.then((lateContext) => { if (timedOut) void lateContext.close().catch(() => {}); }).catch(() => {});
    const context = await Promise.race([opening, budgetExpired]);
    activeContext = context;
    try {
      const page = await context.newPage();
      const geoApplied = await configureBrowserGeo(context, page, input.proxyCountry);
      const egress = await input.verifyEgress(context);
      const readTransport = await installGpcProfile(context, page, profile, input.targetHost, expected.acceptLanguage);
      const prepared = await prepareConsentV2Session(page);
      try {
        prepared.markNavigationStarted();
        const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.navigationTimeoutMs || 7_000 });
        prepared.markDOMContentLoaded();
        const consent = await captureSharedConsentObservation(page, controls, false, 'USA');
        prepared.markInitialObservationCompleted();
        const framework = await observeConsentFrameworksInPage(page);
        const transport = await readTransport();
        const access = await input.inspectAccess(page, response);
        const host = new URL(page.url()).hostname.toLowerCase();
        const measurement = normalizeConsentMeasurement(prepared.requests, 'fresh', null, prepared.gcm.result(), prepared.request_buffer.truncated, prepared.request_buffer.observed);
        return {
          transport,
          identity: { same_browser_session: true, browser_configuration_verified: geoApplied.localeApplied && geoApplied.timezoneApplied,
            locale: expected.locale, timezone: expected.timezoneId, viewport: '1280x800', usa_egress_verified: egress.country === 'us', egress_fingerprint: egress.fingerprint },
          access: { page_valid: isValidStorefrontStatus(response?.status() ?? null) && host === input.targetHost,
            canonical_host: host, category: access.category, geo_verified: egress.country === 'us', observation_complete: true },
          cmp: { provider: consent.provider, provider_conflict: consent.provider_conflict, banner_visibility: consent.banner.visibility,
            actions: consent.actions.filter((action) => action.availability === 'direct').map((action) => action.action).sort().slice(0, 10) },
          us_privacy: consent.us_privacy ? { choices: consent.us_privacy.choices.slice(0, 20), gpc_acknowledgement_observed: consent.us_privacy.gpc.gpc_acknowledgement_observed } : null,
          gpp: { lifecycle: framework.gpp.lifecycle, section_list: framework.gpp.ping?.section_list || [], applicable_sections: framework.gpp.ping?.applicable_sections || [], signal_status: framework.gpp.ping?.signal_status || null },
          measurement: { state: measurement.state, retained: measurement.tracking_requests_retained, full: measurement.full_measurement_count,
            limited: measurement.limited_measurement_count, unknown: measurement.unknown_measurement_count, truncated: measurement.truncated }
        };
      } finally { prepared.dispose(); }
    } finally {
      await context.close().catch(() => {});
      if (activeContext === context) activeContext = null;
    }
  };
  let control: GpcObservation | null = null;
  let treatment: GpcObservation | null = null;
  try {
    try { control = await Promise.race([observe('off'), budgetExpired]); } catch { /* Failed observations cannot be compared. */ }
    if (!timedOut) {
      try { treatment = await Promise.race([observe('on'), budgetExpired]); } catch { /* Failed observations cannot be compared. */ }
    }
  } finally { clearTimeout(timer); }
  const result = compareGpcObservations(control, treatment);
  if (timedOut) {
    result.state = 'inconclusive';
    result.outcome = 'inconclusive';
    result.differences = [];
    result.reason_code = 'EXPERIMENT_BUDGET_EXCEEDED';
  }
  // Tokens only exist to compare identity in memory; debug evidence retains
  // the matched boolean, not an IP, hash, proxy identifier, or token.
  if (control) delete control.identity.egress_fingerprint;
  if (treatment) delete treatment.identity.egress_fingerprint;
  return result;
}
