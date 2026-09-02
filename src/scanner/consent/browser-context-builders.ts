import type { Page } from 'playwright-core';
import type { CmpAdapterProviderId } from './adapter-registry';
import { ONETRUST_DOCUMENTED_CONTROLS, ONETRUST_STANDARD_ROOTS } from './onetrust-adapter';
import { COOKIEBOT_STANDARD_CONTROLS, COOKIEBOT_STANDARD_ROOT } from './cookiebot-adapter';
import { USERCENTRICS_STANDARD_ROOT } from './usercentrics-adapter';
import { DIDOMI_STANDARD_ROOTS } from './didomi-adapter';
import { COOKIEYES_STANDARD_ROOT, COOKIEYES_STABLE_CONTROLS } from './cookieyes-adapter';
import { observeConsentFrameworks, tcfAggregateDecision, type ConsentFrameworkObservations } from './framework-observers';
import { semanticActionForConsentLabel } from './generic-consent-detector';

export interface BrowserActionTarget {
  action: string;
  category: string | null;
  target_ref: string | null;
  surface_type: 'banner' | 'dialog' | 'drawer' | 'preference_center';
  frame_path: string[];
  shadow_mode: 'none' | 'open' | 'closed' | 'unknown';
  accessible_control: boolean;
  attached: boolean;
  visible: boolean;
  enabled: boolean;
}

type TargetContext = { action_targets?: readonly BrowserActionTarget[] };

/** Transient target descriptors are browser-bridge facts, never persisted selectors. */
export function actionTargetFor(context: unknown, action: string, category: string | null = null) {
  const targets = (context && typeof context === 'object' ? context as TargetContext : {}).action_targets || [];
  return targets.find((target) => target.action === action && target.category === category) || null;
}

type DomObservation = { selector: string; visible: boolean; enabled: boolean; text: string };

