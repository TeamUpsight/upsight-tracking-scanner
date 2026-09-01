import type { Page } from 'playwright-core';
import type { CmpAdapterProviderId } from './adapter-registry';
import { ONETRUST_DOCUMENTED_CONTROLS, ONETRUST_STANDARD_ROOTS } from './onetrust-adapter';
import { COOKIEBOT_STANDARD_CONTROLS, COOKIEBOT_STANDARD_ROOT } from './cookiebot-adapter';
import { USERCENTRICS_STANDARD_ROOT } from './usercentrics-adapter';
import { DIDOMI_STANDARD_ROOTS } from './didomi-adapter';
import { COOKIEYES_STANDARD_ROOT, COOKIEYES_STABLE_CONTROLS } from './cookieyes-adapter';
import { observeConsentFrameworks, type ConsentFrameworkObservations } from './framework-observers';

type DomObservation = { selector: string; visible: boolean; enabled: boolean; text: string };

export interface BrowserConsentFacts {
  globals: string[];
  assets: string[];
  cookie_names: string[];
  storage_keys: string[];
  observations: DomObservation[];
  cookiebot: Record<string, unknown> | null;
  cookieyes: Record<string, unknown> | null;
  shopify: Record<string, unknown> | null;
  consent_commands: Array<{ command: 'default' | 'update'; state: Record<string, unknown>; timestamp?: number }>;
  generic: {
    surfaces: Array<{ id: string; surface_type: 'banner' | 'dialog' | 'drawer'; visible: boolean; privacy_or_cookie_semantics: boolean; intent: string }>;
    controls: Array<{ surface_id: string; visible: boolean; enabled: boolean; actionable: boolean; accessible_name: string }>;
  };
}

const PROVIDER_GLOBALS = ['OneTrust', 'Optanon', 'Cookiebot', 'UC_UI', 'Didomi', 'CookieYes', '_sp_', '_sp_queue', '__tcfapi', '__gpp', '__uspapi'];
const DOM_SELECTORS = [
  ...ONETRUST_STANDARD_ROOTS, ...Object.values(ONETRUST_DOCUMENTED_CONTROLS),
  COOKIEBOT_STANDARD_ROOT, ...Object.values(COOKIEBOT_STANDARD_CONTROLS),
  USERCENTRICS_STANDARD_ROOT, ...DIDOMI_STANDARD_ROOTS,
  COOKIEYES_STANDARD_ROOT, ...Object.values(COOKIEYES_STABLE_CONTROLS)
];

const CONSENT_COMMAND_OBSERVATIONS_KEY = '__upsightConsentCommandObservations';

/**
 * Installs a narrowly-scoped, pre-navigation dataLayer observer. It only
 * records consent default/update commands and delegates every array push to
 * the site's original implementation unchanged.
 */
export async function installConsentCommandBootstrap(page: Page) {
  await page.context().addInitScript((key) => {
    const w = window as any;
    const allowedState = (value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const name of ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization', 'functionality_storage', 'personalization_storage', 'security_storage']) {
        if (typeof source[name] === 'string') result[name] = source[name];
      }
      if (typeof source.wait_for_update === 'number' && Number.isFinite(source.wait_for_update)) result.wait_for_update = Math.max(0, Math.min(Math.floor(source.wait_for_update), 60_000));
      return result;
    };
    const observations: Array<{ command: 'default' | 'update'; state: Record<string, unknown>; timestamp: number }> = Array.isArray(w[key]) ? w[key] : [];
    w[key] = observations;
    const record = (entry: unknown) => {
      const command = Array.isArray(entry) ? entry : entry && typeof entry === 'object' && typeof (entry as { length?: unknown }).length === 'number' ? Array.from(entry as ArrayLike<unknown>) : null;
      if (!command || command[0] !== 'consent' || (command[1] !== 'default' && command[1] !== 'update')) return;
      const state = allowedState(command[2]);
      if (!state || observations.length >= 100) return;
      observations.push({ command: command[1], state, timestamp: Date.now() });
    };
    const observeDataLayer = (value: unknown) => {
      if (!Array.isArray(value) || (value as any).__upsightConsentObserverInstalled) return;
      value.forEach(record);
      const originalPush = value.push;
      Object.defineProperty(value, '__upsightConsentObserverInstalled', { value: true, configurable: false });
      value.push = function (...entries: unknown[]) {
        entries.forEach(record);
        return originalPush.apply(this, entries as any);
      };
    };
    let dataLayer = w.dataLayer;
    observeDataLayer(dataLayer);
    const descriptor = Object.getOwnPropertyDescriptor(w, 'dataLayer');
    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(w, 'dataLayer', {
        configurable: true,
        get: () => dataLayer,
        set: (value) => { dataLayer = value; observeDataLayer(value); }
      });
    }
  }, CONSENT_COMMAND_OBSERVATIONS_KEY);
}

