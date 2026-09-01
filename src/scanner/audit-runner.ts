import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright-core';
import type {
  CmpProvider,
  ConsentStatus,
  AuditModule,
  AuditProxyProvider,
  ErrorCategory,
  EvidenceBundle,
  ScanMode,
  ScanStatus,
  StorefrontAudit,
  TrackingRequestEvidence
} from '../types';
import { selectedAuditModules } from '../audit-modules';
import { classifyAuditTermination } from '../audit-lifecycle';
import { boundedInteger, bulkProxyRetryLimit, consentTimingValues, globalScanTimeoutMs, singleProxyRetryLimit } from '../shared/config';
import { buildMetadata } from '../build-metadata';
import { browserGeoProfile, configureBrowserGeo, reuseOrCreateContext } from './browser-session';
import { createBrowserQlHandoff } from './browserless-bql';
import { attachAuthorizedAccessHeader } from './authorized-access';
import { decideAccessTransition, type AccessIdentity } from './access-state-machine';
import { detectCMP, type CmpRawEvidence } from './consent/detect-cmp';
import { verifyConsentAcceptance, verifyConsentRejection, type ConsentStateSnapshot } from './consent/consent-state';
import {
  consentNavigationReadiness,
  createFreshConsentContext,
  navigateFreshConsentContext
} from './consent/fresh-context';
import { mapConsentV2ToExisting } from './consent/compatibility-mapper';
import { runConsentV2Session, type ConsentV2SessionOutput } from './consent/v2-session';
import { EvidenceCollector } from './evidence/evidence-collector';
import { isValidStorefrontStatus, resolveAccessDecision, resolveHostnameEvidence, type AccessDecision } from './navigation';
import { OrderedAuditUpdates } from './persistence/ordered-updates';
import {
  buildBrowserlessCdpUrl,
  countryForGeo,
  getExternalProxyForGeo,
  getProxyCountryHint,
  parseProxyUrl,
  recordProxyConnect,
  recordProxyError,
  recordProxyRetry,
  recordProxySuccess,
  reserveProxyPortOffset,
  type ProxyMetricEvent,
  summarizeCdpUrlForTrace
} from './proxy/decodo';
import {
  buildProxyAttemptPlan,
  classifyConfirmedTunnelFailure,
  type ProxyProvider
} from './proxy/provider';
import { calculateQaPriority, generateFailureFingerprints } from './quality/fingerprints';
import { replayEvidence } from './quality/replay';
import { sanitizeValue } from './quality/sanitize';
import { FinalizeOnce } from './resolver/lifecycle';
import { classifyCollection } from './server-side/classify-collection';
import { parseGA4Request } from './tracking/ga4';
import { hasMetaBootstrapInText, parseMetaPixelIdsFromText, parseMetaRequest } from './tracking/meta';
import { PDP_MIN_TRACKING_OBSERVATION_MS, PDP_NAVIGATION_ATTEMPT_LIMIT, PDP_POST_LOAD_OBSERVATION_MS } from './version';

const HOMEPAGE_OBSERVATION_MS = 4_000;
const BOT_CHALLENGE_OBSERVATION_MS = 12_000;
const DEFAULT_PRODUCT_DISCOVERY_BUDGET_MS = 15_000;
const DEFAULT_PRODUCT_CONSENT_BUDGET_MS = 15_000;
const TRACKING_PRODUCT_MODULE_BUDGET_MS = 30_000;

export const activeScansRegistry = {
  abortedScans: new Set<string | number>(),
  abort(id: string | number) {
    this.abortedScans.add(id);
  },
  isAborted(id: string | number) {
    return this.abortedScans.has(id);
  },
  cleanup(id: string | number) {
    this.abortedScans.delete(id);
  }
};

class ScanTermination extends Error {
  constructor(
    readonly category: ErrorCategory,
    readonly finalStatus: ScanStatus,
    message: string
  ) {
    super(message);
  }
}

class PhaseTimeout extends Error {
  constructor(readonly phase: string) {
    super(`${phase} exceeded its bounded runtime budget`);
  }
}

function isPhaseTimeout(error: unknown): error is PhaseTimeout {
  return error instanceof PhaseTimeout;
}

export function normalizeAuditDomain(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  if (!raw || /\s/.test(raw) || ['undefined', 'null'].includes(raw.toLowerCase())) return null;
  let hostname = raw;
  try {
    hostname = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  hostname = hostname.toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
    ? hostname
    : null;
}

export function normalizeDomain(input: string) {
  return normalizeAuditDomain(input) || '';
}

export function isSafeCanonicalRedirect(original: string, finalHost: string) {
  const originalBase = original.toLowerCase().replace(/^www\./, '');
  const finalBase = finalHost.toLowerCase().replace(/^www\./, '');
  return originalBase === finalBase || finalBase.endsWith(`.${originalBase}`);
}

export interface RedirectHopEvidence {
  status: number | null;
  host: string;
  path: string;
}

export function isEvidenceBackedExternalRedirect(
  originalDomain: string,
  finalUrl: string,
  finalStatus: number | null,
  chain: RedirectHopEvidence[]
) {
  if (!isValidStorefrontStatus(finalStatus) || chain.length < 2 || chain.length > 10 || isNonStorefrontUrl(finalUrl)) return false;
  let parsed: URL;
  try { parsed = new URL(finalUrl); } catch { return false; }
  if (parsed.protocol !== 'https:' || isSafeCanonicalRedirect(originalDomain, parsed.hostname)) return false;
  const originalBase = originalDomain.toLowerCase().replace(/^www\./, '');
  const firstBase = chain[0].host.toLowerCase().replace(/^www\./, '');
  const finalBase = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const lastBase = chain[chain.length - 1].host.toLowerCase().replace(/^www\./, '');
  if (firstBase !== originalBase || lastBase !== finalBase) return false;
  return chain.slice(0, -1).every((hop) => hop.status !== null && [301, 302, 303, 307, 308].includes(hop.status));
}

export function isNonStorefrontUrl(url: string) {
  return /\/(?:checkouts?|account\/login|login|challenge)(?:\/|$)|cdn-cgi\/challenge|cf-chl-|captcha/i.test(url);
}

function safeUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function parseEgressCountry(payload: Record<string, unknown>) {
  const country = payload.country && typeof payload.country === 'object'
    ? payload.country as Record<string, unknown>
    : null;
  const geo = payload.geo && typeof payload.geo === 'object'
    ? payload.geo as Record<string, unknown>
    : null;
  const candidate = payload.country_code || payload.countryCode || payload.countryCode2 ||
    country?.code || country?.iso_code || country?.isoCode || geo?.country_code || geo?.countryCode ||
    (typeof payload.country === 'string' ? payload.country : '');
  const normalized = String(candidate || '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(normalized) ? (normalized === 'uk' ? 'gb' : normalized) : null;
}

export function classifyBrowserConnectionError(error: unknown) {
  const message = String((error as Error)?.message || error);
  if (/only paid cloud-unit plans can utilize a third-party proxy/i.test(message)) {
    return 'BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED';
  }
  if (/407|proxy authentication|authentication failed/i.test(message)) return 'PROXY_AUTH_REJECTED';
  if (/ERR_TUNNEL_CONNECTION_FAILED|proxy tunnel/i.test(message)) return 'PROXY_TUNNEL_FAILED';
  if (/ERR_PROXY_CONNECTION_FAILED/i.test(message)) return 'PROXY_CONNECTION_FAILED';
  if (/401|unauthorized/i.test(message)) return 'BROWSERLESS_AUTH_REJECTED';
  if (/timeout|timed out/i.test(message)) return 'BROWSER_CONNECTION_TIMEOUT';
  if (/ECONNRESET|disconnected/i.test(message)) return 'PROXY_CONNECTION_RESET';
  return 'BROWSER_CONNECTION_FAILED';
}

function isProxyFailure(error: unknown) {
  return new Set([
    'PROXY_AUTH_REJECTED',
    'PROXY_TUNNEL_FAILED',
    'PROXY_CONNECTION_FAILED',
    'PROXY_CONNECTION_RESET'
  ]).has(classifyBrowserConnectionError(error));
}

function isConfirmedTunnelFailure(error: unknown) {
  return classifyBrowserConnectionError(error) === 'PROXY_TUNNEL_FAILED';
}

function safeBrowserConnectionFailureReason(failureCode: string) {
  if (failureCode === 'BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED') {
    return 'Browserless plan does not allow third-party external proxies';
  }
  if (failureCode === 'BROWSERLESS_AUTH_REJECTED') return 'Browserless authentication was rejected';
  if (failureCode === 'BROWSER_CONNECTION_TIMEOUT') return 'Browserless connection timed out';
  return 'Browser session connection failed';
}

function safeUnhandledFailureReason(error: unknown) {
  if (isNavigationTimeout(error)) return 'Browser navigation timed out';
  const browserFailure = classifyBrowserConnectionError(error);
  if (browserFailure !== 'BROWSER_CONNECTION_FAILED') return safeBrowserConnectionFailureReason(browserFailure);
  return 'Unexpected scanner execution failure';
}

function runtimeErrorFamily(error: unknown) {
  if (isNavigationTimeout(error)) return 'TIMEOUT';
  const connection = classifyBrowserConnectionError(error);
  if (connection !== 'BROWSER_CONNECTION_FAILED') return connection;
  if (/Target page, context or browser has been closed|Target closed|Execution context was destroyed/i.test(String((error as Error)?.message || error))) {
    return 'PAGE_CONTEXT_UNAVAILABLE';
  }
  return 'UNEXPECTED_RUNTIME_ERROR';
}

function isNavigationTimeout(error: unknown) {
  return /Timeout|timed out/i.test(String((error as Error)?.message || error));
}

export function classifyNavigationError(error: unknown) {
  const message = String((error as Error)?.message || error);
  if (/ERR_ABORTED/i.test(message)) return 'NAVIGATION_ABORTED';
  if (/ERR_HTTP2_PROTOCOL_ERROR/i.test(message)) return 'NAVIGATION_HTTP2_ERROR';
  if (/Target page, context or browser has been closed|Target closed/i.test(message)) return 'NAVIGATION_TARGET_CLOSED';
  if (/Execution context was destroyed/i.test(message)) return 'NAVIGATION_CONTEXT_DESTROYED';
  if (/ERR_FAILED/i.test(message)) return 'NAVIGATION_FAILED';
  return 'NAVIGATION_UNKNOWN_ERROR';
}

async function inspectPageAccess(
  page: Page,
  response: Response | null,
  evidence?: EvidenceBundle,
  accessNetworkSignals: string[] = []
): Promise<AccessDecision> {
  const headers = response ? await response.allHeaders().catch(() => ({} as Record<string, string>)) : {};
  const content = await page.evaluate(() => {
    const selectors = [
      '.cf-turnstile', '.cf-challenge', 'iframe[src*="challenges.cloudflare.com"]', '#challenge-form',
      'iframe[src*="captcha-delivery.com"]', '[class*="datadome"]', '#px-captcha', '[class*="captcha"]',
      '[class*="akamai"]', '[class*="perimeterx"]', '[class*="human-security"]', '[class*="waf"]'
    ];
    const iframeUrls = Array.from(document.querySelectorAll('iframe[src]')).map((element) => (element as HTMLIFrameElement).src);
    const scriptUrls = Array.from(document.querySelectorAll('script[src]')).map((element) => (element as HTMLScriptElement).src);
    return {
      title: document.title,
      bodyText: (document.body?.innerText || '').slice(0, 20_000),
      domSignals: selectors.filter((selector) => document.querySelector(selector)),
      iframeUrls,
      scriptUrls
    };
  }).catch(() => ({ title: '', bodyText: '', domSignals: [] as string[], iframeUrls: [] as string[], scriptUrls: [] as string[] }));
  const cookieNames = await page.context().cookies([page.url()]).then((cookies) => cookies.map((cookie) => cookie.name)).catch(() => [] as string[]);
  return resolveAccessDecision({
    status: response?.status() ?? null,
    headers,
    url: page.url(),
    title: content.title,
    bodyText: content.bodyText,
    domSignals: content.domSignals,
    iframeUrls: content.iframeUrls,
    scriptUrls: content.scriptUrls,
    cookieNames,
    networkUrls: evidence ? [
      ...evidence.network.relevant_requests.map((request) => `${request.host}${request.path}`),
      ...evidence.network.response_statuses.map((response) => `${response.host}${response.path}`),
      ...accessNetworkSignals
    ].slice(-130) : [],
    redirectPaths: evidence?.page.redirect_chain.map((hop) => `${hop.host}${hop.path}`) || []
  });
}

async function redirectChain(response: Response | null) {
  const requests: Request[] = [];
  let request = response?.request() || null;
  while (request && requests.length < 20) {
    requests.unshift(request);
    request = request.redirectedFrom();
  }
  return Promise.all(requests.map(async (item) => {
    const itemResponse = await item.response().catch(() => null);
    try {
      const url = new URL(item.url());
      return { status: itemResponse?.status() ?? null, host: url.hostname, path: url.pathname.slice(0, 240) || '/' };
    } catch {
      return { status: itemResponse?.status() ?? null, host: 'invalid', path: '/' };
    }
  }));
}

async function captureCmpRawEvidence(page: Page): Promise<CmpRawEvidence> {
  return page.evaluate(() => {
    const selectors = [
      '#onetrust-banner-sdk', '#onetrust-consent-sdk', '#onetrust-pc-sdk', '.ot-sdk-container', '.ot-sdk-row',
      '#shopify-pc__banner', '.shopify-policy-banner', '.cky-consent-container', '[class*="cookiebot"]',
      '[id*="cookiebot"]', '#fides-banner-container', '#fides-modal-container', '#fides-button-group',
      '#truste-consent-track', '#truste-consent-button', '#truste-show-consent',
      '[class*="consent"]', '[id*="consent"]'
    ];
    const domSelectors = selectors.filter((selector) => document.querySelector(selector));
    const bannerVisible = selectors.some((selector) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0;
    });
    const candidates: Array<[string, unknown]> = [
      ['OneTrust', (window as any).OneTrust],
      ['Optanon', (window as any).Optanon],
      ['OptanonWrapper', (window as any).OptanonWrapper],
      ['Fides', (window as any).Fides],
      ['Shopify.trackingConsent', (window as any).Shopify?.trackingConsent],
      ['Cookiebot', (window as any).Cookiebot],
      ['Didomi', (window as any).Didomi],
      ['UC_UI', (window as any).UC_UI],
      ['__ucCmp', (window as any).__ucCmp],
      ['Osano', (window as any).Osano],
      ['_iub', (window as any)._iub],
      ['__tcfapi', (window as any).__tcfapi]
    ];
    return {
      dom_selectors: domSelectors,
      script_urls: Array.from(document.scripts).map((script) => script.src).filter(Boolean).slice(0, 200),
      network_hosts: [],
      cookie_names: document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean).slice(0, 100),
      window_globals: candidates.filter(([, value]) => Boolean(value)).map(([name]) => name),
      iframe_urls: Array.from(document.querySelectorAll('iframe')).map((iframe) => iframe.src).filter(Boolean).slice(0, 50),
      banner_visible: bannerVisible
    };
  });
}