export interface BrowserConsentFacts {
  globals: string[];
  assets: string[];
  cookie_names: string[];
  storage_keys: string[];
  observations: DomObservation[];
  cookiebot: Record<string, unknown> | null;
  cookieyes: Record<string, unknown> | null;
  onetrust: { active_group_ids: string[]; provider_events: string[] } | null;
  onetrust_public_methods: string[];
  cookieyes_runtime_functions: string[];
  didomi: Record<string, unknown> | null;
  provider_events: string[];
  shopify: Record<string, unknown> | null;
  consent_commands: Array<{ command: 'default' | 'update'; state: Record<string, unknown>; timestamp?: number }>;
  generic: {
    surfaces: Array<{ id: string; surface_type: 'banner' | 'dialog' | 'drawer'; visible: boolean; privacy_or_cookie_semantics: boolean; intent: string }>;
    controls: Array<{ surface_id: string; visible: boolean; enabled: boolean; actionable: boolean; accessible_name: string }>;
  };
  usercentrics: {
    visible: boolean;
    shadow_mode: 'open' | 'closed' | 'none';
    controls: Array<{ id: string; accessible_name: string; visible: boolean; enabled: boolean }>;
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
const PROVIDER_EVENT_OBSERVATIONS_KEY = '__upsightConsentProviderEventObservations';
const FRAMEWORK_OBSERVATIONS_KEY = '__upsightConsentFrameworkObservations';

/**
 * Installs a narrowly-scoped, pre-navigation dataLayer observer. It only
 * records consent default/update commands and delegates every array push to
 * the site's original implementation unchanged.
 */
export async function installConsentCommandBootstrap(page: Page) {
  await page.context().addInitScript(({ key, providerKey, frameworkKey }) => {
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
    const providerEvents: string[] = Array.isArray(w[providerKey]) ? w[providerKey] : [];
    w[providerKey] = providerEvents;
    for (const eventName of ['OneTrustGroupsUpdated', 'OTConsentApplied', 'consent.changed', 'preferences.clickdisagreetoall', 'notice.clickdisagree']) {
      window.addEventListener(eventName, () => { if (!providerEvents.includes(eventName) && providerEvents.length < 20) providerEvents.push(eventName); });
    }
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
    // This page-lifetime bridge deliberately keeps only normalized framework
    // aggregates. It is installed before navigation so delayed CMP callbacks
    // are buffered instead of being sampled by a single evaluate call.
    const countBooleans = (value: unknown) => {
      const entries = value && typeof value === 'object' ? Object.values(value as Record<string, unknown>) : [];
      const granted = entries.filter((item) => item === true).length;
      const denied = entries.filter((item) => item === false).length;
      return { total_count: granted + denied, granted_count: granted, denied_count: denied };
    };
    const framework = w[frameworkKey] && typeof w[frameworkKey] === 'object' ? w[frameworkKey] : {
      tcf: { present: false, ping: null, latest_event: null, event_count: 0, listener_id: null, registered: false },
      gpp: { present: false, ping: null, latest_event: null, event_count: 0, listener_id: null, registered: false },
      usp_present: false
    };
    w[frameworkKey] = framework;
    const tcfPing = (value: any) => value && typeof value === 'object' ? { cmpLoaded: value.cmpLoaded === true ? true : value.cmpLoaded === false ? false : null, apiVersion: typeof value.apiVersion === 'string' ? value.apiVersion.slice(0, 16) : null, gdprApplies: value.gdprApplies === true ? true : value.gdprApplies === false ? false : null } : null;
    const tcfEvent = (value: any) => value && typeof value === 'object' ? { eventStatus: typeof value.eventStatus === 'string' ? value.eventStatus.slice(0, 32) : null, gdprApplies: value.gdprApplies === true ? true : value.gdprApplies === false ? false : null, purpose: { consents: countBooleans(value.purpose?.consents) }, vendor: { consents: countBooleans(value.vendor?.consents) } } : null;
    const gppPing = (value: any) => value && typeof value === 'object' ? { gppVersion: typeof value.gppVersion === 'string' ? value.gppVersion.slice(0, 16) : null, cmpStatus: typeof value.cmpStatus === 'string' ? value.cmpStatus.slice(0, 32) : null, cmpDisplayStatus: typeof value.cmpDisplayStatus === 'string' ? value.cmpDisplayStatus.slice(0, 32) : null, signalStatus: typeof value.signalStatus === 'string' ? value.signalStatus.slice(0, 32) : null, supportedAPIs: Array.isArray(value.supportedAPIs) ? value.supportedAPIs.filter((item: unknown) => typeof item === 'string').slice(0, 50) : [], sectionList: Array.isArray(value.sectionList) ? value.sectionList.filter((item: unknown) => Number.isInteger(item)).slice(0, 50) : [], applicableSections: Array.isArray(value.applicableSections) ? value.applicableSections.filter((item: unknown) => Number.isInteger(item)).slice(0, 50) : [] } : null;
    const installFrameworkListeners = () => {
      framework.usp_present ||= typeof w.__uspapi === 'function';
      if (typeof w.__tcfapi === 'function' && !framework.tcf.registered) {
        framework.tcf.present = true;
        try {
          w.__tcfapi('ping', 2, (value: any) => { framework.tcf.ping = tcfPing(value); });
          w.__tcfapi('addEventListener', 2, (value: any) => {
            if (!value || typeof value !== 'object') return;
            framework.tcf.listener_id ??= typeof value.listenerId === 'number' || typeof value.listenerId === 'string' ? value.listenerId : null;
            const event = tcfEvent(value); if (!event) return;
            framework.tcf.latest_event = event;
            framework.tcf.event_count = Math.min(100, framework.tcf.event_count + 1);
          });
          framework.tcf.registered = true;
        } catch { framework.tcf.present = true; }
      }
      if (typeof w.__gpp === 'function' && !framework.gpp.registered) {
        framework.gpp.present = true;
        try {
          w.__gpp('ping', (value: any) => { framework.gpp.ping = gppPing(value); });
          w.__gpp('addEventListener', (value: any) => {
            if (!value || typeof value !== 'object') return;
            framework.gpp.listener_id ??= typeof value.listenerId === 'number' || typeof value.listenerId === 'string' ? value.listenerId : null;
            const ping = gppPing(value.pingData); if (!ping) return;
            framework.gpp.latest_event = ping; framework.gpp.ping = ping;
            framework.gpp.event_count = Math.min(100, framework.gpp.event_count + 1);
          });
          framework.gpp.registered = true;
        } catch { framework.gpp.present = true; }
      }
    };
    const poll = window.setInterval(installFrameworkListeners, 50);
    window.setTimeout(() => window.clearInterval(poll), 10_000);
    window.addEventListener('pagehide', () => {
      try { if (framework.tcf.listener_id !== null && typeof w.__tcfapi === 'function') w.__tcfapi('removeEventListener', 2, () => {}, framework.tcf.listener_id); } catch { /* Best effort cleanup. */ }
      try { if (framework.gpp.listener_id !== null && typeof w.__gpp === 'function') w.__gpp('removeEventListener', () => {}, framework.gpp.listener_id); } catch { /* Best effort cleanup. */ }
      window.clearInterval(poll);
    }, { once: true });
    installFrameworkListeners();
  }, { key: CONSENT_COMMAND_OBSERVATIONS_KEY, providerKey: PROVIDER_EVENT_OBSERVATIONS_KEY, frameworkKey: FRAMEWORK_OBSERVATIONS_KEY });
}

/** Captures normalized, bounded browser facts. Provider interpretation remains in adapters. */
export async function captureBrowserConsentFacts(page: Page): Promise<BrowserConsentFacts> {
  const facts = await page.evaluate(({ globals, selectors, consentCommandKey, providerEventKey }) => {
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
      const intent = /newsletter/.test(text) ? 'newsletter'
        : /email (?:address|updates|signup|sign up)|subscribe/.test(text) ? 'email_capture'
          : /sign in|log in/.test(text) ? 'login'
            : /create account|register/.test(text) ? 'account_creation'
              : /age gate|confirm (?:your )?age|are you (?:18|21)/.test(text) ? 'age_gate'
                : /country|region selector/.test(text) ? 'country_selector'
                  : /location selector|choose (?:your )?location/.test(text) ? 'location_selector'
                    : /currency selector|choose (?:your )?currency/.test(text) ? 'currency_selector'
                      : /privacy policy/.test(text) && !/reject|decline|manage preferences|cookie settings/.test(text) ? 'privacy_policy_only'
                        : /privacy notice|we value your privacy/.test(text) && !/reject|decline|manage preferences|cookie settings/.test(text) ? 'ordinary_notice'
                          : /cookie|consent|privacy|tracking/.test(text) ? 'consent' : 'unknown';
      return { id: `surface-${index}`, surface_type: surface.getAttribute('role') === 'dialog' || surface.getAttribute('aria-modal') === 'true' ? 'dialog' : 'banner', visible: visible(surface), privacy_or_cookie_semantics: /cookie|consent|privacy|tracking/.test(text), intent };
    }), controls: genericSurfaces.flatMap((surface, index) => controls(surface).map((control) => ({ ...control, surface_id: `surface-${index}` }))) };
    const cb = w.Cookiebot;
    const cookiebot = cb ? { has_response: typeof cb.hasResponse === 'boolean' ? cb.hasResponse : null, consented: typeof cb.consented === 'boolean' ? cb.consented : null, declined: typeof cb.declined === 'boolean' ? cb.declined : null, consent: cb.consent ? { preferences: typeof cb.consent.preferences === 'boolean' ? cb.consent.preferences : null, statistics: typeof cb.consent.statistics === 'boolean' ? cb.consent.statistics : null, marketing: typeof cb.consent.marketing === 'boolean' ? cb.consent.marketing : null } : null } : null;
    let cookieyes: Record<string, unknown> | null = null;
    try { const raw = typeof w.getCkyConsent === 'function' ? w.getCkyConsent() : null; const categories = raw?.categories || raw; cookieyes = categories ? { categories: { analytics: typeof categories.analytics === 'boolean' ? categories.analytics : null, advertisement: typeof categories.advertisement === 'boolean' ? categories.advertisement : null, performance: typeof categories.performance === 'boolean' ? categories.performance : null, functional: typeof categories.functional === 'boolean' ? categories.functional : null }, is_user_action_completed: typeof raw?.isUserActionCompleted === 'boolean' ? raw.isUserActionCompleted : null } : null; } catch { /* Runtime access is optional. */ }
    const onetrust = { active_group_ids: typeof w.OnetrustActiveGroups === 'string' ? w.OnetrustActiveGroups.split(',').filter((value: string) => /^[A-Za-z0-9_-]{1,80}$/.test(value)).slice(0, 200) : [], provider_events: Array.isArray(w[providerEventKey]) ? w[providerEventKey].filter((value: unknown) => value === 'OneTrustGroupsUpdated' || value === 'OTConsentApplied').slice(0, 20) : [] };
    const onetrust_public_methods = ['AllowAll', 'RejectAll', 'ToggleInfoDisplay'].filter((name) => typeof w.OneTrust?.[name] === 'function');
    const cookieyes_runtime_functions = ['performBannerAction', 'getCkyConsent'].filter((name) => typeof w[name] === 'function');
    const didomiStatus = () => {
      try {
        const status = typeof w.Didomi?.getCurrentUserStatus === 'function' ? w.Didomi.getCurrentUserStatus() : null;
        let enabled = 0; let disabled = 0;
        const visit = (value: unknown, depth = 0) => { if (depth > 5 || value === null || value === undefined) return; if (value === true) { enabled += 1; return; } if (value === false) { disabled += 1; return; } if (typeof value === 'object') Object.values(value as Record<string, unknown>).slice(0, 200).forEach((item) => visit(item, depth + 1)); };
        visit(status?.purposes || status?.purpose || status);
        const total = enabled + disabled; const decision = total === 0 ? 'ambiguous' : disabled === total ? 'rejected' : enabled === total ? 'accepted' : 'partial';
        return { current_user_status: { decision, enabled_purpose_count: Math.min(enabled, 200), disabled_purpose_count: Math.min(disabled, 200) }, notice_visible: typeof w.Didomi?.notice?.isVisible === 'function' ? Boolean(w.Didomi.notice.isVisible()) : null, public_methods: ['getCurrentUserStatus', 'setUserAgreeToAll', 'setUserDisagreeToAll'].filter((name) => typeof w.Didomi?.[name] === 'function') };
      } catch { return { current_user_status: null, notice_visible: null, public_methods: [] }; }
    };
    const didomi = didomiStatus();
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
    return { globals: globals.filter((name) => Boolean(w[name])), assets: Array.from(document.scripts).map((script) => script.src).filter(Boolean).slice(0, 200), cookie_names: cookieNames, storage_keys: storageKeys, observations: selectors.map((selector) => { const element = document.querySelector(selector) as HTMLButtonElement | null; return element ? { selector, visible: visible(element), enabled: !element.disabled, text: String(element.getAttribute('aria-label') || element.textContent || '').slice(0, 120) } : null; }).filter(Boolean), cookiebot, cookieyes, onetrust, onetrust_public_methods, cookieyes_runtime_functions, didomi, provider_events: Array.isArray(w[providerEventKey]) ? w[providerEventKey].filter((value: unknown) => typeof value === 'string').slice(0, 20) : [], shopify, consent_commands: commands, generic };
  }, { globals: PROVIDER_GLOBALS, selectors: DOM_SELECTORS, consentCommandKey: CONSENT_COMMAND_OBSERVATIONS_KEY, providerEventKey: PROVIDER_EVENT_OBSERVATIONS_KEY }) as Omit<BrowserConsentFacts, 'usercentrics'>;
  const usercentrics = await page.evaluate((rootSelector) => {
    const root = document.querySelector(rootSelector) as HTMLElement | null;
    if (!root) return { visible: false, shadow_mode: 'none' as const, controls: [] };
    const style = getComputedStyle(root); const box = root.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    const shadow = root.shadowRoot;
    if (!shadow) return { visible, shadow_mode: 'closed' as const, controls: [] };
    return {
      visible,
      shadow_mode: 'open' as const,
      controls: Array.from(shadow.querySelectorAll('button, [role="button"], a')).slice(0, 30).map((element, index) => ({
        id: `${rootSelector} button:nth-of-type(${index + 1})`,
        accessible_name: String((element as HTMLElement).getAttribute('aria-label') || element.textContent || '').slice(0, 120),
        visible: true,
        enabled: !(element as HTMLButtonElement).disabled
      }))
    };
  }, USERCENTRICS_STANDARD_ROOT);
  return { ...facts, usercentrics };
}