/** Captures normalized, bounded browser facts. Provider interpretation remains in adapters. */
export async function captureBrowserConsentFacts(page: Page): Promise<BrowserConsentFacts> {
  return page.evaluate(({ globals, selectors, consentCommandKey }) => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const normal = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const w = window as any;
    const controls = (surface: Element) => Array.from(surface.querySelectorAll('button, [role="button"], a')).slice(0, 30).map((control) => ({
      visible: visible(control), enabled: !(control as HTMLButtonElement).disabled, actionable: true,
      accessible_name: String((control as HTMLElement).getAttribute('aria-label') || control.textContent || '').slice(0, 120)
    }));
    const genericSurfaces = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i]')).slice(0, 30);
    const generic = { surfaces: genericSurfaces.map((surface, index) => {
      const text = normal(String((surface as HTMLElement).innerText || surface.textContent || '').slice(0, 1200));
      const negative = /newsletter|sign in|log in|create account|age|country|location|currency/.test(text);
      return { id: `surface-${index}`, surface_type: surface.getAttribute('role') === 'dialog' || surface.getAttribute('aria-modal') === 'true' ? 'dialog' : 'banner', visible: visible(surface), privacy_or_cookie_semantics: /cookie|consent|privacy|tracking/.test(text), intent: negative ? 'unknown' : 'consent' };
    }), controls: genericSurfaces.flatMap((surface, index) => controls(surface).map((control) => ({ ...control, surface_id: `surface-${index}` }))) };
    const cb = w.Cookiebot;
    const cookiebot = cb ? { has_response: typeof cb.hasResponse === 'boolean' ? cb.hasResponse : null, consented: typeof cb.consented === 'boolean' ? cb.consented : null, declined: typeof cb.declined === 'boolean' ? cb.declined : null, consent: cb.consent ? { preferences: typeof cb.consent.preferences === 'boolean' ? cb.consent.preferences : null, statistics: typeof cb.consent.statistics === 'boolean' ? cb.consent.statistics : null, marketing: typeof cb.consent.marketing === 'boolean' ? cb.consent.marketing : null } : null } : null;
    let cookieyes: Record<string, unknown> | null = null;
    try { const raw = typeof w.getCkyConsent === 'function' ? w.getCkyConsent() : null; const categories = raw?.categories || raw; cookieyes = categories ? { analytics: typeof categories.analytics === 'boolean' ? categories.analytics : null, advertisement: typeof categories.advertisement === 'boolean' ? categories.advertisement : null, performance: typeof categories.performance === 'boolean' ? categories.performance : null } : null; } catch { /* Runtime access is optional. */ }
    let shopify: Record<string, unknown> | null = null;
    try { const privacy = w.Shopify?.customerPrivacy; if (privacy) { const methods = ['currentVisitorConsent', 'analyticsProcessingAllowed', 'marketingAllowed', 'preferencesProcessingAllowed', 'saleOfDataAllowed', 'shouldShowBanner', 'getRegion'].filter((name) => typeof privacy[name] === 'function'); const consent = typeof privacy.currentVisitorConsent === 'function' ? privacy.currentVisitorConsent() : null; shopify = { shopify_object_present: Boolean(w.Shopify), customer_privacy_object_present: true, runtime_methods: methods, visitor_consent: consent ? { analytics: consent.analytics === 'yes' || consent.analytics === 'no' ? consent.analytics : '', marketing: consent.marketing === 'yes' || consent.marketing === 'no' ? consent.marketing : '', preferences: consent.preferences === 'yes' || consent.preferences === 'no' ? consent.preferences : '', sale_of_data: consent.sale_of_data === 'yes' || consent.sale_of_data === 'no' ? consent.sale_of_data : '' } : null, processing_allowed: { analytics: typeof privacy.analyticsProcessingAllowed === 'function' ? Boolean(privacy.analyticsProcessingAllowed()) : null, marketing: typeof privacy.marketingAllowed === 'function' ? Boolean(privacy.marketingAllowed()) : null, preferences: typeof privacy.preferencesProcessingAllowed === 'function' ? Boolean(privacy.preferencesProcessingAllowed()) : null, sale_of_data: typeof privacy.saleOfDataAllowed === 'function' ? Boolean(privacy.saleOfDataAllowed()) : null }, should_show_banner: typeof privacy.shouldShowBanner === 'function' ? Boolean(privacy.shouldShowBanner()) : null, region_available: typeof privacy.getRegion === 'function' ? Boolean(privacy.getRegion()) : null }; } } catch { /* Runtime access is optional. */ }
    const commandState = (value: unknown) => {
      if (!value || typeof value !== 'object') return null;
      const source = value as Record<string, unknown>; const result: Record<string, unknown> = {};
      for (const name of ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization', 'functionality_storage', 'personalization_storage', 'security_storage']) if (typeof source[name] === 'string') result[name] = source[name];
      if (typeof source.wait_for_update === 'number' && Number.isFinite(source.wait_for_update)) result.wait_for_update = Math.max(0, Math.min(Math.floor(source.wait_for_update), 60_000));
      return result;
    };
    const commands: Array<{ command: 'default' | 'update'; state: Record<string, unknown>; timestamp?: number }> = [];
    for (const entry of Array.isArray(w[consentCommandKey]) ? w[consentCommandKey].slice(-100) : []) {
      if (entry && (entry.command === 'default' || entry.command === 'update') && entry.state && typeof entry.state === 'object') commands.push({ command: entry.command, state: entry.state, timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : undefined });
    }
    if (!commands.length) for (const entry of Array.isArray(w.dataLayer) ? w.dataLayer.slice(-100) : []) { const command = Array.isArray(entry) ? entry : entry && typeof entry === 'object' && typeof (entry as { length?: unknown }).length === 'number' ? Array.from(entry as ArrayLike<unknown>) : null; if (command && command[0] === 'consent' && (command[1] === 'default' || command[1] === 'update')) { const state = commandState(command[2]); if (state) commands.push({ command: command[1], state }); } }
    let cookieNames: string[] = []; let storageKeys: string[] = [];
    try { cookieNames = document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean).slice(0, 100); } catch { /* Opaque origins have no cookie jar. */ }
    try { storageKeys = Object.keys(localStorage).slice(0, 100); } catch { /* Opaque origins have no Web Storage. */ }
    return { globals: globals.filter((name) => Boolean(w[name])), assets: Array.from(document.scripts).map((script) => script.src).filter(Boolean).slice(0, 200), cookie_names: cookieNames, storage_keys: storageKeys, observations: selectors.map((selector) => { const element = document.querySelector(selector) as HTMLButtonElement | null; return element ? { selector, visible: visible(element), enabled: !element.disabled, text: String(element.getAttribute('aria-label') || element.textContent || '').slice(0, 120) } : null; }).filter(Boolean), cookiebot, cookieyes, shopify, consent_commands: commands, generic };
  }, { globals: PROVIDER_GLOBALS, selectors: DOM_SELECTORS, consentCommandKey: CONSENT_COMMAND_OBSERVATIONS_KEY }) as Promise<BrowserConsentFacts>;
}