async function captureConsentState(page: Page): Promise<ConsentStateSnapshot> {
  return page.evaluate(() => {
    const cookieValues = Object.fromEntries(document.cookie.split(';').map((part) => {
      const index = part.indexOf('=');
      return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim().slice(0, 300)] : ['', ''];
    }).filter(([name]) => name));
    const selectors = [
      '#onetrust-banner-sdk', '#shopify-pc__banner', '.shopify-policy-banner', '.cky-consent-container',
      '#fides-banner-container', '#fides-modal-container', '[class*="consent"]'
    ];
    const bannerVisible = selectors.some((selector) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      return Boolean(element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0);
    });
    const activeGroups = String((window as any).OnetrustActiveGroups || '');
    const cookiebot = (window as any).Cookiebot?.consent;
    const shopifyPrivacy = (window as any).Shopify?.customerPrivacy || (window as any).Shopify?.trackingConsent;
    const fidesConsent = (window as any).Fides?.consent;
    const trustArcPreference = String(cookieValues.notice_preferences || '').split(':')[0];
    let trustArcPrivacy = '';
    try {
      trustArcPrivacy = decodeURIComponent(String(cookieValues.cmapi_cookie_privacy || '')).toLowerCase();
    } catch {
      // TrustArc cookies are third-party input and may contain malformed percent escapes.
    }
    const trustArcLevel = /^\d+$/.test(trustArcPreference) ? Number(trustArcPreference) :
      /permit[_ |,]*1(?:[_ |,]*2)?(?:[_ |,]*3)/.test(trustArcPrivacy) ? 2 : null;
    let shopifyConsent: Record<string, unknown> | null = null;
    try {
      const current = shopifyPrivacy?.currentVisitorConsent?.() || shopifyPrivacy?.getTrackingConsent?.();
      if (current && typeof current === 'object') shopifyConsent = current;
    } catch {
      shopifyConsent = null;
    }
    const shopifyDenied = (purpose: string) => {
      const value = shopifyConsent?.[purpose];
      if (value === undefined || value === null || value === '') return null;
      return value === false || String(value).toLowerCase() === 'no' || String(value).toLowerCase() === 'denied';
    };
    return {
      cookie_values: cookieValues,
      banner_visible: bannerVisible,
      provider_state: {
        onetrust_denied: activeGroups ? !/C000[2-9]/.test(activeGroups) : null,
        cookiebot_marketing_denied: cookiebot ? cookiebot.marketing === false : null,
        cookiebot_statistics_denied: cookiebot ? cookiebot.statistics === false : null,
        fides_marketing_denied: typeof fidesConsent?.marketing === 'boolean' ? !fidesConsent.marketing : null,
        fides_analytics_denied: typeof fidesConsent?.analytics === 'boolean' ? !fidesConsent.analytics : null,
        trustarc_functional_denied: trustArcLevel === null ? null : trustArcLevel < 1,
        trustarc_advertising_denied: trustArcLevel === null ? null : trustArcLevel < 2,
        shopify_marketing_denied: shopifyDenied('marketing'),
        shopify_analytics_denied: shopifyDenied('analytics'),
        shopify_preferences_denied: shopifyDenied('preferences')
      }
    };
  });
}

export function consentChoiceSelectors(kind: 'reject' | 'accept') {
  return kind === 'reject'
    ? ['#shopify-pc__banner .shopify-pc__banner__btn-decline', '.shopify-pc__banner__btn-decline', '#fides-reject-all-button', '#truste-consent-required', '.trustarc-declineall-btn', '.trustarc-overlay-decline-all-btn']
    : ['#shopify-pc__banner .shopify-pc__banner__btn-accept', '.shopify-pc__banner__btn-accept', '#fides-accept-all-button', '#truste-consent-button', '.trustarc-acceptall-btn', '.trustarc-overlay-accept-all-btn'];
}

export function trustArcPreferenceControls(kind: 'reject' | 'accept') {
  return {
    optionPrefix: kind === 'accept' ? 'YES' : 'NO',
    submitLabel: 'Submit All Preferences'
  };
}

async function clickConsentChoice(page: Page, kind: 'reject' | 'accept') {
  const labels = kind === 'reject'
    ? ['reject all', 'decline all', 'refuse all', 'reject optional cookies', 'only necessary', 'necessary only', 'use necessary only']
    : ['accept all', 'allow all cookies', 'accept all cookies'];
  const selectors = consentChoiceSelectors(kind);
  return page.evaluate(({ labels, selectors }) => {
    const elements = Array.from(document.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
    const selectorTarget = selectors.map((selector) => document.querySelector(selector) as HTMLElement | null)
      .find((element) => element && element.getBoundingClientRect().width > 0);
    const textTarget = elements.find((element) => {
      const text = (element.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      return element.getBoundingClientRect().width > 0 && labels.some((label) => text === label || text.startsWith(`${label} `));
    });
    const target = selectorTarget || textTarget;
    target?.click();
    return Boolean(target);
  }, { labels, selectors });
}

async function callConsentApi(page: Page, provider: CmpProvider, kind: 'reject' | 'accept') {
  if (provider === 'TrustArc') {
    const preferenceControls = trustArcPreferenceControls(kind);
    for (const frame of page.frames()) {
      const opened = await frame.evaluate(() => {
        const visible = (element: Element) => element instanceof HTMLElement &&
          getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0;
        const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const trigger = controls.find((element) => {
          const text = (element.textContent || element.getAttribute('aria-label') || '').trim().toLowerCase().replace(/\s+/g, ' ');
          return visible(element) && /^(?:cookie|consent|privacy) preferences?$/.test(text);
        }) as HTMLElement | undefined;
        trigger?.click();
        return Boolean(trigger);
      }).catch(() => false);
      if (opened) {
        await page.waitForTimeout(750);
        break;
      }
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      for (const frame of page.frames()) {
        const acted = await frame.evaluate(({ kind, optionPrefix, submitLabel }) => {
          const visible = (element: Element) => element instanceof HTMLElement &&
            getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0;
          const directSelectors = kind === 'reject'
            ? '#truste-consent-required, .trustarc-declineall-btn, .trustarc-overlay-decline-all-btn'
            : '#truste-consent-button, .trustarc-acceptall-btn, .trustarc-overlay-accept-all-btn';
          const directLabels = kind === 'reject'
            ? /^(?:(?:decline|reject) all|required only)$/i
            : /^accept all(?: cookies)?$/i;
          const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const direct = document.querySelector(directSelectors) as HTMLElement | null || controls.find((element) =>
            visible(element) && directLabels.test((element.textContent || element.getAttribute('aria-label') || '').trim())
          ) as HTMLElement | undefined;
          if (direct && visible(direct)) {
            direct.click();
            return true;
          }
          const submit = controls.find((element) => visible(element) &&
            (element.textContent || element.getAttribute('aria-label') || '').trim().toLowerCase() === submitLabel.toLowerCase()
          ) as HTMLElement | undefined;
          if (!submit) return false;
          const choices = Array.from(document.querySelectorAll('input[type="radio"], [role="radio"]')).filter((element) => {
            const label = (element.getAttribute('aria-label') || element.textContent || '').trim().toUpperCase();
            return label.startsWith(`${optionPrefix} `);
          }).slice(0, 20) as HTMLElement[];
          for (const choice of choices) {
            if (choice instanceof HTMLInputElement && choice.checked || choice.getAttribute('aria-checked') === 'true') continue;
            choice.click();
          }
          submit.click();
          return true;
        }, { kind, ...preferenceControls }).catch(() => false);
        if (acted) return true;
      }
      await page.waitForTimeout(250);
    }
    return false;
  }
  return page.evaluate(async ({ provider, kind }) => {
    try {
      const w = window as any;
      if (provider === 'OneTrust') {
        const fn = kind === 'reject' ? w.OneTrust?.RejectAll : w.OneTrust?.AllowAll;
        if (typeof fn === 'function') { fn.call(w.OneTrust); return true; }
      }
      if (provider === 'Fides') {
        const buttonId = kind === 'reject' ? 'fides-reject-all-button' : 'fides-accept-all-button';
        if (typeof w.Fides?.showModal === 'function') {
          w.Fides.showModal();
          await new Promise((resolve) => setTimeout(resolve, 150));
          const button = document.getElementById(buttonId) as HTMLElement | null;
          if (button && button.getBoundingClientRect().width > 0) { button.click(); return true; }
        }
      }
      if (provider === 'Cookiebot') {
        const fn = kind === 'reject' ? w.Cookiebot?.decline : w.Cookiebot?.submitCustomConsent;
        if (typeof fn === 'function') {
          kind === 'reject' ? fn.call(w.Cookiebot) : fn.call(w.Cookiebot, true, true, true);
          return true;
        }
      }
      if (provider === 'Didomi') {
        const fn = kind === 'reject' ? w.Didomi?.setUserDisagreeToAll : w.Didomi?.setUserAgreeToAll;
        if (typeof fn === 'function') { fn.call(w.Didomi); return true; }
      }
      if (provider === 'Usercentrics') {
        const fn = kind === 'reject' ? w.UC_UI?.rejectAllConsents : w.UC_UI?.acceptAllConsents;
        if (typeof fn === 'function') { fn.call(w.UC_UI); return true; }
      }
      if (provider === 'Osano') {
        const fn = kind === 'reject' ? w.Osano?.cm?.denyAll : w.Osano?.cm?.acceptAll;
        if (typeof fn === 'function') { fn.call(w.Osano.cm); return true; }
      }
      if (provider === 'Iubenda') {
        const fn = kind === 'reject' ? w._iub?.cs?.api?.reject : w._iub?.cs?.api?.consentTo;
        if (typeof fn === 'function') { kind === 'reject' ? fn() : fn('all'); return true; }
      }
      if (provider === 'Shopify Privacy') {
        const api = w.Shopify?.customerPrivacy || w.Shopify?.trackingConsent;
        const fn = api?.setTrackingConsent;
        if (typeof fn === 'function') {
          const allowed = kind === 'accept';
          const choice = { analytics: allowed, marketing: allowed, preferences: allowed, sale_of_data: allowed };
          await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            const result = fn.call(api, choice, done);
            if (result && typeof result.then === 'function') result.then(done, done);
            setTimeout(done, 500);
          });
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }, { provider, kind });
}

const OBVIOUS_NON_PRODUCT_PATHS = new Set([
  'account', 'articles', 'blogs', 'cart', 'collections', 'contact', 'help', 'pages', 'policies',
  'search', 'services', 'support', 'customer_authentication'
]);

function canonicalPdpCandidate(raw: string, domain: string) {
  try {
    const url = new URL(raw);
    if (!isSafeCanonicalRedirect(domain, url.hostname) || isNonStorefrontUrl(url.toString())) return null;
    const secondLevel = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '').toLowerCase();
    if (secondLevel.includes('-vs-') || secondLevel.includes('compare')) return null;
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

export function productPatternPdpCandidate(raw: string, domain: string) {
  const url = canonicalPdpCandidate(raw, domain);
  if (!url || !/\/(?:products?|item|p|shop)\//i.test(url.pathname)) return null;
  return url.toString();
}

export function twoLevelPdpCandidate(raw: string, domain: string) {
  try {
    const url = canonicalPdpCandidate(raw, domain);
    if (!url) return null;
    const levels = url.pathname.split('/').filter(Boolean);
    if (levels.length !== 2 || OBVIOUS_NON_PRODUCT_PATHS.has(levels[0].toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function prioritizePdpCandidatePool(productPatternCandidates: string[], twoLevelFallbackCandidates: string[]) {
  // Preserve discovery order: product-pattern URLs are stronger evidence, but a
  // bad explicit URL must never prevent trying a valid two-level fallback.
  return [...new Set([...productPatternCandidates, ...twoLevelFallbackCandidates])];
}

export interface PdpCandidateSignals {
  json_ld_product: boolean;
  og_product: boolean;
  product_form: boolean;
  visible_product_heading: boolean;
  visible_price: boolean;
  enabled_add_to_cart: boolean;
  structured_in_stock: boolean;
  structured_out_of_stock: boolean;
  unavailable_message: boolean;
  disabled_sold_out_control: boolean;
}

export function assessPdpCandidate(signals: PdpCandidateSignals) {
  const productEvidence = signals.json_ld_product || signals.og_product || signals.product_form || signals.enabled_add_to_cart ||
    signals.visible_product_heading && signals.visible_price || signals.structured_in_stock || signals.structured_out_of_stock ||
    signals.unavailable_message || signals.disabled_sold_out_control;
  const outOfStock = !signals.structured_in_stock && !signals.enabled_add_to_cart &&
    (signals.structured_out_of_stock || signals.unavailable_message || signals.disabled_sold_out_control);
  return { is_product: productEvidence, out_of_stock: productEvidence && outOfStock };
}

export function pdpCandidateRejectionReason(
  assessment: { is_product: boolean; out_of_stock: boolean },
  hasValidViewItem: boolean
) {
  if (hasValidViewItem) return null;
  if (!assessment.is_product) return 'PDP_PRODUCT_SIGNALS_MISSING';
  if (assessment.out_of_stock) return 'PDP_OUT_OF_STOCK';
  return null;
}

export function isStrongProductPath(raw: string) {
  try {
    const levels = new URL(raw).pathname.split('/').filter(Boolean);
    return levels.length === 2 && /^(?:products?|item|p)$/i.test(levels[0]);
  } catch {
    return false;
  }
}

function matchesPdpUrl(pageUrl: string | undefined, candidateUrl: string, finalPdpUrl = candidateUrl) {
  if (!pageUrl) return true;
  try {
    const hitUrl = new URL(pageUrl);
    const targets = [finalPdpUrl, candidateUrl];
    return targets.some((target) => {
      const pdpUrl = new URL(target);
      return isSafeCanonicalRedirect(pdpUrl.hostname, hitUrl.hostname) &&
        hitUrl.pathname.replace(/\/+$/, '') === pdpUrl.pathname.replace(/\/+$/, '');
    });
  } catch {
    return false;
  }
}

export function isViewItemForPdp(hit: TrackingRequestEvidence, candidateUrl: string, finalPdpUrl = candidateUrl) {
  if (hit.vendor !== 'ga4' || hit.event !== 'view_item' || !hit.has_product) return false;
  return matchesPdpUrl(hit.page_url, candidateUrl, finalPdpUrl);
}

export function isMetaViewContentForPdp(hit: TrackingRequestEvidence, candidateUrl: string, finalPdpUrl = candidateUrl) {
  return hit.vendor === 'meta' && hit.event?.toLowerCase() === 'viewcontent' &&
    matchesPdpUrl(hit.page_url, candidateUrl, finalPdpUrl);
}

export function pdpReadinessSatisfied(
  assessment: { is_product: boolean } | null,
  hasValidViewItem: boolean
) {
  return Boolean(assessment?.is_product || hasValidViewItem);
}

export function canKeepTimedOutPdp(input: {
  navigationTimedOut: boolean;
  finalPdpUrlValid: boolean;
  assessment: { is_product: boolean } | null;
  hasValidViewItem: boolean;
}) {
  return !input.navigationTimedOut || input.finalPdpUrlValid ||
    pdpReadinessSatisfied(input.assessment, input.hasValidViewItem);
}

async function inspectPdpCandidate(page: Page) {
  const signals = await page.evaluate(() => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getBoundingClientRect().width > 0;
    };
    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).flatMap((script) => {
      try {
        const value = JSON.parse(script.textContent || 'null');
        return Array.isArray(value) ? value : value?.['@graph'] && Array.isArray(value['@graph']) ? value['@graph'] : [value];
      } catch {
        return [];
      }
    }).filter(Boolean) as Array<Record<string, any>>;
    const products = jsonLd.filter((item) => {
      const type = item?.['@type'];
      return (Array.isArray(type) ? type : [type]).some((entry) => String(entry).toLowerCase() === 'product');
    });
    const availability = products.flatMap((product) => {
      const offers = Array.isArray(product.offers) ? product.offers : product.offers ? [product.offers] : [];
      return offers.map((offer: any) => String(offer?.availability || '').toLowerCase());
    }).filter(Boolean);
    const controls = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter(visible) as Array<HTMLElement | HTMLInputElement>;
    const label = (element: HTMLElement | HTMLInputElement) => String(
      element instanceof HTMLInputElement ? element.value : element.textContent || element.getAttribute('aria-label') || ''
    ).trim().toLowerCase().replace(/\s+/g, ' ');
    const addToCart = controls.find((element) => /add to (?:cart|bag)|buy now/.test(label(element)));
    const soldOutControl = controls.find((element) => /sold out|out of stock|unavailable/.test(label(element)));
    const bodyText = (document.body?.innerText || '').slice(0, 250_000).toLowerCase();
    const headings = Array.from(document.querySelectorAll('h1')).filter(visible);
    return {
      json_ld_product: products.length > 0,
      og_product: /product/i.test(document.querySelector('meta[property="og:type"]')?.getAttribute('content') || ''),
      product_form: Array.from(document.querySelectorAll('form[action*="/cart/add"]')).some(visible),
      visible_product_heading: headings.some((heading) => (heading.textContent || '').trim().length >= 2),
      visible_price: /(?:[$£€]\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|gbp|eur))\b/i.test(bodyText),
      enabled_add_to_cart: Boolean(addToCart && !(addToCart as HTMLButtonElement).disabled && addToCart.getAttribute('aria-disabled') !== 'true'),
      structured_in_stock: availability.some((value) => value.endsWith('/instock') || value === 'instock'),
      structured_out_of_stock: availability.length > 0 && availability.every((value) => value.endsWith('/outofstock') || value === 'outofstock'),
      unavailable_message: /\bis out of stock\b|\bcurrently unavailable\b|\bthis (?:item|product) is unavailable\b/.test(bodyText),
      disabled_sold_out_control: Boolean(soldOutControl && ((soldOutControl as HTMLButtonElement).disabled || soldOutControl.getAttribute('aria-disabled') === 'true'))
    } satisfies PdpCandidateSignals;
  });
  return { signals, ...assessPdpCandidate(signals) };
}

async function discoverPdp(page: Page, domain: string, check: () => void, candidateLimit: number) {
  check();
  const links = await page.$$eval('a[href]', (elements) => elements.map((element) => (element as HTMLAnchorElement).href)).catch(() => []);
  check();
  const productCandidates = links.map((link) => productPatternPdpCandidate(link, domain)).filter(Boolean) as string[];
  const twoLevelFallbackCandidates = links.map((link) => twoLevelPdpCandidate(link, domain)).filter(Boolean) as string[];
  const collect = (urls: string[]) => {
    productCandidates.push(...urls.map((url) => productPatternPdpCandidate(url, domain)).filter(Boolean) as string[]);
    twoLevelFallbackCandidates.push(...urls.map((url) => twoLevelPdpCandidate(url, domain)).filter(Boolean) as string[]);
  };

  const fetchXml = async (url: string) => page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Sitemap HTTP ${response.status}`);
    return (await response.text()).slice(0, 1_000_000);
  }, url);
  try {
    const sitemap = await fetchXml(`https://${domain}/sitemap.xml`);
    check();
    const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/gi)].map((match) => match[1].trim());
    collect(locations);
    check();
    const sitemapChildren = locations.filter((url) => /sitemap.*\.xml/i.test(url));
    const child = sitemapChildren.find((url) => /sitemap_products?/i.test(url)) || sitemapChildren[0];
    if (child) {
      const childXml = await fetchXml(child);
      collect([...childXml.matchAll(/<loc>(.*?)<\/loc>/gi)].map((match) => match[1].trim()));
      check();
    }
  } catch {
    // Homepage candidates remain usable when sitemap discovery is unavailable.
  }
  const candidates = prioritizePdpCandidatePool(productCandidates, twoLevelFallbackCandidates);
  check();
  return candidates.slice(0, candidateLimit);
}

function cmsSignalsFromHtml(html: string) {
  const signals: string[] = [];
  const lower = html.toLowerCase();
  if (lower.includes('cdn.shopify.com') || lower.includes('shopify.shop')) signals.push('shopify');
  if (lower.includes('wp-content') || lower.includes('woocommerce')) signals.push('woocommerce');
  if (lower.includes('mage.cookies') || lower.includes('magento')) signals.push('magento');
  if (lower.includes('bigcommerce')) signals.push('bigcommerce');
  if (lower.includes('webflow')) signals.push('webflow');
  return signals;
}

async function capturePageTrackingInstallations(
  page: Page,
  html: string,
  phase: string,
  evidenceCollector: EvidenceCollector
) {
  const metaPixelIds = parseMetaPixelIdsFromText(html);
  if (metaPixelIds.length > 0 || hasMetaBootstrapInText(html)) {
    evidenceCollector.addInstallationSignal({ vendor: 'meta', source: 'inline_script', identifiers: metaPixelIds, phase });
  }
  const metaGlobal = await page.evaluate(() => {
    const w = window as any;
    const fbq = w.fbq || w._fbq;
    return typeof fbq === 'function' && (fbq.loaded === true || Array.isArray(fbq.queue) || typeof w._fbq === 'function');
  }).catch(() => false);
  if (metaGlobal) {
    evidenceCollector.addInstallationSignal({ vendor: 'meta', source: 'window_global', identifiers: metaPixelIds, phase });
  }
}

async function capturePerformanceTrackingRequests(page: Page, phase: string, evidenceCollector: EvidenceCollector) {
  const urls = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => /(?:google-analytics\.com|analytics\.google\.com|doubleclick\.net|facebook\.com)\/(?:g\/collect|collect|tr\/)/i.test(name))
    .slice(-100)).catch(() => [] as string[]);
  let recovered = 0;
  for (const url of urls) {
    const parsed = parseGA4Request(url) || parseMetaRequest(url);
    if (!parsed) continue;
    const alreadyCaptured = evidenceCollector.bundle.network.relevant_requests.some((request) => {
      if (request.vendor !== parsed.vendor || request.kind !== parsed.kind) return false;
      if (parsed.vendor === 'ga4') {
        return request.event === (parsed.event || undefined) &&
          request.measurement_id === (parsed.measurement_id || undefined) &&
          request.page_url === (parsed.page_url || undefined);
      }
      return request.event === (parsed.event || undefined) &&
        request.pixel_id === (parsed.pixel_id || undefined) &&
        request.page_url === (parsed.page_url || undefined);
    });
    if (alreadyCaptured) continue;
    if (evidenceCollector.captureRequest({ url, method: 'GET', phase, source: 'performance_timing' })) recovered += 1;
  }
  return recovered;
}