const observation = (facts: BrowserConsentFacts, selector: string) => facts.observations.find((item) => item.selector === selector);
const control = (facts: BrowserConsentFacts, selector: string, within = true) => ({ selector, id: selector, visible: Boolean(observation(facts, selector)?.visible), enabled: Boolean(observation(facts, selector)?.enabled), actionable: Boolean(observation(facts, selector)?.visible && observation(facts, selector)?.enabled), within_confirmed_cookiebot_surface: within, within_confirmed_cookieyes_surface: within, within_confirmed_usercentrics_surface: within });
const storage = (facts: BrowserConsentFacts) => [...facts.cookie_names.map((key_name) => ({ key_name, name: key_name, storage_type: 'cookie' as const, exists: true })), ...facts.storage_keys.map((key_name) => ({ key_name, name: key_name, storage_type: 'local_storage' as const, exists: true }))];
const click = (page: Page, selector: string) => page.locator(selector).first().click().then(() => true).catch(() => false);
const documentTarget = (action: string, selector: string, item: ReturnType<typeof control>, surface_type: BrowserActionTarget['surface_type'] = 'banner'): BrowserActionTarget => ({ action, category: null, target_ref: `dom:${selector}`, surface_type, frame_path: ['top'], shadow_mode: 'none', accessible_control: true, attached: true, visible: item.visible, enabled: item.enabled });
const sourcepointAction = (actionClass: string) => actionClass === 'sp_choice_type_13' || actionClass === 'sp_choice_type_REJECT_ALL' ? 'reject_all' : actionClass === 'sp_choice_type_12' ? 'open_preferences' : actionClass === 'sp_choice_type_SAVE_AND_EXIT' ? 'save_preferences' : actionClass.includes('ACCEPT') || actionClass === 'sp_choice_type_11' ? 'accept_all' : null;