const observation = (facts: BrowserConsentFacts, selector: string) => facts.observations.find((item) => item.selector === selector);
const control = (facts: BrowserConsentFacts, selector: string, within = true) => ({ selector, id: selector, visible: Boolean(observation(facts, selector)?.visible), enabled: Boolean(observation(facts, selector)?.enabled), actionable: Boolean(observation(facts, selector)?.visible && observation(facts, selector)?.enabled), within_confirmed_cookiebot_surface: within, within_confirmed_cookieyes_surface: within, within_confirmed_usercentrics_surface: within });
const storage = (facts: BrowserConsentFacts) => [...facts.cookie_names.map((key_name) => ({ key_name, name: key_name, storage_type: 'cookie' as const, exists: true })), ...facts.storage_keys.map((key_name) => ({ key_name, name: key_name, storage_type: 'local_storage' as const, exists: true }))];
const click = (page: Page, selector: string) => page.locator(selector).first().click().then(() => true).catch(() => false);

/** Builds transient adapter contexts; the adapters retain all provider semantics. */
export function buildProviderContexts(page: Page, facts: BrowserConsentFacts, framework: { tcf: boolean; gpp: boolean }) {
  const common = { asset_urls: facts.assets, cookies: facts.cookie_names.map((name) => ({ name, exists: true })), storage: storage(facts), tcf_active: framework.tcf, gpp_active: framework.gpp };
  return new Map<CmpAdapterProviderId, unknown>([
    ['onetrust', { ...common, window_globals: facts.globals, surfaces: ONETRUST_STANDARD_ROOTS.map((selector) => ({ selector, visible: Boolean(observation(facts, selector)?.visible) })), controls: Object.values(ONETRUST_DOCUMENTED_CONTROLS).map((selector) => control(facts, selector)), public_methods: ['AllowAll', 'RejectAll', 'ToggleInfoDisplay'].filter((method) => facts.globals.includes('OneTrust') && method === 'RejectAll'), invoke_control: (selector: string) => click(page, selector), invoke_public_method: (method: string) => page.evaluate((name) => { const api = (window as any).OneTrust; if (typeof api?.[name] !== 'function') return false; api[name](); return true; }, method).catch(() => false) }],
    ['cookiebot', { ...common, window_globals: facts.globals, surfaces: [{ selector: COOKIEBOT_STANDARD_ROOT, visible: Boolean(observation(facts, COOKIEBOT_STANDARD_ROOT)?.visible) }], controls: Object.values(COOKIEBOT_STANDARD_CONTROLS).map((selector) => control(facts, selector)), runtime: facts.cookiebot, invoke_control: (selector: string) => click(page, selector) }],
    ['usercentrics', { ...common, uc_ui_type: facts.globals.includes('UC_UI') ? 'object' : 'undefined', surfaces: [{ selector: USERCENTRICS_STANDARD_ROOT, visible: Boolean(observation(facts, USERCENTRICS_STANDARD_ROOT)?.visible) }], controls: [], legacy_globals: facts.globals, invoke_control: (selector: string) => click(page, selector) }],
    ['didomi', { ...common, window_globals: facts.globals, surfaces: DIDOMI_STANDARD_ROOTS.map((selector) => ({ selector, visible: Boolean(observation(facts, selector)?.visible) })), controls: [], public_methods: facts.globals.includes('Didomi') ? ['setUserDisagreeToAll'] : [], runtime: null, invoke_control: (selector: string) => click(page, selector), invoke_public_method: (method: string) => page.evaluate((name) => { const api = (window as any).Didomi; if (typeof api?.[name] !== 'function') return false; api[name](); return true; }, method).catch(() => false) }],
    ['cookieyes', { ...common, runtime_functions: facts.globals.includes('CookieYes') ? ['performBannerAction', 'getCkyConsent'] : [], surfaces: [{ selector: COOKIEYES_STANDARD_ROOT, visible: Boolean(observation(facts, COOKIEYES_STANDARD_ROOT)?.visible) }], controls: Object.values(COOKIEYES_STABLE_CONTROLS).map((selector) => control(facts, selector)), consent: facts.cookieyes, persistence: storage(facts), invoke_control: (selector: string) => click(page, selector), invoke_public_action: (action: string) => page.evaluate((value) => { const fn = (window as any).performBannerAction; if (typeof fn !== 'function') return false; fn(value); return true; }, action).catch(() => false) }],
    ['sourcepoint', { ...common, window_globals: facts.globals, surfaces: [], controls: [], active_surface: null, storage: storage(facts) }]
  ]);
}