async function captureDataLayerViewItems(page: Page, phase: string, evidenceCollector: EvidenceCollector) {
  const entries = await page.evaluate(() => {
    const layer = (window as any).dataLayer;
    if (!Array.isArray(layer)) return [];
    return layer.slice(-500).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, any>;
      const commandStyle = String(record[0] || '').toLowerCase() === 'event';
      const event = String(commandStyle ? record[1] : record.event || '').toLowerCase();
      const outerPayload = commandStyle && record[2] && typeof record[2] === 'object' ? record[2] as Record<string, any> : record;
      const payload = outerPayload.ecommerce && typeof outerPayload.ecommerce === 'object'
        ? outerPayload.ecommerce as Record<string, any>
        : outerPayload;
      if (event !== 'view_item' || !Array.isArray(payload.items) || payload.items.length === 0) return [];
      const items = payload.items.slice(0, 10).flatMap((item: unknown) => {
        if (!item || typeof item !== 'object') return [];
        const product = item as Record<string, unknown>;
        return [{
          item_id: product.item_id ?? product.id,
          item_name: product.item_name ?? product.name,
          item_brand: product.item_brand ?? product.brand,
          item_category: product.item_category ?? product.category,
          price: product.price ?? product.value
        }];
      });
      if (!items.length) return [];
      return [{
        0: 'event',
        1: 'view_item',
        2: { items, value: payload.value, send_to: payload.send_to ?? outerPayload.send_to }
      }];
    });
  }).catch(() => [] as unknown[]);
  let captured = 0;
  for (const entry of entries) {
    if (evidenceCollector.captureDataLayerViewItem({ entry, pageUrl: page.url(), phase })) captured += 1;
  }
  return captured;
}