type SourcepointFrameFacts = {
  surfaces: Array<{ selector: string; surface: 'first_layer' | 'privacy_manager'; frame_path: string[]; frame_attached: boolean; visible: boolean }>;
  controls: Array<{ action_class: 'sp_choice_type_11' | 'sp_choice_type_12' | 'sp_choice_type_13' | 'sp_choice_type_ACCEPT_ALL' | 'sp_choice_type_REJECT_ALL' | 'sp_choice_type_SAVE_AND_EXIT'; surface: 'first_layer' | 'privacy_manager'; frame_path: string[]; frame_attached: boolean; visible: boolean; enabled: boolean; actionable: boolean; within_confirmed_sourcepoint_surface: boolean }>;
  invoke(actionClass: string, framePath: readonly string[]): Promise<boolean>;
};

/** Reads Sourcepoint's public iframe surface through Playwright, including cross-origin frames. */
async function captureSourcepointFrameFacts(page: Page): Promise<SourcepointFrameFacts> {
  const surfaces: SourcepointFrameFacts['surfaces'] = [];
  const controls: SourcepointFrameFacts['controls'] = [];
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  const frameByPath = new Map<string, typeof frames[number]>();
  for (const [index, frame] of frames.entries()) {
    const frameElement = await frame.frameElement().catch(() => null);
    const id = frameElement ? await frameElement.getAttribute('id').catch(() => null) : null;
    if (!id || !/^sp_message_(?:container|iframe)_[A-Za-z0-9_-]+$/i.test(id)) continue;
    const framePath = ['top', `iframe#${id}`];
    frameByPath.set(framePath.join('>'), frame);
    const visible = frameElement ? await frameElement.isVisible().catch(() => false) : false;
    const hasPrivacyManager = await frame.locator('.sp_choice_type_REJECT_ALL, .sp_choice_type_SAVE_AND_EXIT').count().then(Boolean).catch(() => false);
    const surface = hasPrivacyManager ? 'privacy_manager' as const : 'first_layer' as const;
    surfaces.push({ selector: `#${id}`, surface, frame_path: framePath, frame_attached: true, visible });
    for (const actionClass of ['sp_choice_type_11', 'sp_choice_type_12', 'sp_choice_type_13', 'sp_choice_type_ACCEPT_ALL', 'sp_choice_type_REJECT_ALL', 'sp_choice_type_SAVE_AND_EXIT'] as const) {
      const target = frame.locator(`.${actionClass}`).first();
      if (!await target.count()) continue;
      const controlSurface = actionClass.includes('REJECT_ALL') || actionClass.includes('ACCEPT_ALL') || actionClass.includes('SAVE_AND_EXIT') ? 'privacy_manager' as const : 'first_layer' as const;
      controls.push({ action_class: actionClass, surface: controlSurface, frame_path: framePath, frame_attached: true, visible: await target.isVisible().catch(() => false), enabled: await target.isEnabled().catch(() => false), actionable: true, within_confirmed_sourcepoint_surface: true });
    }
  }
  return {
    surfaces,
    controls,
    async invoke(actionClass, framePath) {
       const frame = frameByPath.get([...framePath].join('>'));
      if (!frame) return false;
      return frame.locator(`.${actionClass}`).first().click().then(() => true).catch(() => false);
    }
  };
}