export function buildShopifyCustomerPrivacyContext(facts: BrowserConsentFacts) { return facts.shopify; }

/**
 * The page bridge extracts only the fields the framework observer consumes;
 * framework lifecycle interpretation remains in framework-observers.ts.
 */
export async function observeConsentFrameworksInPage(page: Page): Promise<ConsentFrameworkObservations> {
  const captured = await page.evaluate(() => {
    const w = window as any;
    const booleanSummary = (value: unknown) => {
      const entries = value && typeof value === 'object' ? Object.values(value as Record<string, unknown>) : [];
      return { total: entries.filter((item) => item === true || item === false).length, granted: entries.filter((item) => item === true).length, denied: entries.filter((item) => item === false).length };
    };
    const tcf = { present: typeof w.__tcfapi === 'function', ping: null as Record<string, unknown> | null, event: null as Record<string, unknown> | null };
    const gpp = { present: typeof w.__gpp === 'function', ping: null as Record<string, unknown> | null, event: null as Record<string, unknown> | null };
    try { if (tcf.present) w.__tcfapi('ping', 2, (value: any) => { tcf.ping = value && typeof value === 'object' ? { cmpLoaded: value.cmpLoaded, apiVersion: value.apiVersion, gdprApplies: value.gdprApplies } : null; }); } catch { /* Observer maps failures conservatively. */ }
    try { if (tcf.present) w.__tcfapi('addEventListener', 2, (value: any) => { tcf.event = value && typeof value === 'object' ? { listenerId: value.listenerId, eventStatus: value.eventStatus, cmpId: value.cmpId, cmpVersion: value.cmpVersion, gdprApplies: value.gdprApplies, purpose: { consents: booleanSummary(value.purpose?.consents) }, vendor: { consents: booleanSummary(value.vendor?.consents) } } : null; }); } catch { /* Observer maps failures conservatively. */ }
    try { if (gpp.present) w.__gpp('ping', (value: any) => { gpp.ping = value && typeof value === 'object' ? { gppVersion: value.gppVersion, cmpStatus: value.cmpStatus, cmpDisplayStatus: value.cmpDisplayStatus, signalStatus: value.signalStatus, cmpId: value.cmpId, supportedAPIs: value.supportedAPIs, sectionList: value.sectionList, applicableSections: value.applicableSections } : null; }); } catch { /* Observer maps failures conservatively. */ }
    try { if (gpp.present) w.__gpp('addEventListener', (value: any) => { const ping = value?.pingData; gpp.event = ping && typeof ping === 'object' ? { pingData: { gppVersion: ping.gppVersion, cmpStatus: ping.cmpStatus, cmpDisplayStatus: ping.cmpDisplayStatus, signalStatus: ping.signalStatus, cmpId: ping.cmpId, supportedAPIs: ping.supportedAPIs, sectionList: ping.sectionList, applicableSections: ping.applicableSections }, listenerId: value.listenerId } : null; }); } catch { /* Observer maps failures conservatively. */ }
    return { tcf, gpp, usp: typeof w.__uspapi === 'function' };
  });
  const runtime = {
    __tcfapi: captured.tcf.present ? ((command: string, _version: number, callback: (payload: unknown, success?: boolean) => void) => {
      if (command === 'ping') callback(captured.tcf.ping, Boolean(captured.tcf.ping));
      if (command === 'addEventListener' && captured.tcf.event) callback(captured.tcf.event, true);
    }) : undefined,
    __gpp: captured.gpp.present ? ((command: string, callback: (payload: unknown, success?: boolean) => void) => {
      if (command === 'ping') callback(captured.gpp.ping, Boolean(captured.gpp.ping));
      if (command === 'addEventListener' && captured.gpp.event) callback(captured.gpp.event, true);
    }) : undefined,
    __uspapi: captured.usp ? (() => undefined) : undefined
  };
  const observers = observeConsentFrameworks(runtime);
  const result = { tcf: observers.tcf.state, gpp: observers.gpp.state, usp: observers.usp };
  observers.tcf.stop(); observers.gpp.stop();
  return result;
}

export function buildPersistenceStorage(facts: BrowserConsentFacts) {
  return storage(facts).filter((entry) => /consent|cookie|privacy|ucdata|ucstring|didomi/i.test(entry.key_name)).slice(0, 20).map((entry) => ({ ...entry, domain: null, path: null, expiry_class: 'unknown' as const, secure: null, http_only: null, same_site: null }));
}