export async function runStorefrontAudit(
  params: {
    audit_id: string | number;
    domain: string;
    tested_geos: 'USA' | 'EU' | 'UK' | null;
    group_label?: string | null;
    enable_captcha_solving?: boolean;
    is_bulk?: boolean;
    scan_mode?: ScanMode;
    selected_modules?: AuditModule[];
    proxy_provider?: AuditProxyProvider;
    abortSignal?: AbortSignal;
    onProxyMetric?: (event: ProxyMetricEvent) => Promise<void>;
  },
  onUpdate: (updates: Partial<StorefrontAudit>) => Promise<void>
): Promise<void> {
  const startedMs = Date.now();
  const timeoutMs = globalScanTimeoutMs();
  // Phase budgets are intentionally capped below the full audit budget so one slow
  // product or consent operation cannot consume the Browserless session.
  const maxPhaseBudgetMs = Math.max(3_000, timeoutMs - 5_000);
  const productDiscoveryBudgetMs = boundedInteger(
    process.env.PRODUCT_DISCOVERY_BUDGET_MS,
    DEFAULT_PRODUCT_DISCOVERY_BUDGET_MS,
    3_000,
    maxPhaseBudgetMs
  );
  const productConsentBudgetMs = boundedInteger(
    process.env.PRODUCT_CONSENT_BUDGET_MS,
    DEFAULT_PRODUCT_CONSENT_BUDGET_MS,
    3_000,
    maxPhaseBudgetMs
  );
  const consentTimings = consentTimingValues();
  const pdpCandidateAttemptLimit = boundedInteger(
    process.env.PDP_NAVIGATION_ATTEMPT_LIMIT,
    PDP_NAVIGATION_ATTEMPT_LIMIT,
    1,
    PDP_NAVIGATION_ATTEMPT_LIMIT
  );
  const normalizedDomain = normalizeAuditDomain(params.domain);
  const geo = params.tested_geos && ['USA', 'EU', 'UK'].includes(params.tested_geos)
    ? params.tested_geos
    : 'USA';
  const proxyPortOffset = reserveProxyPortOffset(geo);
  const selectedModules = selectedAuditModules(params.selected_modules);
  const consentSelected = selectedModules.includes('consent');
  const trackingSelected = selectedModules.includes('tracking');
  const serverSelected = selectedModules.includes('server_side');
  const evidenceCollector = new EvidenceCollector({
    auditId: params.audit_id,
    domain: normalizedDomain || String(params.domain || 'invalid'),
    geo,
    mode: params.scan_mode || 'normal',
    selectedModules
  });
  const evidence = evidenceCollector.bundle;
  const trace: Record<string, unknown>[] = [];
  const lifecycle = new FinalizeOnce();
  const traceLimit = evidence.mode === 'diagnostic' ? 500 : 200;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let homepage: Page | null = null;
  let consentContext: BrowserContext | null = null;
  let consentHomepage: Page | null = null;
  let consentV2: ConsentV2SessionOutput | null = null;
  let pdpPage: Page | null = null;
  let browserConnectedAt: number | null = null;
  let currentPhase = 'initialization';
  let finalStatus: ScanStatus = 'completed';
  let finalError: ErrorCategory = 'none';
  let terminalReasonCode = 'SCAN_COMPLETED';
  let lastInterimUpdate = 0;
  const orderedUpdates = new OrderedAuditUpdates<Partial<StorefrontAudit>>(onUpdate);
  let proxyAttempt = 0;
  let currentProxyProvider: ProxyProvider = params.proxy_provider === 'browserless_residential' ? 'browserless_residential' : 'decodo';
  const initialProxyProvider: ProxyProvider = currentProxyProvider;
  let proxyFallbackUsed = currentProxyProvider === 'browserless_residential';
  let proxyFallbackRecovered = false;
  let neutralProbeSucceeded: boolean | undefined;
  let lastTunnelPhase: 'connect' | 'target' = 'connect';
  let lastProxyPort: number | null = null;
  let lastProxyRotated = false;
  let currentProxyCountry = countryForGeo(geo, 0);
  let effectiveDomain = normalizedDomain || '';
  let contextObserversAttached = false;
  const collectorCookieNames = new Set<string>();
  const cmpNetworkSignals = new Set<string>();
  const accessNetworkSignals = new Set<string>();
  const responseInspectionTasks = new Set<Promise<void>>();
  let scriptResponsesInspected = 0;

  const addTrace = (step: string, details: Record<string, unknown> = {}) => {
    if (trace.length < traceLimit) {
      trace.push({ step, timestamp: new Date().toISOString(), ...(sanitizeValue(details) as Record<string, unknown>) });
    }
    const now = Date.now();
    if (now - lastInterimUpdate > 2_000 && !lifecycle.isFinalized) {
      lastInterimUpdate = now;
      orderedUpdates.enqueue({ scan_status: 'scanning', trace_steps: JSON.stringify(trace) });
    }
  };

  const persistProxyMetric = (event: ProxyMetricEvent) => {
    if (!params.onProxyMetric) return;
    void params.onProxyMetric({ ...event, occurred_at: new Date().toISOString() }).catch(() => {});
  };

  const check = () => {
    const termination = classifyAuditTermination(
      activeScansRegistry.isAborted(params.audit_id),
      Boolean(params.abortSignal?.aborted) || Date.now() - startedMs >= timeoutMs
    );
    if (termination) throw new ScanTermination(
      termination.category,
      termination.scanStatus,
      termination.category === 'cancelled' ? 'Manual cancellation requested' : 'Audit execution timeout'
    );
    if (orderedUpdates.failure) {
      throw new ScanTermination('database_error', 'failed', 'Audit progress persistence failed');
    }
  };

  const withinPhaseBudget = async <T>(phase: string, budgetMs: number, operation: () => Promise<T>) => {
    check();
    const remaining = Math.max(1, Math.min(budgetMs, timeoutMs - (Date.now() - startedMs)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            try {
              check();
              reject(new PhaseTimeout(phase));
            } catch (error) {
              reject(error);
            }
          }, remaining);
        })
      ]);
      evidence.runtime.last_successful_phase = phase;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      check();
    }
  };

  const wait = async (ms: number, page?: Page | null) => {
    let remaining = ms;
    while (remaining > 0) {
      check();
      const slice = Math.min(250, remaining);
      if (page && !page.isClosed()) await page.waitForTimeout(slice);
      else await new Promise((resolve) => setTimeout(resolve, slice));
      remaining -= slice;
    }
  };

  const waitForDomContentSoft = async (page: Page, phase: string, timeout: number) => {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout });
      return true;
    } catch (error) {
      if (!isNavigationTimeout(error)) throw error;
      addTrace('domcontentloaded_wait_timed_out_continuing', {
        phase,
        timeout_ms: timeout,
        current_url: safeUrl(page.url()),
        reason: 'Main document committed; continuing bounded evidence observation'
      });
      return false;
    }
  };

  const closeSession = async () => {
    if (consentHomepage && !consentHomepage.isClosed()) await consentHomepage.close().catch(() => {});
    consentHomepage = null;
    if (consentContext) await consentContext.close().catch(() => {});
    consentContext = null;
    if (pdpPage && !pdpPage.isClosed()) await pdpPage.close().catch(() => {});
    pdpPage = null;
    if (context) await context.close().catch(() => {});
    context = null;
    contextObserversAttached = false;
    if (browser) await browser.close().catch(() => {});
    browser = null;
  };

  const finalizeScanOnce = async () => lifecycle.run(async () => {
    if (evidence.page.valid === null) {
      evidenceCollector.setPage({ valid: false, accessCategory: finalError === 'none' ? 'unknown_error' : finalError });
    } else if (finalError !== 'none') {
      evidenceCollector.setPage({ accessCategory: finalError });
    }
    if (browserConnectedAt !== null) evidence.runtime.browserless_session_ms = Date.now() - browserConnectedAt;
    evidence.runtime.proxy_retry_count = proxyAttempt;
    evidence.runtime.proxy_port = lastProxyPort;
    evidence.runtime.proxy_initial_provider = initialProxyProvider;
    evidence.runtime.proxy_final_provider = currentProxyProvider;
    evidence.runtime.proxy_fallback_used = proxyFallbackUsed;
    evidence.runtime.proxy_fallback_recovered = proxyFallbackRecovered;
    evidence.runtime.proxy_fallback_candidate = Boolean(params.is_bulk && finalError === 'proxy_error' && !proxyFallbackUsed);
    evidenceCollector.setAccess({
      valid_storefront: evidence.page.valid,
      final_url: evidence.page.final_url,
      http_status: evidence.page.status_code,
      initial_provider: initialProxyProvider,
      final_provider: currentProxyProvider,
      proxy_fallback_used: proxyFallbackUsed,
      proxy_fallback_recovered: proxyFallbackRecovered,
      challenge_detected: evidence.access.challenge_detected || Boolean(evidence.page.bot_provider),
      time_to_valid_storefront_ms: evidence.page.valid === true
        ? evidence.access.time_to_valid_storefront_ms ?? Date.now() - startedMs
        : null
    });
    if (responseInspectionTasks.size > 0) {
      await Promise.race([
        Promise.allSettled([...responseInspectionTasks]),
        new Promise((resolve) => setTimeout(resolve, 1_500))
      ]);
    }
    await closeSession();
    const completedEvidence = evidenceCollector.complete(startedMs);
    const replayed = replayEvidence(completedEvidence);
    const merged: Partial<StorefrontAudit> = {
      ...replayed,
      scan_status: finalStatus,
      error_category: finalError,
      terminal_runtime_phase: currentPhase,
      terminal_reason_code: terminalReasonCode,
      scan_completed_at: new Date().toISOString()
    };
    if (consentV2) {
      const compatibility = mapConsentV2ToExisting(consentV2.result, {
        geo,
        page_valid: evidence.page.valid,
        tracking_before_interaction: consentV2.tracking.signals.some((signal) => signal.timing === 'pre_action'),
        post_reject_observation_completed: consentV2.result.persistence.status !== 'not_applicable',
        trace_steps: JSON.stringify(trace),
        max_trace_steps: traceLimit
      }, consentV2.tracking);
      merged.cmp_provider = compatibility.cmp_provider;
      merged.consent_status = compatibility.consent_status;
      for (const step of compatibility.trace_events) {
        if (trace.length >= traceLimit) break;
        trace.push({ step, source: 'consent_v2', timestamp: new Date().toISOString() });
      }
    }
    if (finalError !== 'none') {
      merged.overall_status = 'inconclusive';
      merged.overall_confidence = 'low';
    }
    merged.failure_fingerprints = generateFailureFingerprints(merged, completedEvidence, merged.consistency_violations || []);
    merged.qa_priority = calculateQaPriority(merged, completedEvidence, merged.consistency_violations || []);
    trace.push({
      step: 'scan_finalized',
      status: 'completed',
      scan_status: finalStatus,
      error_category: finalError,
      elapsed_ms: Date.now() - startedMs,
      timestamp: new Date().toISOString()
    });
    merged.trace_steps = JSON.stringify(trace);
    await orderedUpdates.finalize(merged);
    activeScansRegistry.cleanup(params.audit_id);
  });

  const attachContextObservers = (browserContext: BrowserContext) => {
    if (contextObserversAttached) return;
    contextObserversAttached = true;
    browserContext.on('request', (request: Request) => {
      const requestUrl = request.url();
      if (/challenge|turnstile|captcha|datadome|akamai|perimeterx|humansecurity|cdn-cgi|px-captcha/i.test(requestUrl)) {
        const sanitized = safeUrl(requestUrl);
        if (sanitized && accessNetworkSignals.size < 30) accessNetworkSignals.add(sanitized);
      }
      if (/cookielaw\.org|onetrust\.com|otSDKStub\.js|Optanon\.js|cookiebot|didomi|usercentrics|osano|iubenda|privacy-bar|tracking-consent|shopify\.com\/privacy/i.test(requestUrl)) {
        const sanitized = safeUrl(requestUrl);
        if (sanitized && cmpNetworkSignals.size < 100) cmpNetworkSignals.add(sanitized);
      }
      evidenceCollector.captureRequest({
        url: requestUrl,
        body: request.postData() || '',
        method: request.method(),
        phase: currentPhase,
        timestamp: Date.now(),
        source: (request as Request & { serviceWorker?: () => unknown }).serviceWorker?.() ? 'service_worker' : 'page'
      });
    });
    browserContext.on('response', (response: Response) => {
      const responsePhase = currentPhase;
      evidenceCollector.captureResponse({ url: response.url(), status: response.status(), phase: responsePhase });
      const inspection = (async () => {
        try {
          const responseUrl = new URL(response.url());
          const headers = await response.allHeaders();
          const contentType = headers['content-type'] || '';
          const contentLength = Number(headers['content-length'] || 0);
          const inspectScript = response.status() < 400 && scriptResponsesInspected < 15 &&
            /(?:java|ecma)script/i.test(contentType) && (responseUrl.hostname === 'www.googletagmanager.com' ||
              isSafeCanonicalRedirect(effectiveDomain, responseUrl.hostname)) &&
            (!contentLength || contentLength <= 1_000_000);
          if (inspectScript) {
            scriptResponsesInspected += 1;
            const body = await response.text();
            if (body.length <= 1_000_000 && hasMetaBootstrapInText(body)) {
              evidenceCollector.addInstallationSignal({
                vendor: 'meta', source: 'script_content', identifiers: parseMetaPixelIdsFromText(body), phase: responsePhase
              });
            }
          }
        } catch {
          // Bounded script inspection is optional.
        }
        try {
        const request = response.request();
        const parsed = parseGA4Request(response.url(), request.postData() || '') || parseMetaRequest(response.url(), request.postData() || '');
        if (!parsed || parsed.kind !== 'collection') return;
        const host = new URL(response.url()).hostname.toLowerCase();
        const domain = effectiveDomain;
        const firstParty = host === domain || host === `www.${domain}` || host.endsWith(`.${domain}`);
        if (!firstParty) return;
        const headers = await response.allHeaders();
        const setCookie = headers['set-cookie'] || '';
        for (const candidate of setCookie.split(/\r?\n|,(?=[^;,]+=)/)) {
          const match = candidate.trim().match(/^([^=;\s]+)=/);
          if (match && collectorCookieNames.size < 30) collectorCookieNames.add(match[1]);
        }
        } catch {
          // Response cookie evidence is optional; request evidence remains authoritative.
        }
      })();
      responseInspectionTasks.add(inspection);
      void inspection.finally(() => responseInspectionTasks.delete(inspection));
    });
  };

  const browserlessSessionTimeoutMs = boundedInteger(
    process.env.BROWSERLESS_SESSION_TIMEOUT_MS,
    Math.min(timeoutMs + 30_000, 300_000),
    timeoutMs,
    300_000
  );

  const configureConnectedSession = async (preferExisting: boolean) => {
    if (!browser) throw new Error('Browser was not connected');
    const selected = await reuseOrCreateContext(browser, {
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      serviceWorkers: 'allow'
    }, preferExisting);
    context = selected.context;
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    homepage = context.pages()[0] || await context.newPage();
    await homepage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    const appliedGeo = await configureBrowserGeo(context, homepage, currentProxyCountry);
    evidence.runtime.browser_locale = appliedGeo.profile.locale;
    evidence.runtime.browser_timezone = appliedGeo.profile.timezoneId;
    attachContextObservers(context);
    const authorizedSession = await attachAuthorizedAccessHeader(context, homepage, normalizedDomain || '');
    if (process.env.BROWSER_PROVIDER !== 'local') {
      const captchaTelemetry = await context.newCDPSession(homepage).catch(() => null);
      captchaTelemetry?.on('Browserless.captchaFound', () => {
        evidence.runtime.captcha_found = true;
        addTrace('browserless_captcha_found');
      });
      captchaTelemetry?.on('Browserless.captchaSolved', () => {
        evidence.runtime.captcha_solved = true;
        addTrace('browserless_captcha_solved');
      });
      captchaTelemetry?.on('Browserless.captchaAutoSolved', () => {
        evidence.runtime.captcha_solved = true;
        addTrace('browserless_captcha_solved');
      });
    }
    evidence.runtime.authorized_access_applied = Boolean(authorizedSession);
    addTrace('browser_context_ready', {
      reused_browserless_default_context: selected.reused,
      service_workers: 'allowed',
      locale: appliedGeo.profile.locale,
      timezone: appliedGeo.profile.timezoneId,
      authorized_access: Boolean(authorizedSession)
    });
  };

  const verifyProxyEgress = async (neutral = false) => {
    if (!homepage || !context) return;
    const shouldProbe = neutral || evidence.mode === 'diagnostic' || process.env.PROXY_EGRESS_PROBE === 'true';
    if (!shouldProbe || process.env.BROWSER_PROVIDER === 'local') return;
    const probeUrl = neutral
      ? (process.env.PROXY_NEUTRAL_PROBE_URL || 'https://example.com/')
      : (process.env.PROXY_EGRESS_PROBE_URL || 'https://ip.decodo.com/json');
    if (neutral) addTrace('proxy_neutral_probe_started', { provider: currentProxyProvider, attempt: proxyAttempt });
    const probePage = await context.newPage();
    try {
      const response = await probePage.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      if (!response || !response.ok()) throw new Error('Egress probe returned a non-success status');
      const payload = neutral ? {} : await response.json() as Record<string, unknown>;
      const actualCountry = parseEgressCountry(payload);
      const expectedCountries = geo === 'USA' ? ['us'] : geo === 'UK' ? ['gb', 'uk'] : ['de', 'nl', 'fr', 'it', 'es'];
      evidence.runtime.proxy_egress_reachable = true;
      evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, neutral
        ? { neutral_https_result: 'reachable' }
        : { egress_result: 'reachable' });
      if (actualCountry) {
        currentProxyCountry = actualCountry;
        evidence.runtime.proxy_country = currentProxyCountry;
        evidence.runtime.proxy_country_verified = expectedCountries.includes(actualCountry);
        const reapplied = await configureBrowserGeo(context, probePage, currentProxyCountry);
        evidence.runtime.browser_locale = reapplied.profile.locale;
        evidence.runtime.browser_timezone = reapplied.profile.timezoneId;
      }
      const ip = String(payload.ip || payload.proxy || '').trim();
      const salt = process.env.PROXY_IP_HASH_SALT || '';
      if (salt && ip) evidence.runtime.proxy_ip_hash = createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 20);
      if (neutral) {
        neutralProbeSucceeded = true;
        addTrace('proxy_neutral_probe_completed', { reachable: true, provider: currentProxyProvider });
      }
      addTrace('proxy_egress_verified', {
        expected_geo: geo,
        actual_country: actualCountry,
        country_verified: evidence.runtime.proxy_country_verified,
        ip_fingerprint_stored: Boolean(evidence.runtime.proxy_ip_hash)
      });
    } catch {
      evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, neutral
        ? { neutral_https_result: 'unreachable' }
        : { egress_result: 'inconclusive' });
      if (neutral) {
        neutralProbeSucceeded = false;
        addTrace('proxy_neutral_probe_completed', { reachable: false, provider: currentProxyProvider });
      }
      addTrace('proxy_egress_probe_inconclusive', { expected_geo: geo });
    } finally {
      await probePage.close().catch(() => {});
    }
  };

  const connectSession = async (attempt: number, solveCaptchas = false, proxyModeOverride?: string) => {
    check();
    await closeSession();
    const provider = process.env.BROWSER_PROVIDER || 'browserless';
    let cdpUrl = '';
    let proxy = '';
    if (provider === 'browserless' && process.env.BROWSERLESS_TOKEN) {
      const proxyMode = proxyModeOverride || 'decodo';
      currentProxyProvider = proxyMode === 'browserless_residential' ? 'browserless_residential' : 'decodo';
      if (currentProxyProvider === 'browserless_residential') {
        const plan = buildProxyAttemptPlan({ provider: currentProxyProvider, geo, attempt, portOffset: proxyPortOffset,
          browserlessHost: process.env.BROWSERLESS_HOST || 'chrome.browserless.io', browserlessToken: process.env.BROWSERLESS_TOKEN,
          sessionTimeoutMs: browserlessSessionTimeoutMs });
        lastProxyPort = null;
        currentProxyCountry = plan.country;
        cdpUrl = plan.cdpUrl;
      } else {
        proxy = getExternalProxyForGeo(geo, attempt, proxyPortOffset);
      }
      if (!proxy && currentProxyProvider === 'decodo') {
        throw new ScanTermination('proxy_error', 'failed', `No valid Decodo proxy is configured for ${geo}`);
      }
      if (currentProxyProvider === 'decodo') {
        lastProxyPort = parseProxyUrl(proxy).port;
        currentProxyCountry = getProxyCountryHint(proxy, geo, attempt);
      }
      const profile = browserGeoProfile(currentProxyCountry);
      const browserlessHost = process.env.BROWSERLESS_HOST || 'chrome.browserless.io';
      evidence.runtime.browserless_host = browserlessHost;
      evidence.runtime.browserless_session_timeout_ms = browserlessSessionTimeoutMs;
      evidence.runtime.proxy_country = currentProxyCountry;
      if (currentProxyProvider === 'decodo') cdpUrl = buildBrowserlessCdpUrl({
        host: browserlessHost,
        token: process.env.BROWSERLESS_TOKEN,
        route: (process.env.BROWSERLESS_ROUTE === 'standard' ? 'standard' : 'stealth'),
        externalProxyServer: proxy || undefined,
        solveCaptchas,
        timeoutMs: browserlessSessionTimeoutMs,
        browserLocale: profile.locale
      });
    } else {
      const suffix = geo === 'USA' ? '_USA' : `_${geo}`;
      cdpUrl = process.env[`ENV_CDP_URL${suffix}`] || process.env.ENV_CDP_URL || '';
    }
    addTrace('proxy_attempt_started', { provider: currentProxyProvider, attempt: attempt + 1, configured_port: lastProxyPort, geo });
    const identity: AccessIdentity = {
      provider: currentProxyProvider,
      geo,
      proxyPort: lastProxyPort,
      proxySession: 'fresh',
      browserSession: 'fresh',
      context: currentProxyProvider === 'browserless_residential' ? 'browserless_default' : 'fresh',
      locale: browserGeoProfile(currentProxyCountry).locale,
      timezone: browserGeoProfile(currentProxyCountry).timezoneId,
      attempt: attempt + 1
    };
    addTrace('access_identity_created', { ...identity });
    evidence.runtime.proxy_attempts?.push({ provider: currentProxyProvider, attempt: attempt + 1, configured_port: lastProxyPort });
    evidenceCollector.recordAccessProxyAttempt({
      provider: currentProxyProvider,
      geo,
      port: lastProxyPort,
      attempt: attempt + 1,
      connect_duration_ms: null,
      egress_result: 'not_tested',
      neutral_https_result: 'not_tested',
      target_result: 'not_tested',
      failure_classification: null
    });
    evidenceCollector.setAccess({ access_attempt_count: attempt + 1, final_provider: currentProxyProvider });
    addTrace('browser_connecting', {
      attempt,
      connection: cdpUrl ? summarizeCdpUrlForTrace(cdpUrl) : { type: 'local' },
      proxy: proxy ? { host: parseProxyUrl(proxy).host, port: lastProxyPort, geo } : null
    });
    const connectStart = Date.now();
    try {
      browser = cdpUrl
        ? await chromium.connectOverCDP(cdpUrl, { timeout: solveCaptchas ? 60_000 : 30_000 })
        : await chromium.launch({ headless: true });
    } catch (error) {
      const failureCode = classifyBrowserConnectionError(error);
      evidence.runtime.browser_connection_failure_code = failureCode;
      evidenceCollector.updateAccessProxyAttempt(attempt + 1, {
        target_result: 'failed', failure_classification: failureCode
      });
      addTrace('browser_connection_failed', {
        attempt,
        proxy_port: lastProxyPort,
        elapsed_ms: Date.now() - connectStart,
        failure_code: failureCode
      });
      if (isConfirmedTunnelFailure(error)) lastTunnelPhase = 'connect';
      if (!isProxyFailure(error)) {
        throw new ScanTermination('browser_error', 'failed', safeBrowserConnectionFailureReason(failureCode));
      }
      throw error;
    }
    const connectDuration = Date.now() - connectStart;
    const lastAttempt = evidence.runtime.proxy_attempts?.at(-1);
    if (lastAttempt) lastAttempt.connection_ms = connectDuration;
    evidenceCollector.updateAccessProxyAttempt(attempt + 1, { connect_duration_ms: connectDuration });
    browserConnectedAt = Date.now();
    evidence.runtime.browserless_connect_ms = connectDuration;
    recordProxyConnect(geo, lastProxyPort, connectDuration);
    persistProxyMetric({ kind: 'connect', geo, port: lastProxyPort, duration_ms: connectDuration });
    await configureConnectedSession(Boolean(cdpUrl));
    await verifyProxyEgress();
  };

  const connectViaBrowserQl = async (attempt: number) => {
    if (!process.env.BROWSERLESS_TOKEN) throw new Error('BrowserQL requires a Browserless token');
    const proxy = getExternalProxyForGeo(geo, attempt, proxyPortOffset);
    const bqlProxyPort = parseProxyUrl(proxy).port;
    const bqlProxyCountry = getProxyCountryHint(proxy, geo, attempt);
    evidence.runtime.bql_escalation_attempted = true;
    evidence.runtime.captcha_attempted = true;
    evidenceCollector.recordAccessProxyAttempt({
      provider: 'decodo', geo, port: bqlProxyPort, attempt: attempt + 1,
      connect_duration_ms: null, egress_result: 'not_tested', neutral_https_result: 'not_tested',
      target_result: 'not_tested', failure_classification: null
    });
    evidenceCollector.setAccess({ access_attempt_count: attempt + 1, challenge_solver_used: true, challenge_solver_result: 'inconclusive' });
    addTrace('browserql_escalation_started', { attempt, proxy_port: bqlProxyPort });
    const handoffStarted = Date.now();
    const handoff = await createBrowserQlHandoff({
      host: process.env.BROWSERLESS_HOST || 'chrome.browserless.io',
      token: process.env.BROWSERLESS_TOKEN,
      route: 'standard',
      url: `https://${normalizedDomain}`,
      externalProxyServer: proxy || undefined,
      browserLocale: browserGeoProfile(bqlProxyCountry).locale,
      sessionTimeoutMs: browserlessSessionTimeoutMs,
      reconnectTimeoutMs: Math.min(30_000, browserlessSessionTimeoutMs),
      solveChallenge: true
    });
    await closeSession();
    lastProxyPort = bqlProxyPort;
    currentProxyCountry = bqlProxyCountry;
    evidence.runtime.captcha_found = handoff.captchaFound;
    evidence.runtime.captcha_solved = handoff.captchaSolved;
    browser = await chromium.connectOverCDP(handoff.browserWSEndpoint, { timeout: 30_000 });
    evidenceCollector.updateAccessProxyAttempt(attempt + 1, { connect_duration_ms: Date.now() - handoffStarted });
    browserConnectedAt = Date.now();
    await configureConnectedSession(true);
    evidence.runtime.bql_escalation_succeeded = true;
    addTrace('browserql_escalation_handoff_ready', {
      navigation_status: handoff.navigationStatus,
      captcha_found: handoff.captchaFound,
      captcha_solved: handoff.captchaSolved,
      solve_time_ms: handoff.solveTimeMs
    });
  };

  try {
    await onUpdate({ scan_status: 'scanning', scan_mode: evidence.mode, selected_modules: selectedModules, trace_steps: '[]' });
    addTrace('scan_started', { domain: normalizedDomain || 'invalid', tested_geos: params.tested_geos, mode: evidence.mode, ...buildMetadata });
    addTrace('audit_modules_selected', { selected_modules: selectedModules });
    if (!normalizedDomain) {
      finalStatus = 'failed';
      finalError = 'unknown_error';
      addTrace('invalid_domain_input', { reason: 'Domain was missing or invalid before navigation' });
      throw new ScanTermination(finalError, finalStatus, 'Invalid domain');
    }
    if (!params.tested_geos || !['USA', 'EU', 'UK'].includes(params.tested_geos)) {
      finalStatus = 'failed';
      finalError = 'unknown_error';
      addTrace('invalid_or_missing_tested_geo', { reason: 'tested_geos must be USA, EU, or UK' });
      throw new ScanTermination(finalError, finalStatus, 'Invalid geo');
    }

    addTrace('dns_preflight_started', { hostname: normalizedDomain });
    const dnsEvidence = await resolveHostnameEvidence(normalizedDomain);
    evidenceCollector.setPage({ dnsResolutionStatus: dnsEvidence.status, dnsSources: dnsEvidence.sources });
    if (dnsEvidence.status === 'not_resolved') {
      addTrace('dns_preflight_failed', { failure_code: 'DNS_RESOLUTION_FAILED', sources: dnsEvidence.sources });
      throw new ScanTermination('dns_error', 'failed', 'Storefront hostname did not resolve');
    }
    if (dnsEvidence.status === 'inconclusive') {
      addTrace('dns_preflight_inconclusive', {
        reason: 'Independent DNS sources did not reach a conclusive answer; browser navigation remains authoritative',
        sources: dnsEvidence.sources
      });
    } else {
      addTrace('dns_preflight_completed', { status: 'resolved', sources: dnsEvidence.sources });
    }

    const maxProxyRetries = params.is_bulk ? bulkProxyRetryLimit() : singleProxyRetryLimit();
    let solveCaptchas = false;
    let proxyModeOverride: ProxyProvider | undefined = params.proxy_provider;
    let browserQlEscalated = false;
    let response: Response | null = null;
    while (true) {
      try {
        await connectSession(proxyAttempt, solveCaptchas, proxyModeOverride);
        lastTunnelPhase = 'target';
        check();
        currentPhase = 'consent_initial_load';
        evidenceCollector.setPage({ attempted: true });
        addTrace('consent_navigation_started', { url: safeUrl(`https://${normalizedDomain}`) });
        response = await homepage!.goto(`https://${normalizedDomain}`, { waitUntil: 'commit', timeout: 15_000 });
        await waitForDomContentSoft(
          homepage!,
          'consent_initial_load',
          boundedInteger(process.env.HOMEPAGE_DOMCONTENT_TIMEOUT_MS, 15_000, 3_000, 30_000)
        );
        evidence.runtime.last_successful_phase = 'consent_initial_load';
        check();
      } catch (error) {
        if (isConfirmedTunnelFailure(error) && currentProxyProvider === 'decodo') {
          addTrace('proxy_target_tunnel_failed', {
            provider: 'decodo', attempt: proxyAttempt + 1, configured_port: lastProxyPort, phase: lastTunnelPhase
          });
          if (proxyAttempt > 0 && process.env.PROXY_NEUTRAL_PROBE_ENABLED !== 'false') await verifyProxyEgress(true);
          const classification = classifyConfirmedTunnelFailure(lastTunnelPhase, neutralProbeSucceeded);
          evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, {
            target_result: 'failed', failure_classification: classification
          });
          evidenceCollector.setAccess({ challenge_type: 'proxy_failure' });
          addTrace('proxy_failure_classified', { reason_code: classification, provider: 'decodo', attempt: proxyAttempt + 1 });
          if (evidence.runtime.proxy_egress_reachable && dnsEvidence.status !== 'resolved') {
            addTrace('target_origin_unreachable_after_healthy_proxy', {
              dns_status: dnsEvidence.status,
              failure_code: 'DNS_ORIGIN_UNREACHABLE'
            });
            throw new ScanTermination('dns_error', 'failed', 'Storefront origin remained unreachable after a successful proxy egress check');
          }
          recordProxyError(geo, lastProxyPort);
          persistProxyMetric({ kind: 'error', geo, port: lastProxyPort });
          const proxyTransition = decideAccessTransition({
            event: 'proxy_failure', isBulk: params.is_bulk, decodoAttempts: proxyAttempt,
            maxDecodoRetries: maxProxyRetries,
            fallbackEnabled: process.env.BROWSERLESS_RESIDENTIAL_FALLBACK_ENABLED !== 'false',
            challengeSolvingEnabled: false
          });
          if (proxyTransition === 'retry_decodo') {
            const previousPort = lastProxyPort;
            proxyAttempt += 1;
            const retryProxy = getExternalProxyForGeo(geo, proxyAttempt, proxyPortOffset);
            const retryPort = parseProxyUrl(retryProxy).port;
            const retryHost = parseProxyUrl(retryProxy).host;
            const usernameSessionRotated = /(?:^|\.)gate\.decodo\.com$/i.test(retryHost);
            lastProxyRotated = retryPort !== previousPort;
            recordProxyRetry(retryPort, lastProxyRotated);
            persistProxyMetric({ kind: 'retry', geo, port: retryPort, rotated: lastProxyRotated });
            addTrace('proxy_retry_started', {
              attempt: proxyAttempt,
              previous_port: previousPort,
              retry_port: retryPort,
              rotated_port: previousPort !== retryPort,
              rotated_session: previousPort !== retryPort || usernameSessionRotated
            });
            continue;
          }
          if (proxyTransition === 'fallback_browserless_residential') {
            addTrace('proxy_retry_failed', { provider: 'decodo', attempt: proxyAttempt + 1, configured_port: lastProxyPort });
            proxyFallbackUsed = true;
            proxyModeOverride = 'browserless_residential';
            addTrace('proxy_provider_fallback_started', { from: 'decodo', to: 'browserless_residential', attempt: proxyAttempt + 1 });
            proxyAttempt += 1;
            // Re-enter the ordinary connect, navigation, and access-validation loop.
            continue;
          }
          addTrace('proxy_retry_failed', { provider: 'decodo', attempt: proxyAttempt + 1, configured_port: lastProxyPort });
          evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, { failure_classification: 'PROXY_RETRY_EXHAUSTED' });
          if (params.is_bulk) addTrace('proxy_failure_classified', { reason_code: 'PROXY_RETRY_EXHAUSTED', proxy_fallback_candidate: true, provider: 'decodo' });
          else addTrace('proxy_failure_classified', { reason_code: 'PROXY_RETRY_EXHAUSTED', provider: 'decodo' });
          throw new ScanTermination('proxy_error', 'failed', 'Proxy tunnel failed after bounded retry');
        }
        if (isProxyFailure(error)) {
          if (proxyFallbackUsed && String(currentProxyProvider) === 'browserless_residential') {
            addTrace('proxy_provider_fallback_failed', { provider: 'browserless_residential', failure_code: classifyBrowserConnectionError(error) });
          }
          addTrace('proxy_failure_classified', {
            reason_code: classifyBrowserConnectionError(error), provider: currentProxyProvider, attempt: proxyAttempt + 1
          });
          evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, {
            target_result: 'failed', failure_classification: 'PROXY_PROVIDER_UNREACHABLE'
          });
          evidenceCollector.setAccess({ challenge_type: 'proxy_failure' });
          throw new ScanTermination('proxy_error', 'failed', 'Proxy transport failed during browser navigation');
        }
        if (isNavigationTimeout(error)) throw new ScanTermination('navigation_timeout', 'failed', 'Homepage navigation timed out');
        addTrace('homepage_navigation_failed', { failure_code: classifyNavigationError(error) });
        throw new ScanTermination('browser_error', 'failed', 'Homepage browser navigation failed');
      }

      let status = response?.status() ?? null;
      evidenceCollector.setPage({ redirectChain: await redirectChain(response) });
      let access = await inspectPageAccess(homepage!, response, evidence, [...accessNetworkSignals]);

      if (access.category === 'bot_protection') {
        evidenceCollector.setAccess({ challenge_detected: true, challenge_type: access.challengeType });
        evidenceCollector.setPage({
          botProvider: access.botProvider,
          botSignals: access.botSignals,
          retryAfterMs: access.retryAfterMs
        });
        addTrace('bot_protection_detected_initial', {
          status,
          provider: access.botProvider,
          signals: access.botSignals,
          observation_ms: BOT_CHALLENGE_OBSERVATION_MS
        });
        const challengeStarted = Date.now();
        while (Date.now() - challengeStarted < BOT_CHALLENGE_OBSERVATION_MS) {
          await wait(500, homepage);
          const observed = await inspectPageAccess(homepage!, null, evidence, [...accessNetworkSignals]);
          if (observed.category === 'none' && !isNonStorefrontUrl(homepage!.url())) {
            try {
              response = await homepage!.reload({ waitUntil: 'commit', timeout: 15_000 });
              await waitForDomContentSoft(homepage!, 'challenge_clear_reload', 10_000);
              status = response?.status() ?? null;
              access = await inspectPageAccess(homepage!, response, evidence, [...accessNetworkSignals]);
            } catch {
              access = observed;
            }
            if (access.category === 'none') {
              evidenceCollector.setPage({ challengeCleared: true });
              addTrace('bot_challenge_cleared_during_observation', { elapsed_ms: Date.now() - challengeStarted });
              break;
            }
          }
        }
      }

      const bqlEnabled = process.env.BROWSERLESS_CHALLENGE_SOLVING_ENABLED === 'true';
      if (access.category === 'bot_protection' && params.enable_captcha_solving && !params.is_bulk && bqlEnabled &&
        !browserQlEscalated && proxyAttempt < maxProxyRetries) {
        browserQlEscalated = true;
        evidenceCollector.setAccess({ challenge_solver_used: true, challenge_solver_result: 'inconclusive' });
        try {
          const previousPort = lastProxyPort;
          const bqlAttempt = proxyAttempt + 1;
          await connectViaBrowserQl(bqlAttempt);
          proxyAttempt = bqlAttempt;
          lastProxyRotated = lastProxyPort !== previousPort;
          recordProxyRetry(lastProxyPort, lastProxyRotated);
          persistProxyMetric({ kind: 'retry', geo, port: lastProxyPort, rotated: lastProxyRotated });
          currentPhase = 'consent_initial_load';
          response = await homepage!.reload({ waitUntil: 'commit', timeout: 15_000 });
          await waitForDomContentSoft(homepage!, 'browserql_handoff_reload', 10_000);
          status = response?.status() ?? null;
          access = await inspectPageAccess(homepage!, response, evidence, [...accessNetworkSignals]);
          if (access.category === 'none') {
            evidenceCollector.setPage({ challengeCleared: true, redirectChain: await redirectChain(response) });
            evidenceCollector.setAccess({ challenge_solver_result: 'succeeded' });
            addTrace('browserql_challenge_clear_verified', { status });
          } else {
            evidenceCollector.setAccess({ challenge_solver_result: 'failed' });
            evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, { failure_classification: 'CHALLENGE_SOLVER_FAILED' });
            addTrace('browserql_challenge_clear_not_verified', { status, error_category: access.category, reason_code: 'CHALLENGE_SOLVER_FAILED' });
          }
        } catch (error) {
          evidenceCollector.setAccess({ challenge_solver_result: 'failed' });
          evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, { failure_classification: 'CHALLENGE_SOLVER_FAILED' });
          addTrace('browserql_escalation_failed', { reason: safeUnhandledFailureReason(error), reason_code: 'CHALLENGE_SOLVER_FAILED' });
        }
      }

      if (access.category !== 'none') {
        evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, {
          target_result: access.category === 'rate_limited' || access.category === 'bot_protection' || access.category === 'access_blocked'
            ? 'blocked' : 'failed',
          failure_classification: access.reasonCode
        });
        if (access.challengeType) evidenceCollector.setAccess({ challenge_detected: true, challenge_type: access.challengeType });
        evidenceCollector.setPage({
          valid: false,
          statusCode: status,
          finalUrl: safeUrl(homepage!.url()),
          accessCategory: access.category,
          retryAfterMs: access.retryAfterMs,
          botProvider: access.botProvider,
          botSignals: access.botSignals
        });
        addTrace('page_validity_failed', {
          status,
          error_category: access.category,
          reason_code: access.reasonCode,
          retry_after_ms: access.retryAfterMs,
          bot_provider: access.botProvider
        });
        const accessTransition = decideAccessTransition({
          event: access.category === 'rate_limited' ? 'rate_limited' : access.category === 'bot_protection' ? 'challenge' : 'unrecoverable',
          isBulk: params.is_bulk,
          decodoAttempts: proxyAttempt,
          maxDecodoRetries: maxProxyRetries,
          fallbackEnabled: process.env.BROWSERLESS_RESIDENTIAL_FALLBACK_ENABLED !== 'false',
          challengeSolvingEnabled: Boolean(params.enable_captcha_solving && bqlEnabled)
        });
        if (currentProxyProvider === 'decodo' && accessTransition === 'retry_decodo') {
          const previousPort = lastProxyPort;
          proxyAttempt += 1;
          const retryPort = parseProxyUrl(getExternalProxyForGeo(geo, proxyAttempt, proxyPortOffset)).port;
          lastProxyRotated = retryPort !== previousPort;
          recordProxyRetry(retryPort, lastProxyRotated);
          persistProxyMetric({ kind: 'retry', geo, port: retryPort, rotated: lastProxyRotated });
          addTrace('access_identity_retry_started', { reason_code: access.reasonCode, previous_port: previousPort, retry_port: retryPort });
          continue;
        }
        if (currentProxyProvider === 'decodo' && accessTransition === 'fallback_browserless_residential') {
          proxyFallbackUsed = true;
          proxyModeOverride = 'browserless_residential';
          proxyAttempt += 1;
          addTrace('proxy_provider_fallback_started', { from: 'decodo', to: 'browserless_residential', reason_code: access.reasonCode });
          continue;
        }
        if (access.category === 'rate_limited') addTrace('http_rate_limit_confirmed', { status });
        throw new ScanTermination(access.category, 'failed', `Storefront access failed (${access.reasonCode})`);
      }

      if (solveCaptchas) {
        evidence.runtime.captcha_solved = true;
        addTrace('legacy_captcha_clear_verified', { status });
      }
      recordProxySuccess(geo, lastProxyPort);
      persistProxyMetric({ kind: 'storefront_success', geo, port: lastProxyPort });
      if (proxyAttempt > 0) {
        recordProxyRetry(lastProxyPort, lastProxyRotated, true);
        persistProxyMetric({ kind: 'retry_success', geo, port: lastProxyPort, rotated: lastProxyRotated });
        evidence.runtime.proxy_retry_recovered = true;
        addTrace('proxy_retry_succeeded', { provider: currentProxyProvider, attempt: proxyAttempt + 1, configured_port: lastProxyPort });
      }
      if (proxyFallbackUsed && String(currentProxyProvider) === 'browserless_residential') {
        proxyFallbackRecovered = true;
        addTrace('proxy_provider_fallback_succeeded', { provider: 'browserless_residential', recovery: true });
      }
      break;
    }

    const finalUrl = homepage!.url();
    const finalHost = new URL(finalUrl).hostname;
    const canonicalRedirect = isSafeCanonicalRedirect(normalizedDomain, finalHost);
    const externalRedirectAccepted = !canonicalRedirect && isEvidenceBackedExternalRedirect(
      normalizedDomain,
      finalUrl,
      response?.status() ?? null,
      evidence.page.redirect_chain
    );
    if ((!canonicalRedirect && !externalRedirectAccepted) || isNonStorefrontUrl(finalUrl)) {
      evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, { target_result: 'blocked', failure_classification: 'GENERIC_WAF_CHALLENGE' });
      evidenceCollector.setPage({ valid: false, statusCode: response?.status() || null, finalUrl: safeUrl(finalUrl), accessCategory: 'access_blocked' });
      addTrace('non_storefront_redirect_detected', { final_url: safeUrl(finalUrl), final_host: finalHost });
      throw new ScanTermination('access_blocked', 'failed', 'Navigation did not reach a valid storefront');
    }
    effectiveDomain = finalHost;
    evidenceCollector.setObservedDomain(finalHost);
    evidenceCollector.setPage({
      valid: isValidStorefrontStatus(response?.status() || null),
      statusCode: response?.status() || null,
      finalUrl: safeUrl(finalUrl),
      observedDomain: finalHost,
      crossDomainRedirectAccepted: externalRedirectAccepted,
      accessCategory: 'none',
      retryAfterMs: null,
      botProvider: null,
      botSignals: []
    });
    evidenceCollector.updateAccessProxyAttempt(proxyAttempt + 1, { target_result: 'valid_storefront', failure_classification: null });
    evidenceCollector.setAccess({
      valid_storefront: isValidStorefrontStatus(response?.status() || null),
      final_url: safeUrl(finalUrl),
      http_status: response?.status() || null,
      final_provider: currentProxyProvider,
      proxy_fallback_used: proxyFallbackUsed,
      proxy_fallback_recovered: proxyFallbackRecovered,
      time_to_valid_storefront_ms: Date.now() - startedMs
    });
    if (externalRedirectAccepted) {
      addTrace('external_storefront_redirect_accepted', {
        original_domain: normalizedDomain,
        observed_domain: finalHost,
        reason_code: 'EXTERNAL_REDIRECT_CHAIN_VERIFIED'
      });
    }
    addTrace('consent_navigation_completed', { status: response?.status(), final_url: safeUrl(finalUrl) });
    await wait(HOMEPAGE_OBSERVATION_MS, homepage);
    const homepageTimingRecovered = await capturePerformanceTrackingRequests(homepage!, 'consent_initial_load', evidenceCollector);
    if (homepageTimingRecovered > 0) addTrace('performance_tracking_requests_recovered', { phase: 'consent_initial_load', count: homepageTimingRecovered });
    const homepageHtml = await homepage!.content();
    evidenceCollector.setPage({ cmsSignals: cmsSignalsFromHtml(homepageHtml) });
    await capturePageTrackingInstallations(homepage!, homepageHtml, 'consent_initial_load', evidenceCollector);
    if (evidence.mode === 'diagnostic') {
      const image = await homepage!.screenshot({ type: 'jpeg', quality: 55, fullPage: false }).catch(() => null);
      if (image) evidenceCollector.addScreenshot({ name: 'homepage.jpg', mime_type: 'image/jpeg', content_base64: image.toString('base64') });
    }

    let cmp: ReturnType<typeof detectCMP>;
    const consentStarted = Date.now();
    let consentRejectionPending = false;
    if (consentSelected) {
      evidence.consent.executed = true;
      currentPhase = 'consent_fresh_initial_load';
      try {
        const freshConsent = await createFreshConsentContext(browser!, {
          requestedGeo: geo,
          proxyRegion: currentProxyCountry,
          independentlyVerified: evidence.runtime.proxy_egress_reachable ? evidence.runtime.proxy_country_verified : null
        });
        consentContext = freshConsent.context;
        consentHomepage = freshConsent.page;
        const consentAuthorized = await attachAuthorizedAccessHeader(consentContext, consentHomepage, effectiveDomain);
        addTrace('consent_fresh_context_ready', {
          service_workers: freshConsent.service_workers,
          separate_from_tracking_context: consentContext !== context,
          geo: freshConsent.geo,
          authorized_access: Boolean(consentAuthorized)
        });
        const navigation = await navigateFreshConsentContext(consentHomepage, `https://${normalizedDomain}`, { timings: consentTimings });
        const consentAccess = await inspectPageAccess(consentHomepage, navigation.response);
        const readiness = consentNavigationReadiness(consentAccess);
        consentV2 = await runConsentV2Session(consentHomepage, {
          geo,
          geo_verified: freshConsent.geo.verified,
          page_valid: isValidStorefrontStatus(navigation.response?.status() || null),
          timings: consentTimings,
          access_blocked: readiness.status !== 'ready'
        });
        evidence.runtime.consent_v2 = consentV2.telemetry;
        const compatibility = mapConsentV2ToExisting(consentV2.result, {
          geo,
          page_valid: isValidStorefrontStatus(navigation.response?.status() || null),
          tracking_before_interaction: consentV2.tracking.signals.some((signal) => signal.timing === 'pre_action'),
          post_reject_observation_completed: consentV2.result.persistence.status !== 'not_applicable',
          max_trace_steps: traceLimit
        }, consentV2.tracking);
        cmp = {
          provider: compatibility.cmp_provider || (readiness.status === 'ready' ? 'Not Found' : 'Unknown'),
          confidence: compatibility.cmp_provider ? 'high' : 'low',
          evidence: consentV2.result.reason_codes,
          banner_visible: consentV2.result.banner.visibility === 'visible',
          reason_code: consentV2.result.reason_codes[0] || 'DETECTION_INCONCLUSIVE'
        };
        evidence.consent.provider_evidence = consentV2.result.reason_codes;
        evidence.consent.banner_visible = consentV2.result.banner.visibility === 'visible';
        evidence.consent.cookie_names = consentV2.result.storage_changes.map((change) => change.key_name).slice(0, 100);
        addTrace(readiness.status !== 'ready' ? 'consent_fresh_navigation_blocked_or_challenged' : compatibility.cmp_provider ? 'cmp_provider_detected' : 'cmp_not_found', {
          provider: compatibility.cmp_provider,
          reason_codes: consentV2.result.reason_codes,
          access_reason_code: readiness.status !== 'ready' ? consentAccess.reasonCode : null
        });
      } catch (error) {
        cmp = {
          provider: 'Unknown', confidence: 'low', evidence: ['fresh_context_navigation_inconclusive'], banner_visible: null,
          reason_code: 'DETECTION_INCONCLUSIVE'
        };
        finalStatus = 'partial';
        evidence.runtime.failed_phase ||= 'consent_fresh_initial_load';
        addTrace('consent_fresh_navigation_inconclusive', {
          reason_code: 'DETECTION_INCONCLUSIVE',
          error_family: runtimeErrorFamily(error)
        });
      }
      // Consent V2 owns its fresh-context interaction, semantic verification,
      // and same-context reload. Product and Server-Side retain their own page.
      consentRejectionPending = false;
    } else {
      // Tracking may enable an existing CMP, but this deliberately does not execute a Consent audit.
      const cmpRaw = await captureCmpRawEvidence(homepage!);
      cmpRaw.network_hosts = [...cmpNetworkSignals];
      cmp = detectCMP(cmpRaw);
      addTrace('consent_module_skipped');
    }

    const productStarted = Date.now();
    // Reserve time for selected later modules; this is a local product budget,
    // never a replacement for the global audit deadline.
    const productDeadline = Math.min(startedMs + timeoutMs - 5_000, productStarted + TRACKING_PRODUCT_MODULE_BUDGET_MS);
    const productBudgetRemaining = () => Math.max(0, productDeadline - Date.now());
    const checkProductBudget = () => {
      check();
      if (productBudgetRemaining() <= 0) throw new PhaseTimeout('tracking_product');
    };
    if (trackingSelected) {
    evidence.product.executed = true;
    evidence.product.discovery_executed = true;
    currentPhase = 'product_discovery';
    addTrace('product_context_started', { max_pdp_urls_to_audit: 1, max_candidate_attempts: pdpCandidateAttemptLimit });
    let pdpCandidates: string[] = [];
    try {
      pdpCandidates = await withinPhaseBudget(
        'product_discovery',
        Math.max(1, Math.min(productDiscoveryBudgetMs, productBudgetRemaining())),
        () => discoverPdp(homepage!, effectiveDomain, check, pdpCandidateAttemptLimit)
      );
      check();
    } catch (error) {
      if (!isPhaseTimeout(error)) throw error;
      finalStatus = 'partial';
      evidence.runtime.failed_phase ||= 'product_discovery';
      addTrace('product_discovery_budget_exhausted', { reason_code: 'PRODUCT_DISCOVERY_TIMEOUT' });
    }
    evidence.product.pdp_candidates = pdpCandidates.map((url) => safeUrl(url) || '').filter(Boolean);
    if (!pdpCandidates.length) {
      addTrace('product_payload_status_decision', { status: 'pdp_not_found', reason_code: 'PDP_NOT_FOUND' });
    } else {
      if (cmp.provider !== 'Not Found' && cmp.provider !== 'Unknown') {
        currentPhase = 'product_consent_state_capture';
        const productConsentSnapshotStarted = Date.now();
        evidence.runtime.product_consent_snapshot.attempted = true;
        let beforeEnablement: ConsentStateSnapshot | null = null;
        try {
          beforeEnablement = await withinPhaseBudget(
            'product_consent_state_capture',
            productConsentBudgetMs,
            () => captureConsentState(homepage!)
          );
          evidence.runtime.product_consent_snapshot.succeeded = true;
          evidence.runtime.product_consent_snapshot.elapsed_ms = Date.now() - productConsentSnapshotStarted;
        } catch (error) {
          if (error instanceof ScanTermination) throw error;
          evidence.runtime.product_consent_snapshot.succeeded = false;
          evidence.runtime.product_consent_snapshot.failure_code = 'PRODUCT_CONSENT_STATE_CAPTURE_FAILED';
          evidence.runtime.product_consent_snapshot.elapsed_ms = Date.now() - productConsentSnapshotStarted;
          evidence.runtime.failed_phase ||= 'product_consent_state_capture';
          addTrace('product_consent_state_capture_failed', {
            reason_code: 'PRODUCT_CONSENT_STATE_CAPTURE_FAILED',
            error_family: runtimeErrorFamily(error)
          });
          evidence.consent.tracking_enablement = 'inconclusive';
        }
        if (beforeEnablement) {
        const alreadyEnabled = verifyConsentAcceptance(cmp.provider, beforeEnablement, beforeEnablement, false);
        if (alreadyEnabled.verified) {
          evidence.consent.tracking_enablement = 'already_enabled';
          addTrace('product_consent_already_enabled', { provider: cmp.provider, evidence: alreadyEnabled.evidence });
        } else {
          currentPhase = 'product_consent_enablement';
          let accepted = false;
          try {
            accepted = await withinPhaseBudget(
              'product_consent_enablement',
              productConsentBudgetMs,
              async () => clickConsentChoice(homepage!, 'accept') || await callConsentApi(homepage!, cmp.provider, 'accept')
            );
          } catch (error) {
            if (error instanceof ScanTermination) throw error;
            finalStatus = 'partial';
            evidence.runtime.failed_phase ||= 'product_consent_enablement';
            addTrace('product_consent_enablement_inconclusive', {
              reason_code: isPhaseTimeout(error) ? 'PRODUCT_CONSENT_ENABLEMENT_TIMEOUT' : 'PRODUCT_CONSENT_ENABLEMENT_FAILED',
              error_family: runtimeErrorFamily(error)
            });
            evidence.consent.tracking_enablement = 'inconclusive';
          }
          check();
          addTrace('product_consent_enablement', { attempted: true, action_taken: accepted, provider: cmp.provider });
          if (accepted) {
            await wait(500, homepage);
            try {
              const consentReload = await homepage!.reload({ waitUntil: 'commit', timeout: 12_000 });
              await waitForDomContentSoft(homepage!, 'product_consent_enablement', 8_000);
              await wait(2_000, homepage);
              addTrace('product_consent_enablement_reloaded', { status: consentReload?.status() || null });
              const enabledHtml = await homepage!.content();
              await capturePageTrackingInstallations(homepage!, enabledHtml, 'product_consent_enablement', evidenceCollector);
            } catch (error) {
              addTrace('product_consent_enablement_reload_failed', { reason: String((error as Error).message || error) });
            }
          }
          currentPhase = 'product_consent_state_capture';
          const afterEnablement = await withinPhaseBudget(
            'product_consent_state_capture',
            productConsentBudgetMs,
            () => captureConsentState(homepage!)
          ).catch((error) => {
            if (error instanceof ScanTermination) throw error;
            addTrace('product_consent_state_capture_failed', {
              reason_code: 'PRODUCT_CONSENT_STATE_CAPTURE_FAILED',
              error_family: runtimeErrorFamily(error)
            });
            return beforeEnablement;
          });
          const acceptance = verifyConsentAcceptance(cmp.provider, beforeEnablement, afterEnablement, accepted);
          evidence.consent.tracking_enablement = acceptance.verified
            ? 'accepted'
            : accepted ? 'inconclusive' : 'failed';
          addTrace(acceptance.verified ? 'product_consent_enablement_verified' : 'product_consent_enablement_not_verified', {
            provider: cmp.provider,
            evidence: acceptance.evidence
          });
        }
        }
      }

      pdpPage = await context!.newPage();
      await pdpPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
      await configureBrowserGeo(context!, pdpPage, currentProxyCountry);
      await attachAuthorizedAccessHeader(context!, pdpPage, effectiveDomain);
      let selectedPdp = false;
      let pdpNavigationCommitted = false;
      const maxPdpCandidates = Math.min(pdpCandidateAttemptLimit, pdpCandidates.length);
      for (const [candidateIndex, pdpUrl] of pdpCandidates.slice(0, maxPdpCandidates).entries()) {
        try { checkProductBudget(); } catch (error) {
          if (!isPhaseTimeout(error)) throw error;
          finalStatus = 'partial';
          evidence.runtime.failed_phase ||= 'product_pdp_load';
          addTrace('tracking_product_budget_exhausted', { reason_code: 'TRACKING_PRODUCT_TIMEOUT', candidates_attempted: candidateIndex });
          break;
        }
        currentPhase = 'product_pdp_load';
        const viewItemStart = evidence.product.ga4_view_item_hits.length;
        const dataLayerViewItemStart = (evidence.product.data_layer_view_item_hits || []).length;
        addTrace('pdp_navigation_started', {
          pdp_url: safeUrl(pdpUrl),
          candidate_attempt: candidateIndex + 1,
            candidate_limit: maxPdpCandidates
        });
        let pdpOperation = 'pdp_navigation_commit';
        try {
          check();
          let pdpResponse: Response | null = null;
          let navigationTimedOut = false;
          try {
            pdpResponse = await pdpPage!.goto(pdpUrl, {
              waitUntil: 'commit',
              timeout: Math.max(1, Math.min(12_000, productBudgetRemaining()))
            });
          } catch (error) {
            if (!isNavigationTimeout(error)) throw error;
            navigationTimedOut = true;
            addTrace('pdp_navigation_timeout_observing_evidence', {
              candidate_url: safeUrl(pdpUrl), current_url: safeUrl(pdpPage!.url()), candidate_attempt: candidateIndex + 1
            });
          }
          const finalPdpUrl = safeUrl(pdpPage!.url()) || safeUrl(pdpUrl)!;
          evidence.product.candidate_url = safeUrl(pdpUrl);
          evidence.product.final_pdp_url = finalPdpUrl;
          if (!navigationTimedOut) {
            addTrace('pdp_navigation_committed', {
              candidate_url: safeUrl(pdpUrl), final_pdp_url: finalPdpUrl,
              status: pdpResponse?.status() ?? null, candidate_attempt: candidateIndex + 1
            });
            pdpNavigationCommitted = true;
          }
          pdpOperation = 'pdp_domcontentloaded';
          await waitForDomContentSoft(pdpPage, 'product_pdp_load', 12_000);
          checkProductBudget();
          pdpOperation = 'pdp_access_inspection';
          const pdpAccess = await inspectPageAccess(pdpPage, pdpResponse, evidence, [...accessNetworkSignals]);
          if ((!navigationTimedOut && !isValidStorefrontStatus(pdpResponse?.status() || null)) || pdpAccess.category !== 'none') {
            addTrace('pdp_access_invalid', {
              pdp_url: safeUrl(pdpUrl),
              status: pdpResponse?.status() || null,
              error_category: pdpAccess.category,
              reason_code: pdpAccess.reasonCode,
              bot_provider: pdpAccess.botProvider
            });
            throw new Error(`PDP access invalid (${pdpAccess.reasonCode})`);
          }
          pdpOperation = 'pdp_settlement_wait';
          await wait(750, pdpPage);
          checkProductBudget();
          pdpOperation = 'pdp_candidate_assessment';
          let assessmentUnavailable = false;
          let assessment: Awaited<ReturnType<typeof inspectPdpCandidate>>;
          try {
            assessment = await inspectPdpCandidate(pdpPage);
          } catch (error) {
            assessmentUnavailable = true;
            evidence.runtime.failed_phase ||= 'product_pdp_assessment';
            assessment = {
              signals: {
                json_ld_product: false, og_product: false, product_form: false, visible_product_heading: false,
                visible_price: false, enabled_add_to_cart: false, structured_in_stock: false,
                structured_out_of_stock: false, unavailable_message: false, disabled_sold_out_control: false
              },
              is_product: false,
              out_of_stock: false
            };
            addTrace('pdp_candidate_assessment_failed', {
              pdp_url: safeUrl(pdpUrl),
              candidate_attempt: candidateIndex + 1,
              error_family: runtimeErrorFamily(error)
            });
          }
          check();
          if (!assessmentUnavailable) {
            addTrace('pdp_candidate_assessed', {
              pdp_url: safeUrl(pdpUrl),
              is_product: assessment.is_product,
              out_of_stock: assessment.out_of_stock,
              signals: assessment.signals
            });
          }
          const candidateNetworkViewItemHits = () => evidence.product.ga4_view_item_hits.slice(viewItemStart)
            .filter((hit) => isViewItemForPdp(hit, pdpUrl, finalPdpUrl));
          const candidateDataLayerViewItemHits = () => (evidence.product.data_layer_view_item_hits || []).slice(dataLayerViewItemStart)
            .filter((hit) => isViewItemForPdp(hit, pdpUrl, finalPdpUrl));
          const candidateViewItemHits = () => [...candidateNetworkViewItemHits(), ...candidateDataLayerViewItemHits()];
          let candidateHits = candidateViewItemHits();
          const finalPdpUrlValid = Boolean(
            productPatternPdpCandidate(finalPdpUrl, effectiveDomain) || twoLevelPdpCandidate(finalPdpUrl, effectiveDomain)
          );
          const needsTrackingEvidence = assessmentUnavailable || assessment.out_of_stock ||
            !pdpReadinessSatisfied(assessment, candidateHits.some((hit) => hit.has_product));
          if (needsTrackingEvidence && !candidateHits.some((hit) => hit.has_product)) {
            pdpOperation = 'pdp_candidate_tracking_observation';
            addTrace('pdp_candidate_tracking_observation_started', {
              pdp_url: safeUrl(pdpUrl), wait_ms: PDP_POST_LOAD_OBSERVATION_MS,
              reason: assessment.out_of_stock ? 'Out-of-stock signal can be overridden by a valid view_item' : 'Strong product path lacks conventional DOM product signals'
            });
            const candidateObservationStart = Date.now();
            let readinessPolls = 0;
            while (Date.now() - candidateObservationStart < PDP_POST_LOAD_OBSERVATION_MS) {
              candidateHits = candidateViewItemHits();
              if (candidateHits.some((hit) => hit.has_product)) break;
              // JS storefronts frequently hydrate product DOM after commit. Poll
              // boundedly so either DOM or a network view_item wins the race.
              if (readinessPolls++ % 5 === 0 && !assessmentUnavailable) {
                try {
                  assessment = await inspectPdpCandidate(pdpPage);
                  if (assessment.is_product && !assessment.out_of_stock) break;
                } catch (error) {
                  assessmentUnavailable = true;
                  addTrace('pdp_candidate_assessment_failed', {
                    pdp_url: finalPdpUrl, candidate_attempt: candidateIndex + 1,
                    error_family: runtimeErrorFamily(error)
                  });
                }
              }
              await wait(100, pdpPage);
              checkProductBudget();
            }
            const candidateDataLayerCaptured = await captureDataLayerViewItems(pdpPage, 'product_pdp_load', evidenceCollector);
            if (candidateDataLayerCaptured > 0) {
              addTrace('ga4_data_layer_view_item_captured', { phase: 'product_pdp_load', count: candidateDataLayerCaptured });
              candidateHits = candidateViewItemHits();
            }
            if (!candidateHits.some((hit) => hit.has_product) && !assessmentUnavailable) {
              try {
                assessment = await inspectPdpCandidate(pdpPage);
              } catch (error) {
                assessmentUnavailable = true;
                evidence.runtime.failed_phase ||= 'product_pdp_assessment';
                addTrace('pdp_candidate_assessment_failed', {
                  pdp_url: safeUrl(pdpUrl),
                  candidate_attempt: candidateIndex + 1,
                  error_family: runtimeErrorFamily(error)
                });
              }
            }
            if (!candidateHits.some((hit) => hit.has_product) && !assessmentUnavailable) {
              addTrace('pdp_candidate_reassessed_after_observation', {
                pdp_url: safeUrl(pdpUrl),
                is_product: assessment.is_product,
                out_of_stock: assessment.out_of_stock,
                signals: assessment.signals
              });
            }
          }
          const hasValidCandidateViewItem = candidateHits.some((hit) => hit.has_product);
          if (!canKeepTimedOutPdp({ navigationTimedOut, finalPdpUrlValid, assessment, hasValidViewItem: hasValidCandidateViewItem })) {
            addTrace('pdp_candidate_rejected', { candidate_url: safeUrl(pdpUrl), final_pdp_url: finalPdpUrl, reason_code: 'PDP_NAV_TIMEOUT' });
            continue;
          }
          const rejectionReason = assessmentUnavailable && !hasValidCandidateViewItem
            ? 'PDP_ASSESSMENT_UNAVAILABLE'
            : pdpCandidateRejectionReason(assessment, hasValidCandidateViewItem);
          if (rejectionReason) {
            addTrace('pdp_candidate_rejected', { pdp_url: safeUrl(pdpUrl), reason_code: rejectionReason });
            continue;
          }
          if (hasValidCandidateViewItem && (assessment.out_of_stock || !assessment.is_product)) {
            addTrace('pdp_candidate_accepted_from_view_item', {
              pdp_url: safeUrl(pdpUrl), reason_code: 'GA4_VIEW_ITEM_VALID',
              dom_product_signals_present: assessment.is_product, out_of_stock_signal_present: assessment.out_of_stock
            });
          }

          selectedPdp = true;
          evidence.product.pdp_url = finalPdpUrl;
          evidence.product.candidate_url = safeUrl(pdpUrl);
          evidence.product.final_pdp_url = finalPdpUrl;
          evidence.product.navigation_succeeded = true;
          evidence.product.meta_view_content_hits = evidence.product.meta_view_content_hits
            .filter((hit) => isMetaViewContentForPdp(hit, pdpUrl, finalPdpUrl));
          addTrace('pdp_url_selected', { candidate_url: safeUrl(pdpUrl), final_pdp_url: finalPdpUrl, candidate_attempt: candidateIndex + 1 });
          addTrace('pdp_navigation_completed', { status: pdpResponse?.status() });
          pdpOperation = 'pdp_hydration_engagement';
          await pdpPage.evaluate(() => {
            const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            window.scrollTo({ top: Math.min(700, Math.round(maxScroll * 0.3)), behavior: 'instant' });
          }).catch(() => {});
          await wait(600, pdpPage);
          await pdpPage.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => {});
          addTrace('pdp_hydration_engagement_completed', { interaction: 'bounded_scroll' });
          pdpOperation = 'pdp_post_load_observation';
          addTrace('pdp_post_load_observation_started', {
            wait_ms: PDP_POST_LOAD_OBSERVATION_MS,
            minimum_tracking_settlement_ms: PDP_MIN_TRACKING_OBSERVATION_MS
          });
          const observationStart = Date.now();
          while (Date.now() - observationStart < PDP_POST_LOAD_OBSERVATION_MS) {
            const latest = candidateViewItemHits();
            if (latest.some((hit) => hit.has_product) && Date.now() - observationStart >= PDP_MIN_TRACKING_OBSERVATION_MS) break;
            await wait(100, pdpPage);
            checkProductBudget();
          }
          pdpOperation = 'pdp_data_layer_capture';
          const dataLayerCaptured = await captureDataLayerViewItems(pdpPage, 'product_pdp_load', evidenceCollector);
          if (dataLayerCaptured > 0) addTrace('ga4_data_layer_view_item_captured', { phase: 'product_pdp_load', count: dataLayerCaptured });
          pdpOperation = 'pdp_performance_capture';
          const pdpTimingRecovered = await capturePerformanceTrackingRequests(pdpPage, 'product_pdp_load', evidenceCollector);
          if (pdpTimingRecovered > 0) addTrace('performance_tracking_requests_recovered', { phase: 'product_pdp_load', count: pdpTimingRecovered });
          evidence.product.observation_ms = Date.now() - observationStart;
          const finalNetworkViewItems = candidateNetworkViewItemHits();
          const finalDataLayerViewItems = candidateDataLayerViewItemHits();
          const finalViewItems = [...finalNetworkViewItems, ...finalDataLayerViewItems];
          evidence.product.ga4_view_item_hits = finalNetworkViewItems;
          evidence.product.data_layer_view_item_hits = finalDataLayerViewItems;
          evidence.product.meta_view_content_hits = evidence.product.meta_view_content_hits
            .filter((hit) => isMetaViewContentForPdp(hit, pdpUrl, finalPdpUrl));
          if (finalViewItems.some((hit) => hit.has_product)) {
            const hit = finalViewItems.find((item) => item.has_product)!;
            addTrace('ga4_item_payload_detected', {
              measurement_id: hit.measurement_id,
              event: hit.event,
              product_id: hit.product_id,
              source: hit.source,
              reason_code: 'GA4_VIEW_ITEM_VALID'
            });
            addTrace('product_payload_status_decision', { status: 'pass', reason_code: 'GA4_VIEW_ITEM_VALID' });
          }
          pdpOperation = 'pdp_installation_capture';
          const pdpHtml = await pdpPage.content().catch(() => '');
          await capturePageTrackingInstallations(pdpPage, pdpHtml, 'product_pdp_load', evidenceCollector);
          check();
          if (evidence.mode === 'diagnostic') {
            const image = await pdpPage.screenshot({ type: 'jpeg', quality: 55, fullPage: false }).catch(() => null);
            if (image) evidenceCollector.addScreenshot({ name: 'pdp.jpg', mime_type: 'image/jpeg', content_base64: image.toString('base64') });
          }
          break;
        } catch (error) {
          if (error instanceof ScanTermination) throw error;
          if (isPhaseTimeout(error)) {
            finalStatus = 'partial';
            evidence.runtime.failed_phase ||= 'product_pdp_load';
            addTrace('tracking_product_budget_exhausted', { reason_code: 'TRACKING_PRODUCT_TIMEOUT', candidate_attempt: candidateIndex + 1 });
            break;
          }
          const connectionFailure = classifyBrowserConnectionError(error);
          addTrace('pdp_candidate_navigation_failed', {
            pdp_url: safeUrl(pdpUrl),
            candidate_attempt: candidateIndex + 1,
            reason: isProxyFailure(error) ? 'Proxy transport failed during PDP navigation' : safeUnhandledFailureReason(error),
            reason_code: isProxyFailure(error) ? connectionFailure : isNavigationTimeout(error) ? 'PDP_NAV_TIMEOUT' : 'PDP_NAV_ERROR',
            error_family: runtimeErrorFamily(error),
            navigation_code: classifyNavigationError(error),
            operation: pdpOperation,
            page_closed: pdpPage.isClosed()
          });
          if (isProxyFailure(error) && proxyAttempt < maxProxyRetries) {
            const previousPort = lastProxyPort;
            recordProxyError(geo, previousPort);
            persistProxyMetric({ kind: 'error', geo, port: previousPort });
            proxyAttempt += 1;
            const retryProxy = getExternalProxyForGeo(geo, proxyAttempt, proxyPortOffset);
            const retryPort = parseProxyUrl(retryProxy).port;
            lastProxyRotated = retryPort !== previousPort;
            recordProxyRetry(retryPort, lastProxyRotated);
            persistProxyMetric({ kind: 'retry', geo, port: retryPort, rotated: lastProxyRotated });
            addTrace('pdp_proxy_retry_started', {
              failure_code: connectionFailure,
              previous_port: previousPort,
              retry_port: retryPort,
              rotated_port: lastProxyRotated,
              rotated_session: true
            });
            try {
              await connectSession(proxyAttempt, false, proxyModeOverride);
              pdpPage = await context!.newPage();
              await pdpPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
              await configureBrowserGeo(context!, pdpPage, currentProxyCountry);
              await attachAuthorizedAccessHeader(context!, pdpPage, effectiveDomain);
            } catch (retryError) {
              addTrace('pdp_proxy_retry_connection_failed', {
                failure_code: classifyBrowserConnectionError(retryError),
                retry_port: lastProxyPort
              });
              break;
            }
          } else if (candidateIndex + 1 < maxPdpCandidates) {
            try {
              if (pdpPage !== homepage && homepage && !homepage.isClosed()) {
                if (!pdpPage.isClosed()) await pdpPage.close();
                pdpPage = homepage;
                addTrace('pdp_navigation_fallback_to_homepage', { candidate_attempt: candidateIndex + 1 });
              } else {
                if (!pdpPage.isClosed()) await pdpPage.close();
                pdpPage = await context!.newPage();
                await pdpPage.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
                await configureBrowserGeo(context!, pdpPage, currentProxyCountry);
                await attachAuthorizedAccessHeader(context!, pdpPage, effectiveDomain);
                addTrace('pdp_page_recreated_after_navigation_failure', { candidate_attempt: candidateIndex + 1 });
              }
            } catch (recreateError) {
              addTrace('pdp_page_recreation_failed', {
                candidate_attempt: candidateIndex + 1,
                error_family: runtimeErrorFamily(recreateError)
              });
              break;
            }
          }
        }
      }
      if (!selectedPdp) {
        evidence.product.navigation_succeeded = pdpNavigationCommitted;
        evidence.product.ga4_view_item_hits = [];
        evidence.product.data_layer_view_item_hits = [];
        addTrace('pdp_navigation_failed', {
          candidates_attempted: maxPdpCandidates,
          reason: 'No accessible in-stock product candidate was confirmed',
          reason_code: 'PDP_NO_USABLE_CANDIDATE'
        });
      }
    }
    evidence.runtime.module_durations_ms.product = Date.now() - productStarted;
    } else {
      addTrace('tracking_module_skipped');
    }

    // Reject interaction is deliberately after Tracking so it cannot erase the
    // initial product/tracking evidence when both modules are selected.
    if (consentRejectionPending) {
      currentPhase = 'consent_reject';
      evidence.consent.interaction_attempted = true;
      try {
        const before = await withinPhaseBudget('consent_reject_state', productConsentBudgetMs, () => captureConsentState(consentHomepage!));
        const actionTaken = await withinPhaseBudget(
          'consent_reject_action',
          productConsentBudgetMs,
          async () => clickConsentChoice(consentHomepage!, 'reject') || await callConsentApi(consentHomepage!, cmp.provider, 'reject')
        );
        if (actionTaken) {
          await wait(consentTimings.postActionSettleMs, consentHomepage);
          const after = await withinPhaseBudget('consent_reject_state', productConsentBudgetMs, () => captureConsentState(consentHomepage!));
          const verified = verifyConsentRejection(cmp.provider, before, after);
          evidence.consent.rejection_verified = verified.verified;
          addTrace(verified.verified ? 'reject_action_verified' : 'reject_action_not_verified', { evidence: verified.evidence });
        } else {
          addTrace('reject_action_not_available', { provider: cmp.provider });
        }
      } catch (error) {
        if (error instanceof ScanTermination) throw error;
        finalStatus = 'partial';
        evidence.runtime.failed_phase ||= 'consent_reject';
        addTrace('consent_reject_inconclusive', {
          reason_code: isPhaseTimeout(error) ? 'CONSENT_REJECT_TIMEOUT' : 'CONSENT_REJECT_FAILED',
          error_family: runtimeErrorFamily(error)
        });
      }
      if (evidence.consent.rejection_verified) {
        currentPhase = 'consent_post_reject';
        try {
          const postRejectResponse = await consentHomepage!.reload({ waitUntil: 'commit', timeout: 15_000 });
          await waitForDomContentSoft(consentHomepage!, 'consent_post_reject', consentTimings.providerReadinessMs);
          if (!isValidStorefrontStatus(postRejectResponse?.status() || null)) throw new Error('Post-reject reload did not return a valid storefront');
          await wait(consentTimings.reloadSettleMs, consentHomepage);
          evidence.consent.post_reject_observation_completed = true;
        } catch (error) {
          if (error instanceof ScanTermination) throw error;
          finalStatus = 'partial';
          addTrace('post_reject_observation_failed', { error_family: runtimeErrorFamily(error) });
        }
      }
    }
    evidence.runtime.module_durations_ms.consent = Date.now() - consentStarted;

    const serverStarted = Date.now();
    const remaining = timeoutMs - (Date.now() - startedMs);
    if (!serverSelected) {
      addTrace('server_side_module_skipped');
    } else if (remaining < 5_000) {
      evidence.server_side.executed = false;
      finalStatus = 'partial';
      addTrace('server_module_skipped_budget_low', { remaining_ms: remaining });
      addTrace('ss_collection_type_decision', { ss_collection_type: 'not_tested' });
      addTrace('server_side_status_decision', { server_side_status: 'not_tested' });
    } else {
      evidence.server_side.executed = true;
      const firstPartyRequests = evidence.network.relevant_requests.filter((request) =>
        request.kind === 'collection' && request.collector !== 'third_party'
      );
      evidence.server_side.collector_cookie_names = [...collectorCookieNames];
      if (firstPartyRequests.length > 0 && collectorCookieNames.size > 0) {
        evidence.server_side.collector_cookie_persistence_checked = true;
        currentPhase = 'server_cookie_persistence_reload';
        try {
          await homepage!.reload({ waitUntil: 'commit', timeout: 12_000 });
          await waitForDomContentSoft(homepage!, 'server_cookie_persistence_reload', 8_000);
          await wait(1_000, homepage);
          const cookies = await context!.cookies();
          evidence.server_side.collector_cookie_persisted = cookies.some((cookie) => collectorCookieNames.has(cookie.name));
        } catch {
          evidence.server_side.collector_cookie_persisted = false;
        }
      } else {
        addTrace('collector_cookie_check_skipped', { reason: 'No first-party collector response cookie to verify' });
      }
      const serverRequests = evidence.network.relevant_requests.filter((request) => request.phase !== 'server_cookie_persistence_reload');
      const classification = classifyCollection({
        executed: true,
        page_valid: evidence.page.valid,
        requests: serverRequests,
        collector_cookie_detected: collectorCookieNames.size > 0,
        collector_cookie_persisted: evidence.server_side.collector_cookie_persisted
      });
      evidence.server_side.first_party_collection_count = classification.first_party_collection_count;
      evidence.server_side.same_origin_collection_count = classification.same_origin_collection_count;
      evidence.server_side.third_party_collection_count = classification.third_party_collection_count;
      evidence.server_side.strict_duplicate_count = classification.strict_duplicate_count;
      addTrace('server_relevant_requests_summarized', {
        first_party_collection_count: classification.first_party_collection_count,
        same_origin_collection_count: classification.same_origin_collection_count,
        third_party_collection_count: classification.third_party_collection_count,
        strict_duplicate_count: classification.strict_duplicate_count
      });
      addTrace('ss_collection_type_decision', { ss_collection_type: classification.collection_type, reason_code: classification.reason_code });
      addTrace('server_side_status_decision', { server_side_status: classification.status, reason_code: classification.reason_code });
    }
    evidence.runtime.module_durations_ms.server_side = Date.now() - serverStarted;

    finalError = 'none';
    finalStatus = finalStatus === 'partial' ? 'partial' : 'completed';
  } catch (error) {
    evidence.runtime.failed_phase = currentPhase;
    if (error instanceof ScanTermination) {
      finalError = error.category;
      finalStatus = error.finalStatus;
      terminalReasonCode = error.category === 'scan_timeout' ? 'SCAN_TIMEOUT' : error.category === 'cancelled' ? 'SCAN_CANCELLED' : 'SCAN_ABORTED';
      addTrace(
        error.category === 'cancelled' ? 'manual_scan_cancelled' :
          error.category === 'scan_timeout' ? 'scan_timeout' : 'scan_aborted',
        { error_category: error.category, reason: error.message, phase: currentPhase, reason_code: error.category === 'scan_timeout' ? 'SCAN_TIMEOUT' : undefined, error_family: error.category }
      );
    } else {
      const timedOut = Date.now() - startedMs >= timeoutMs;
      finalError = timedOut ? 'scan_timeout' : isProxyFailure(error) ? 'proxy_error' : isNavigationTimeout(error) ? 'navigation_timeout' : 'unknown_error';
      finalStatus = 'failed';
      terminalReasonCode = timedOut ? 'SCAN_TIMEOUT' : finalError === 'proxy_error' ? 'PROXY_RUNTIME_FAILURE' : 'UNEXPECTED_RUNTIME_ERROR';
      addTrace('scan_failed', {
        error_category: finalError,
        phase: currentPhase,
        reason_code: timedOut ? 'SCAN_TIMEOUT' : 'UNEXPECTED_RUNTIME_ERROR',
        error_family: runtimeErrorFamily(error),
        reason: safeUnhandledFailureReason(error)
      });
    }
  } finally {
    await finalizeScanOnce();
  }
}