/** Builds transient adapter contexts; the adapters retain all provider semantics. */
export async function buildProviderContexts(page: Page, facts: BrowserConsentFacts, framework: ConsentFrameworkObservations) {
  const common = { asset_urls: facts.assets, cookies: facts.cookie_names.map((name) => ({ name, exists: true })), storage: storage(facts), tcf_active: framework.tcf.lifecycle !== 'absent', gpp_active: framework.gpp.lifecycle !== 'absent' };
  const tcf = framework.tcf.latest_event;
  const sourcepointFramework = { tcf_present: framework.tcf.lifecycle !== 'absent', tcf_event_status: tcf?.event_status || undefined, tcf_purpose_decision: tcf ? tcfAggregateDecision(tcf.purpose_consents) : undefined, tcf_vendor_decision: tcf ? tcfAggregateDecision(tcf.vendor_consents) : undefined, gpp_present: framework.gpp.lifecycle !== 'absent' };
  const sourcepoint = await captureSourcepointFrameFacts(page);
  return new Map<CmpAdapterProviderId, unknown>([
    ['onetrust', { ...common, window_globals: facts.globals, surfaces: ONETRUST_STANDARD_ROOTS.map((selector) => ({ selector, visible: Boolean(observation(facts, selector)?.visible) })), controls: Object.values(ONETRUST_DOCUMENTED_CONTROLS).map((selector) => control(facts, selector)), action_targets: [documentTarget('accept_all', ONETRUST_DOCUMENTED_CONTROLS.accept, control(facts, ONETRUST_DOCUMENTED_CONTROLS.accept)), documentTarget('reject_all', ONETRUST_DOCUMENTED_CONTROLS.reject, control(facts, ONETRUST_DOCUMENTED_CONTROLS.reject)), documentTarget('open_preferences', ONETRUST_DOCUMENTED_CONTROLS.preferences, control(facts, ONETRUST_DOCUMENTED_CONTROLS.preferences))], public_methods: facts.onetrust_public_methods, active_group_ids: facts.onetrust?.active_group_ids, provider_events: facts.onetrust?.provider_events, invoke_control: (selector: string) => click(page, selector), invoke_public_method: (method: string) => page.evaluate((name) => { const api = (window as any).OneTrust; if (typeof api?.[name] !== 'function') return false; api[name](); return true; }, method).catch(() => false) }],
    ['cookiebot', { ...common, window_globals: facts.globals, surfaces: [{ selector: COOKIEBOT_STANDARD_ROOT, visible: Boolean(observation(facts, COOKIEBOT_STANDARD_ROOT)?.visible) }], controls: Object.values(COOKIEBOT_STANDARD_CONTROLS).map((selector) => control(facts, selector)), action_targets: [documentTarget('accept_all', COOKIEBOT_STANDARD_CONTROLS.accept, control(facts, COOKIEBOT_STANDARD_CONTROLS.accept)), documentTarget('reject_all', COOKIEBOT_STANDARD_CONTROLS.decline, control(facts, COOKIEBOT_STANDARD_CONTROLS.decline)), documentTarget('reject_all', COOKIEBOT_STANDARD_CONTROLS.level_decline_all, control(facts, COOKIEBOT_STANDARD_CONTROLS.level_decline_all), 'preference_center'), documentTarget('open_preferences', COOKIEBOT_STANDARD_CONTROLS.preferences, control(facts, COOKIEBOT_STANDARD_CONTROLS.preferences))], runtime: facts.cookiebot, invoke_control: (selector: string) => click(page, selector) }],
    ['usercentrics', { ...common, uc_ui_type: facts.globals.includes('UC_UI') ? 'object' : 'undefined', surfaces: [{ selector: USERCENTRICS_STANDARD_ROOT, visible: facts.usercentrics.visible, shadow_mode: facts.usercentrics.shadow_mode }], controls: facts.usercentrics.controls.map((item) => ({ id: item.id, semantic_action: semanticActionForConsentLabel(item.accessible_name), visible: item.visible, enabled: item.enabled, actionable: item.visible && item.enabled, within_confirmed_usercentrics_surface: true, role: 'button' as const })).filter((item): item is { id: string; semantic_action: 'accept_all' | 'reject_all' | 'open_preferences'; visible: boolean; enabled: boolean; actionable: boolean; within_confirmed_usercentrics_surface: true; role: 'button' } => item.semantic_action === 'accept_all' || item.semantic_action === 'reject_all' || item.semantic_action === 'open_preferences'), action_targets: facts.usercentrics.controls.flatMap((item) => { const action = semanticActionForConsentLabel(item.accessible_name); return action ? [{ action: action as string, category: null, target_ref: `shadow:${item.id}`, surface_type: 'dialog' as const, frame_path: ['top'], shadow_mode: facts.usercentrics.shadow_mode, accessible_control: true, attached: facts.usercentrics.shadow_mode === 'open', visible: item.visible, enabled: item.enabled } satisfies BrowserActionTarget] : []; }), legacy_globals: facts.globals, invoke_control: (selector: string) => click(page, selector) }],
    ['didomi', { ...common, window_globals: facts.globals, surfaces: DIDOMI_STANDARD_ROOTS.map((selector) => ({ selector, visible: Boolean(observation(facts, selector)?.visible) })), controls: [], public_methods: Array.isArray(facts.didomi?.public_methods) ? facts.didomi.public_methods : [], runtime: facts.didomi, provider_events: facts.provider_events, invoke_control: (selector: string) => click(page, selector), invoke_public_method: (method: string) => page.evaluate((name) => { const api = (window as any).Didomi; if (typeof api?.[name] !== 'function') return false; api[name](); return true; }, method).catch(() => false) }],
    ['cookieyes', { ...common, runtime_functions: facts.cookieyes_runtime_functions, surfaces: [{ selector: COOKIEYES_STANDARD_ROOT, visible: Boolean(observation(facts, COOKIEYES_STANDARD_ROOT)?.visible) }], controls: Object.values(COOKIEYES_STABLE_CONTROLS).map((selector) => control(facts, selector)), action_targets: [documentTarget('accept_all', COOKIEYES_STABLE_CONTROLS.accept, control(facts, COOKIEYES_STABLE_CONTROLS.accept)), documentTarget('reject_all', COOKIEYES_STABLE_CONTROLS.reject, control(facts, COOKIEYES_STABLE_CONTROLS.reject)), documentTarget('open_preferences', COOKIEYES_STABLE_CONTROLS.customize, control(facts, COOKIEYES_STABLE_CONTROLS.customize))], consent: facts.cookieyes, persistence: storage(facts), invoke_control: (selector: string) => click(page, selector), invoke_public_action: (action: string) => page.evaluate((value) => { const fn = (window as any).performBannerAction; if (typeof fn !== 'function') return false; fn(value); return true; }, action).catch(() => false) }],
    ['sourcepoint', { ...common, window_globals: facts.globals, surfaces: sourcepoint.surfaces, controls: sourcepoint.controls, action_targets: sourcepoint.controls.flatMap((control) => { const action = sourcepointAction(control.action_class); return action ? [{ action, category: null, target_ref: `frame:${control.frame_path.join('>')}:${control.action_class}`, surface_type: control.surface === 'privacy_manager' ? 'preference_center' as const : 'dialog' as const, frame_path: [...control.frame_path], shadow_mode: 'none' as const, accessible_control: true, attached: control.frame_attached, visible: control.visible, enabled: control.enabled }] : []; }), active_surface: sourcepoint.surfaces.find((item) => item.visible)?.surface || null, framework: sourcepointFramework, storage: storage(facts), invoke_control: sourcepoint.invoke }]
  ]);
}

export function buildShopifyCustomerPrivacyContext(facts: BrowserConsentFacts) { return facts.shopify; }

/**
 * The page bridge extracts only the fields the framework observer consumes;
 * framework lifecycle interpretation remains in framework-observers.ts.
 */
export async function observeConsentFrameworksInPage(page: Page): Promise<ConsentFrameworkObservations> {
  const readBridge = () => page.evaluate((frameworkKey) => {
    const w = window as any;
    const state = w[frameworkKey] && typeof w[frameworkKey] === 'object' ? w[frameworkKey] : null;
    return state ? { tcf: { ...state.tcf, present: state.tcf?.present === true || typeof w.__tcfapi === 'function' }, gpp: { ...state.gpp, present: state.gpp?.present === true || typeof w.__gpp === 'function' }, usp: state.usp_present === true || typeof w.__uspapi === 'function' } : { tcf: { present: typeof w.__tcfapi === 'function', ping: null, latest_event: null, event_count: 0 }, gpp: { present: typeof w.__gpp === 'function', ping: null, latest_event: null, event_count: 0 }, usp: typeof w.__uspapi === 'function' };
  }, FRAMEWORK_OBSERVATIONS_KEY);
  let captured = await readBridge();
  // The bridge is already observing for the page lifetime. Only a framework
  // that is present but has not replied gets this short bounded chance to
  // deliver its delayed ping/listener callback.
  const awaitingCallback = (captured.tcf.present && !captured.tcf.ping && !captured.tcf.latest_event) || (captured.gpp.present && !captured.gpp.ping && !captured.gpp.latest_event);
  if (awaitingCallback) {
    await page.waitForFunction((frameworkKey) => {
      const state = (window as any)[frameworkKey];
      return Boolean(state && ((state.tcf?.ping || state.tcf?.latest_event) || (state.gpp?.ping || state.gpp?.latest_event)));
    }, FRAMEWORK_OBSERVATIONS_KEY, { timeout: 350 }).catch(() => undefined);
    captured = await readBridge();
  }
  const runtime = {
    __tcfapi: captured.tcf.present ? ((command: string, _version: number, callback: (payload: unknown, success?: boolean) => void) => {
      if (command === 'ping') callback(captured.tcf.ping, Boolean(captured.tcf.ping));
      if (command === 'addEventListener' && captured.tcf.latest_event) callback(captured.tcf.latest_event, true);
    }) : undefined,
    __gpp: captured.gpp.present ? ((command: string, callback: (payload: unknown, success?: boolean) => void) => {
      if (command === 'ping') callback(captured.gpp.ping, Boolean(captured.gpp.ping));
      if (command === 'addEventListener' && captured.gpp.latest_event) callback({ pingData: captured.gpp.latest_event }, true);
    }) : undefined,
    __uspapi: captured.usp ? (() => undefined) : undefined
  };
  const observers = observeConsentFrameworks(runtime);
  const result = { tcf: { ...observers.tcf.state, event_count: Math.max(0, Number(captured.tcf?.event_count) || 0) }, gpp: { ...observers.gpp.state, event_count: Math.max(0, Number(captured.gpp?.event_count) || 0) }, usp: observers.usp };
  observers.tcf.stop(); observers.gpp.stop();
  return result;
}

export function buildPersistenceStorage(facts: BrowserConsentFacts) {
  return storage(facts).filter((entry) => /consent|cookie|privacy|ucdata|ucstring|didomi/i.test(entry.key_name)).slice(0, 20).map((entry) => ({ ...entry, domain: null, path: null, expiry_class: 'unknown' as const, secure: null, http_only: null, same_site: null }));
}
