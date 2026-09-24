import type { BrowserContext, Page } from 'playwright-core';
import type { CmpAdapterProviderId } from './adapter-registry';
import { ONETRUST_DOCUMENTED_CONTROLS, ONETRUST_STANDARD_ROOTS } from './onetrust-adapter';
import { COOKIEBOT_STANDARD_CONTROLS, COOKIEBOT_STANDARD_ROOT } from './cookiebot-adapter';
import { USERCENTRICS_STANDARD_ROOT } from './usercentrics-adapter';
import { DIDOMI_STANDARD_ROOTS } from './didomi-adapter';
import { COOKIEYES_STANDARD_ROOT, COOKIEYES_STABLE_CONTROLS } from './cookieyes-adapter';
import { observeConsentFrameworks, tcfAggregateDecision, type ConsentFrameworkObservations } from './framework-observers';
import { semanticActionForConsentLabel } from './generic-consent-detector';
import type { ProviderSemanticDiscovery } from './provider-semantic-controls';
import type { GpcBrowserSignal } from './domain-types';

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
  cookiebot_data_cbid_present: boolean;
  storage_keys: string[];
  observations: DomObservation[];
  cookiebot: Record<string, unknown> | null;
  cookieyes: Record<string, unknown> | null;
  onetrust: { active_group_ids: string[]; provider_events: string[] } | null;
  onetrust_public_methods: string[];
  cookieyes_runtime_functions: string[];
  didomi: Record<string, unknown> | null;
  didomi_controls: Array<{ id: string; accessible_name: string; visible: boolean; enabled: boolean }>;
  provider_events: string[];
  cookiebot_events: string[];
  shopify: Record<string, unknown> | null;
  consent_commands: Array<{ command: 'default' | 'update'; state: Record<string, unknown>; timestamp?: number }>;
  gpc_signal: GpcBrowserSignal;
  gpc_acknowledgement_observed: boolean;
  generic: {
    surfaces: Array<{ id: string; surface_type: 'banner' | 'dialog' | 'drawer'; visible: boolean; privacy_or_cookie_semantics: boolean; intent: string; consent_management_topology: boolean; strong_presentation: boolean; location: 'main_frame' | 'shadow_dom'; shadow_depth: number }>;
    controls: Array<{ id?: string; surface_id: string; visible: boolean; enabled: boolean; actionable: boolean; accessible_name: string; role?: 'button' | 'link' | 'input' | 'other'; direct_actionable_target?: boolean; location: 'main_frame' | 'shadow_dom' | 'child_frame'; shadow_depth: number }>;
  };
  usercentrics: {
    present: boolean;
    visible: boolean;
    shadow_mode: 'open' | 'closed' | 'none';
    controls: Array<{ id: string; accessible_name: string; visible: boolean; enabled: boolean }>;
    lifecycle: { initialized: boolean; latest_view: 'FIRST_LAYER' | 'SECOND_LAYER' | 'NONE' | 'PRIVACY_BUTTON' | null; latest_view_at_ms: number | null; cmp_shown_observed: boolean; cmp_shown_at_ms: number | null; event_count: number };
  };
}

/** Lightweight, transient readiness evidence; it deliberately excludes storage, APIs, and network data. */
export interface ConsentUiProbe {
  strong_visible_surface_count: number;
  visible_semantic_control_count: number;
  open_shadow_roots_observed: number;
  provider_root_visible: boolean;
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
const USERCENTRICS_LIFECYCLE_KEY = '__upsightUsercentricsLifecycle';
const CONSENT_BOOTSTRAPPED_CONTEXTS = new WeakSet<BrowserContext>();

/**
 * Installs a narrowly-scoped, pre-navigation dataLayer observer. It only
 * records consent default/update commands and delegates every array push to
 * the site's original implementation unchanged.
 */
export async function installConsentCommandBootstrap(page: Page) {
  const context = page.context();
  if (CONSENT_BOOTSTRAPPED_CONTEXTS.has(context)) return;
  try {
    await context.addInitScript(({ key, providerKey, frameworkKey, usercentricsKey }) => {
    const w = window as any;
    if (w.__upsightConsentBootstrapInstalled === true) return;
    Object.defineProperty(w, '__upsightConsentBootstrapInstalled', { value: true, configurable: false });
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
    const cookiebotEvents: string[] = Array.isArray(w.__upsightCookiebotEvents) ? w.__upsightCookiebotEvents : [];
    w.__upsightCookiebotEvents = cookiebotEvents;
    const lifecycle = w[usercentricsKey] && typeof w[usercentricsKey] === 'object' ? w[usercentricsKey] : { initialized: false, latest_view: null, latest_view_at_ms: null, cmp_shown_observed: false, cmp_shown_at_ms: null, event_count: 0 };
    w[usercentricsKey] = lifecycle;
    const countLifecycle = () => { lifecycle.event_count = Math.min(20, (Number(lifecycle.event_count) || 0) + 1); };
    window.addEventListener('UC_UI_INITIALIZED', () => { lifecycle.initialized = true; countLifecycle(); });
    window.addEventListener('UC_UI_VIEW_CHANGED', (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!detail || typeof detail !== 'object') return;
      const view = detail.view;
      if (view === 'FIRST_LAYER' || view === 'SECOND_LAYER' || view === 'NONE' || view === 'PRIVACY_BUTTON') { lifecycle.latest_view = view; lifecycle.latest_view_at_ms = Date.now(); countLifecycle(); }
    });
    window.addEventListener('UC_UI_CMP_EVENT', (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail && typeof detail === 'object' && detail.type === 'CMP_SHOWN') { lifecycle.cmp_shown_observed = true; lifecycle.cmp_shown_at_ms = Date.now(); countLifecycle(); }
    });
    for (const eventName of ['OneTrustGroupsUpdated', 'OTConsentApplied', 'consent.changed', 'preferences.clickdisagreetoall', 'notice.clickdisagree', 'CookiebotOnAccept', 'CookiebotOnDecline', 'CookiebotOnDialogDisplay']) {
      window.addEventListener(eventName, () => { if (!providerEvents.includes(eventName) && providerEvents.length < 20) providerEvents.push(eventName); });
    }
    for (const eventName of ['CookiebotOnAccept', 'CookiebotOnDecline', 'CookiebotOnDialogDisplay']) {
      window.addEventListener(eventName, () => { if (cookiebotEvents.length < 20) cookiebotEvents.push(eventName); });
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
      const available = value !== null && typeof value === 'object' && !Array.isArray(value);
      const entries = available ? Object.values(value as Record<string, unknown>) : [];
      const granted = entries.filter((item) => item === true).length;
      const denied = entries.filter((item) => item === false).length;
      return { known: available, total_count: granted + denied, granted_count: granted, denied_count: denied };
    };
    const framework = w[frameworkKey] && typeof w[frameworkKey] === 'object' ? w[frameworkKey] : {
      tcf: { present: false, ping: null, latest_event: null, event_count: 0, listener_id: null, registered: false, listener_registered: false, listener_event_observed: false, listener_registration_failed: false },
      gpp: { present: false, ping: null, latest_event: null, event_count: 0, listener_id: null, registered: false },
      usp_present: false
    };
    w[frameworkKey] = framework;
    const tcfCmpStatus = (value: any) => value === 'stub' || value === 'loading' || value === 'loaded' || value === 'error' ? value : null;
    const tcfPing = (value: any) => value && typeof value === 'object' ? { cmpLoaded: value.cmpLoaded === true ? true : value.cmpLoaded === false ? false : null, cmpStatus: tcfCmpStatus(value.cmpStatus), apiVersion: typeof value.apiVersion === 'string' ? value.apiVersion.slice(0, 16) : null, gdprApplies: value.gdprApplies === true ? true : value.gdprApplies === false ? false : null } : null;
    const tcfEvent = (value: any) => value && typeof value === 'object' ? { eventStatus: typeof value.eventStatus === 'string' ? value.eventStatus.slice(0, 32) : null, cmpStatus: tcfCmpStatus(value.cmpStatus), gdprApplies: value.gdprApplies === true ? true : value.gdprApplies === false ? false : null, purpose: { consents: countBooleans(value.purpose?.consents) }, vendor: { consents: countBooleans(value.vendor?.consents) } } : null;
    const gppPing = (value: any) => {
      if (!value || typeof value !== 'object') return null;
      const parsedSections = value.parsedSections && typeof value.parsedSections === 'object' && !Array.isArray(value.parsedSections) ? value.parsedSections : null;
      const parsedSectionPrefixes: string[] = [];
      if (parsedSections) {
        for (const prefix in parsedSections) {
          if (!Object.prototype.hasOwnProperty.call(parsedSections, prefix)) continue;
          const segments = parsedSections[prefix];
          if (/^[a-z][a-z0-9]{0,15}$/i.test(prefix) && Array.isArray(segments) && segments.length > 0 && segments[0] && typeof segments[0] === 'object' && !Array.isArray(segments[0])) {
            parsedSectionPrefixes.push(prefix.toLowerCase());
            if (parsedSectionPrefixes.length >= 50) break;
          }
        }
      }
      return {
        gppVersion: typeof value.gppVersion === 'string' ? value.gppVersion.slice(0, 16) : null,
        cmpStatus: typeof value.cmpStatus === 'string' ? value.cmpStatus.slice(0, 32) : null,
        cmpDisplayStatus: typeof value.cmpDisplayStatus === 'string' ? value.cmpDisplayStatus.slice(0, 32) : null,
        signalStatus: typeof value.signalStatus === 'string' ? value.signalStatus.slice(0, 32) : null,
        supportedAPIs: Array.isArray(value.supportedAPIs) ? value.supportedAPIs.filter((item: unknown) => typeof item === 'string').slice(0, 50) : [],
        sectionList: Array.isArray(value.sectionList) ? value.sectionList.filter((item: unknown) => Number.isInteger(item)).slice(0, 50) : [],
        applicableSections: Array.isArray(value.applicableSections) ? value.applicableSections.filter((item: unknown) => Number.isInteger(item)).slice(0, 50) : [],
        parsedSectionsAvailable: parsedSectionPrefixes.length > 0,
        parsedSectionPrefixes
      };
    };
    const installFrameworkListeners = () => {
      framework.usp_present ||= typeof w.__uspapi === 'function';
      if (typeof w.__tcfapi === 'function' && !framework.tcf.registered) {
        framework.tcf.present = true;
        try {
          w.__tcfapi('ping', 2, (value: any) => { framework.tcf.ping = tcfPing(value); });
          w.__tcfapi('addEventListener', 2, (value: any, success: boolean) => {
            if (success !== true) { if (success === false) framework.tcf.listener_registration_failed = true; return; }
            if (!value || typeof value !== 'object') return;
            framework.tcf.listener_event_observed = true;
            framework.tcf.listener_registered ||= typeof value.listenerId === 'number' || typeof value.listenerId === 'string';
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
    }, { key: CONSENT_COMMAND_OBSERVATIONS_KEY, providerKey: PROVIDER_EVENT_OBSERVATIONS_KEY, frameworkKey: FRAMEWORK_OBSERVATIONS_KEY, usercentricsKey: USERCENTRICS_LIFECYCLE_KEY });
    CONSENT_BOOTSTRAPPED_CONTEXTS.add(context);
  } catch (error) {
    CONSENT_BOOTSTRAPPED_CONTEXTS.delete(context);
    throw error;
  }
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
    const accessibleName = (control: Element) => String(
      control.getAttribute('aria-label') || control.textContent ||
      (control instanceof HTMLInputElement ? control.value : '') || control.getAttribute('title') || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 120);
    const enabled = (control: Element) => !(control as HTMLButtonElement).disabled && control.getAttribute('aria-disabled') !== 'true';
    const knownConsentAction = (name: string) => [
      'accept all', 'accept cookies', 'allow all', 'accept', 'alle akzeptieren', 'alles akzeptieren', 'tout accepter',
      'reject all', 'decline all', 'deny all', 'reject', 'decline', 'alle ablehnen', 'alles ablehnen', 'continuer sans accepter',
      'only necessary', 'necessary only', 'nur notwendige',
      'preferences', 'manage preferences', 'cookie settings', 'manage cookie settings', 'cookie preferences',
      'manage cookie preferences', 'privacy preferences', 'customize', 'einstellungen', 'einstellungen verwalten', 'personnaliser',
      'do not sell my personal information', 'do not sell or share my personal information', 'do not sell or share',
      'opt out of sale', 'opt out of sharing', 'opt out of targeted advertising', 'opt out of profiling',
      'your privacy choices', 'your california privacy choices', 'limit the use of my sensitive personal information'
    ].includes(normal(name));
    const normalizedRole = (control: Element): 'button' | 'link' | 'input' | 'other' => {
      const role = control.getAttribute('role');
      if (role === 'button' || control.tagName.toLowerCase() === 'button') return 'button';
      if (role === 'link' || control.tagName.toLowerCase() === 'a') return 'link';
      if (control.tagName.toLowerCase() === 'input') return 'input';
      return 'other';
    };
    const controls = (surface: Element) => {
      const standard = Array.from(surface.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'));
      // Non-button elements are intentionally limited to known, accessible
      // consent controls inside an already enumerated cookie/privacy surface.
      const boundedCustom = Array.from(surface.querySelectorAll('[tabindex="0"]'))
        .filter((control) => !standard.includes(control))
        .filter((control) => visible(control) && enabled(control) && knownConsentAction(accessibleName(control)));
      return [...standard, ...boundedCustom].map((control, index) => ({
        visible: visible(control), enabled: enabled(control), actionable: true,
        accessible_name: accessibleName(control), role: normalizedRole(control), direct_actionable_target: true, index
      })).sort((left, right) => {
        const priority = (control: { visible: boolean; enabled: boolean }) => control.visible && control.enabled ? 0 : control.visible ? 1 : 2;
        return priority(left) - priority(right) || left.index - right.index;
      }).slice(0, 30).map(({ index: _index, ...control }) => control);
    };
    const genericSurfaces = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i]')).slice(0, 30);
    const genericSurfaceFacts = genericSurfaces.map((surface, index) => {
      const text = normal(String((surface as HTMLElement).innerText || surface.textContent || '').slice(0, 1200));
      const actionText = controls(surface).map((control) => normal(control.accessible_name)).join(' ');
      const privacyOrCookieSemantics = /cookie|consent|privacy|tracking|do not sell|opt out of (?:sale|sharing|targeted advertising|profiling)|sensitive personal information/.test(text);
      const consentTopology = privacyOrCookieSemantics && /accept|allow/.test(actionText) && /reject|decline|deny/.test(actionText);
      const hasSettingsPath = /manage (?:cookie )?(?:settings|preferences)|cookie (?:settings|preferences)|privacy preferences/.test(actionText);
      const hasAcknowledgement = /(?:^|\s)(?:acknowledge|ok|okay|continue|got it|close)(?:\s|$)/.test(actionText);
      const consentManagementTopology = privacyOrCookieSemantics && hasSettingsPath && hasAcknowledgement;
      // Action topology on a cookie/privacy surface outranks incidental words
      // such as newsletter, country, location, or email.
      const intent = consentTopology ? 'consent'
        : /newsletter/.test(text) ? 'newsletter'
        : /email (?:address|updates|signup|sign up)|subscribe/.test(text) ? 'email_capture'
          : /sign in|log in/.test(text) ? 'login'
            : /create account|register/.test(text) ? 'account_creation'
              : /age gate|confirm (?:your )?age|are you (?:18|21)/.test(text) ? 'age_gate'
                : /country|region selector/.test(text) ? 'country_selector'
                  : /location selector|choose (?:your )?location/.test(text) ? 'location_selector'
                    : /currency selector|choose (?:your )?currency/.test(text) ? 'currency_selector'
                      : /privacy policy/.test(text) && !/reject|decline|manage preferences|cookie settings/.test(text) ? 'privacy_policy_only'
                        : /privacy notice|we value your privacy/.test(text) && !/reject|decline|manage preferences|cookie settings/.test(text) ? 'ordinary_notice'
                      : privacyOrCookieSemantics ? 'consent' : 'unknown';
      const style = surface instanceof HTMLElement ? getComputedStyle(surface) : null;
      return { id: `surface-${index}`, surface_type: (surface.getAttribute('role') === 'dialog' || surface.getAttribute('aria-modal') === 'true' ? 'dialog' : 'banner') as 'banner' | 'dialog', visible: visible(surface), privacy_or_cookie_semantics: privacyOrCookieSemantics, intent, consent_management_topology: consentManagementTopology, strong_presentation: surface.getAttribute('role') === 'dialog' || surface.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky', location: 'main_frame' as 'main_frame' | 'shadow_dom', shadow_depth: 0 };
    });
    const genericControls = genericSurfaces.flatMap((surface, index) => controls(surface).map((control) => ({ ...control, surface_id: `surface-${index}`, location: 'main_frame' as 'main_frame' | 'shadow_dom', shadow_depth: 0 })));
    // This is deliberately provider-first: two independent Cookiebot-specific
    // facts are required before inspecting non-standard descendants, and the
    // scan is bounded to a current visible consent surface.
    const cookiebotExactLoader = Array.from(document.scripts).some((script) => {
      try { const url = new URL(script.src); return url.hostname.toLowerCase() === 'consent.cookiebot.com' && url.pathname === '/uc.js'; } catch { return false; }
    });
    const cookiebotEvidenceFamilies = [
      Boolean(w.Cookiebot), Boolean(document.querySelector('[data-cbid]')),
      cookiebotExactLoader, Boolean(document.querySelector('#CybotCookiebotDialog'))
    ].filter(Boolean).length;
    const cookiebotCustomControls = (cookiebotExactLoader || cookiebotEvidenceFamilies >= 2) ? genericSurfaces.flatMap((surface, index) => {
      const surfaceFact = genericSurfaceFacts[index];
      if (!surfaceFact?.visible || !surfaceFact.privacy_or_cookie_semantics || surfaceFact.intent !== 'consent') return [];
      const conventional = controls(surface).map((control) => control.accessible_name);
      // No document-wide wildcard scan: only interaction-oriented descendants
      // of this confirmed surface are considered, and at most 100 are read.
      return Array.from(surface.querySelectorAll('[onclick], [tabindex], [role], [contenteditable="true"], [style*="cursor"]')).slice(0, 100)
        .filter((control) => !conventional.includes(accessibleName(control)))
        .filter((control) => visible(control) && enabled(control))
        .map((control) => ({ surface_id: surfaceFact.id, visible: true, enabled: true, actionable: true, accessible_name: accessibleName(control), role: normalizedRole(control), direct_actionable_target: true, location: 'main_frame' as const, shadow_depth: 0 }))
        .filter((control) => control.accessible_name.length > 0 && knownConsentAction(control.accessible_name));
    }).slice(0, 30) : [];
    const generic = { surfaces: genericSurfaceFacts, controls: [...genericControls, ...cookiebotCustomControls] };
    const gpcAcknowledgementObserved = genericSurfaces.some((surface, index) => {
      if (!genericSurfaceFacts[index]?.visible || !genericSurfaceFacts[index]?.privacy_or_cookie_semantics) return false;
      const text = normal(String((surface as HTMLElement).innerText || surface.textContent || '').slice(0, 1200));
      return /(?:global privacy control|(?:^|\s)gpc(?:\s|$))/.test(text) && /honor|honour|recognize|acknowledge|respect/.test(text);
    });
    const surfaceSelector = '[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i], [class*="privacy" i], [id*="privacy" i]';
    const bridgeEntries: Array<{ element: Element; fact: typeof genericSurfaceFacts[number] }> = genericSurfaces.map((element, index) => ({ element, fact: genericSurfaceFacts[index] }));
    const roots: Array<{ root: Document | ShadowRoot; depth: number }> = [{ root: document, depth: 0 }];
    let shadowHosts = 0;
    for (let rootIndex = 0; rootIndex < roots.length && shadowHosts < 40; rootIndex += 1) {
      const { root, depth } = roots[rootIndex];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let inspected = 0;
      for (let node = walker.nextNode(); node && inspected < 600; node = walker.nextNode(), inspected += 1) {
        const element = node as Element;
        if (depth > 0 && generic.surfaces.length < 30 && element.matches(surfaceSelector)) {
          const text = normal(String((element as HTMLElement).innerText || element.textContent || '').slice(0, 1200));
          const marker = normal(`${element.id} ${element.getAttribute('class') || ''}`);
          const privacy = /cookie|consent|privacy|tracking/.test(`${text} ${marker}`);
          const style = element instanceof HTMLElement ? getComputedStyle(element) : null;
          const fact = { id: `surface-${generic.surfaces.length}`, surface_type: element.getAttribute('role') === 'dialog' || element.getAttribute('aria-modal') === 'true' ? 'dialog' as const : 'banner' as const, visible: visible(element), privacy_or_cookie_semantics: privacy, intent: privacy ? 'consent' : 'unknown', consent_management_topology: false, strong_presentation: element.getAttribute('role') === 'dialog' || element.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky', location: 'shadow_dom' as const, shadow_depth: depth };
          generic.surfaces.push(fact); bridgeEntries.push({ element, fact });
        }
        if (element.shadowRoot && depth < 4 && roots.length < 41) { roots.push({ root: element.shadowRoot, depth: depth + 1 }); shadowHosts += 1; }
      }
    }
    const interactive = (element: Element) => {
      const role = element.getAttribute('role'); const tabIndex = Number(element.getAttribute('tabindex'));
      return element.matches('button, a[href], input[type="button"], input[type="submit"]') || role === 'button' || role === 'link' || element.hasAttribute('tabindex') && Number.isFinite(tabIndex) && tabIndex >= 0 || element.hasAttribute('onclick') || getComputedStyle(element).cursor === 'pointer';
    };
    const composedParent = (element: Element) => {
      const root = element.getRootNode();
      return element.parentElement || (root instanceof ShadowRoot ? root.host : null);
    };
    const actionableAncestor = (element: Element) => {
      let candidate: Element | null = element;
      for (let level = 0; candidate && level < 5; level += 1) {
        if (interactive(candidate) && visible(candidate) && enabled(candidate)) return candidate;
        candidate = composedParent(candidate);
      }
      return null;
    };
    // A consent surface is sometimes only the copy panel. Search the nearest
    // bounded modal/wrapper instead, never document/body, so sibling action
    // components stay in scope without creating a page-wide text scan.
    const consentScope = (surface: Element) => {
      let candidate: Element | null = surface;
      for (let level = 0; candidate && level <= 5; level += 1) {
        const marker = `${candidate.id} ${candidate.getAttribute('class') || ''}`;
        const style = candidate instanceof HTMLElement ? getComputedStyle(candidate) : null;
        const safeContainer = candidate.getAttribute('role') === 'dialog' || candidate.getAttribute('aria-modal') === 'true' ||
          /cookie|consent|privacy|cybot|didomi|usercentrics/i.test(marker) || style?.position === 'fixed' || style?.position === 'sticky';
        if (level > 0 && safeContainer && candidate !== document.body && candidate !== document.documentElement) return candidate;
        candidate = composedParent(candidate);
      }
      return surface;
    };
    const bridgeControls: typeof generic.controls = [];
    const retained = new Set<string>();
    for (const { element: surface, fact } of bridgeEntries) {
      if (!fact.visible || !fact.privacy_or_cookie_semantics || fact.intent !== 'consent' || bridgeControls.length >= 30) continue;
      const stack: Element[] = [consentScope(surface)]; let inspected = 0;
      while (stack.length && inspected < 150 && bridgeControls.length < 30) {
        const candidate = stack.pop()!; inspected += 1;
        const name = accessibleName(candidate);
        if (name && knownConsentAction(name)) {
          const target = actionableAncestor(candidate); const key = `${fact.id}:${normal(name)}`;
          if (target && !retained.has(key)) {
            retained.add(key); bridgeControls.push({ surface_id: fact.id, visible: true, enabled: true, actionable: true, accessible_name: name, role: normalizedRole(target), direct_actionable_target: target === candidate, location: fact.location, shadow_depth: fact.shadow_depth });
          }
        }
        for (const child of Array.from(candidate.children).reverse()) stack.push(child);
        if (candidate.shadowRoot) for (const child of Array.from(candidate.shadowRoot.children).reverse()) stack.push(child);
      }
    }
    for (const control of bridgeControls) {
      if (!generic.controls.some((existing) => existing.surface_id === control.surface_id && normal(existing.accessible_name) === normal(control.accessible_name))) generic.controls.push(control);
    }
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
        return { current_user_status: { decision, enabled_purpose_count: Math.min(enabled, 200), disabled_purpose_count: Math.min(disabled, 200) }, notice_visible: typeof w.Didomi?.notice?.isVisible === 'function' ? Boolean(w.Didomi.notice.isVisible()) : null, public_methods: ['getCurrentUserStatus', 'setUserAgreeToAll', 'setUserDisagreeToAll'].filter((name) => typeof w.Didomi?.[name] === 'function').concat(typeof w.Didomi?.notice?.isVisible === 'function' ? ['notice.isVisible'] : []).concat(typeof w.Didomi?.preferences?.show === 'function' ? ['preferences.show'] : []) };
      } catch { return { current_user_status: null, notice_visible: null, public_methods: [] }; }
    };
    const didomi = didomiStatus();
    // Capture controls only from the documented Didomi roots. The labels are
    // transient matching inputs; neither labels nor selectors are persisted.
    const didomi_controls = ['#didomi-host', '#didomi-notice'].flatMap((rootSelector) => {
      const root = document.querySelector(rootSelector);
      if (!root || !visible(root)) return [];
      return Array.from(root.querySelectorAll('button, [role="button"], a')).slice(0, 30).map((element, index) => ({
        id: `${rootSelector}:${index}`,
        accessible_name: String((element as HTMLElement).getAttribute('aria-label') || element.textContent || '').slice(0, 120),
        visible: visible(element), enabled: !(element as HTMLButtonElement).disabled
      }));
    });
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
    let gpcSignal: 'present' | 'absent' | 'unavailable' = 'unavailable';
    try {
      if ('globalPrivacyControl' in navigator) {
        const value = (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl;
        gpcSignal = value === true ? 'present' : value === false ? 'absent' : 'unavailable';
      }
    } catch { /* Browser privacy signal is optional. */ }
    return { globals: globals.filter((name) => Boolean(w[name])), assets: Array.from(document.scripts).map((script) => script.src).filter(Boolean).slice(0, 200), cookie_names: cookieNames, cookiebot_data_cbid_present: Boolean(document.querySelector('[data-cbid]')), storage_keys: storageKeys, observations: selectors.map((selector) => { const element = document.querySelector(selector) as HTMLButtonElement | null; return element ? { selector, visible: visible(element), enabled: !element.disabled, text: String(element.getAttribute('aria-label') || element.textContent || '').slice(0, 120) } : null; }).filter(Boolean), cookiebot, cookieyes, onetrust, onetrust_public_methods, cookieyes_runtime_functions, didomi, didomi_controls, provider_events: Array.isArray(w[providerEventKey]) ? w[providerEventKey].filter((value: unknown) => typeof value === 'string').slice(0, 20) : [], cookiebot_events: Array.isArray(w.__upsightCookiebotEvents) ? w.__upsightCookiebotEvents.filter((value: unknown) => value === 'CookiebotOnAccept' || value === 'CookiebotOnDecline' || value === 'CookiebotOnDialogDisplay').slice(0, 20) : [], shopify, consent_commands: commands, gpc_signal: gpcSignal, gpc_acknowledgement_observed: gpcAcknowledgementObserved, generic };
  }, { globals: PROVIDER_GLOBALS, selectors: DOM_SELECTORS, consentCommandKey: CONSENT_COMMAND_OBSERVATIONS_KEY, providerEventKey: PROVIDER_EVENT_OBSERVATIONS_KEY }) as Omit<BrowserConsentFacts, 'usercentrics'>;
  const usercentrics = await page.evaluate(({ rootSelector, lifecycleKey }) => {
    const w = window as any;
    const raw = w[lifecycleKey] && typeof w[lifecycleKey] === 'object' ? w[lifecycleKey] : {};
    const view = raw.latest_view === 'FIRST_LAYER' || raw.latest_view === 'SECOND_LAYER' || raw.latest_view === 'NONE' || raw.latest_view === 'PRIVACY_BUTTON' ? raw.latest_view : null;
    const lifecycle = { initialized: raw.initialized === true || (() => { try { return typeof w.UC_UI?.isInitialized === 'function' && w.UC_UI.isInitialized() === true; } catch { return false; } })(), latest_view: view, latest_view_at_ms: typeof raw.latest_view_at_ms === 'number' ? raw.latest_view_at_ms : null, cmp_shown_observed: raw.cmp_shown_observed === true, cmp_shown_at_ms: typeof raw.cmp_shown_at_ms === 'number' ? raw.cmp_shown_at_ms : null, event_count: Math.max(0, Math.min(20, Number(raw.event_count) || 0)) };
    const root = document.querySelector(rootSelector) as HTMLElement | null;
    if (!root) return { present: false, visible: false, shadow_mode: 'none' as const, controls: [], lifecycle };
    const style = getComputedStyle(root); const box = root.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    const shadow = root.shadowRoot;
    if (!shadow) return { present: true, visible, shadow_mode: 'closed' as const, controls: [], lifecycle };
    return {
      present: true,
      visible,
      shadow_mode: 'open' as const, lifecycle,
      controls: Array.from(shadow.querySelectorAll('button, [role="button"], a')).slice(0, 30).map((element, index) => ({
        id: `${rootSelector} button:nth-of-type(${index + 1})`,
        accessible_name: String((element as HTMLElement).getAttribute('aria-label') || element.textContent || '').slice(0, 120),
        visible: true,
        enabled: !(element as HTMLButtonElement).disabled
      }))
    };
  }, { rootSelector: USERCENTRICS_STANDARD_ROOT, lifecycleKey: USERCENTRICS_LIFECYCLE_KEY });
  return { ...facts, usercentrics };
}

export async function probeConsentUiState(page: Page): Promise<ConsentUiProbe> {
  return page.evaluate(() => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const normal = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const action = (value: string) => new Set(['accept all', 'accept cookies', 'allow all', 'accept', 'alle akzeptieren', 'alles akzeptieren', 'tout accepter', 'reject all', 'decline all', 'deny all', 'reject', 'decline', 'alle ablehnen', 'alles ablehnen', 'continuer sans accepter', 'only necessary', 'necessary only', 'nur notwendige', 'preferences', 'manage preferences', 'cookie settings', 'manage cookie settings', 'cookie preferences', 'manage cookie preferences', 'privacy preferences', 'customize', 'einstellungen', 'einstellungen verwalten', 'personnaliser']).has(normal(value));
    const label = (element: Element) => String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const surfaceSelector = '[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i], [class*="privacy" i], [id*="privacy" i]';
    const roots: Array<{ root: Document | ShadowRoot; depth: number }> = [{ root: document, depth: 0 }];
    const surfaces: Element[] = []; let shadows = 0;
    for (let rootIndex = 0; rootIndex < roots.length && shadows < 40; rootIndex += 1) {
      const { root, depth } = roots[rootIndex]; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let inspected = 0;
      for (let node = walker.nextNode(); node && inspected < 600; node = walker.nextNode(), inspected += 1) {
        const element = node as Element;
        if (surfaces.length < 30 && element.matches(surfaceSelector)) surfaces.push(element);
        if (element.shadowRoot && depth < 4 && roots.length < 41) { roots.push({ root: element.shadowRoot, depth: depth + 1 }); shadows += 1; }
      }
    }
    const strong = surfaces.filter((surface) => {
      const style = surface instanceof HTMLElement ? getComputedStyle(surface) : null;
      const marker = `${surface.id} ${surface.getAttribute('class') || ''} ${String((surface as HTMLElement).innerText || surface.textContent || '').slice(0, 1200)}`;
      return visible(surface) && /cookie|consent|privacy|tracking/i.test(marker) && (surface.getAttribute('role') === 'dialog' || surface.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky');
    });
    const composedParent = (element: Element) => element.parentElement || (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
    const scopeFor = (surface: Element) => {
      let candidate: Element | null = surface;
      for (let level = 0; candidate && level <= 5; level += 1) {
        const style = candidate instanceof HTMLElement ? getComputedStyle(candidate) : null;
        const marker = `${candidate.id} ${candidate.getAttribute('class') || ''}`;
        if (level > 0 && candidate !== document.body && candidate !== document.documentElement && (candidate.getAttribute('role') === 'dialog' || candidate.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky' || /cookie|consent|privacy|cybot|didomi|usercentrics/i.test(marker))) return candidate;
        candidate = composedParent(candidate);
      }
      return surface;
    };
    let semantic = 0;
    for (const surface of strong) {
      const stack = [scopeFor(surface)]; let inspected = 0;
      while (stack.length && inspected < 150 && semantic < 30) {
        const element = stack.pop()!; inspected += 1;
        if (visible(element) && element.getAttribute('aria-disabled') !== 'true' && action(label(element))) semantic += 1;
        for (const child of Array.from(element.children).reverse()) stack.push(child);
        if (element.shadowRoot) for (const child of Array.from(element.shadowRoot.children).reverse()) stack.push(child);
      }
    }
    const providerRootVisible = ['#CybotCookiebotDialog', '#usercentrics-cmp-ui', '#didomi-host', '#didomi-notice'].some((selector) => visible(document.querySelector(selector)));
    return { strong_visible_surface_count: strong.length, visible_semantic_control_count: semantic, open_shadow_roots_observed: shadows, provider_root_visible: providerRootVisible };
  });
}

/** Waits only when the caller has already found unresolved CMP evidence. */
export async function waitForConsentUiReadiness(page: Page, maximumMs: number, requireSemanticControls: boolean): Promise<ConsentUiProbe> {
  return page.evaluate(async ({ maximumMs, requireSemanticControls }) => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const normal = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const action = (value: string) => new Set(['accept all', 'accept cookies', 'allow all', 'accept', 'alle akzeptieren', 'alles akzeptieren', 'tout accepter', 'reject all', 'decline all', 'deny all', 'reject', 'decline', 'alle ablehnen', 'alles ablehnen', 'continuer sans accepter', 'only necessary', 'necessary only', 'nur notwendige', 'preferences', 'manage preferences', 'cookie settings', 'manage cookie settings', 'cookie preferences', 'manage cookie preferences', 'privacy preferences', 'customize', 'einstellungen', 'einstellungen verwalten', 'personnaliser']).has(normal(value));
    const label = (element: Element) => String(element.getAttribute('aria-label') || (element instanceof HTMLInputElement ? element.value : '') || element.textContent || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const probe = (): ConsentUiProbe => {
      const selector = '[role="dialog"], [aria-modal="true"], [class*="consent" i], [id*="consent" i], [class*="cookie" i], [id*="cookie" i], [class*="privacy" i], [id*="privacy" i]';
      const roots: Array<{ root: Document | ShadowRoot; depth: number }> = [{ root: document, depth: 0 }]; const surfaces: Element[] = []; let shadows = 0;
      for (let rootIndex = 0; rootIndex < roots.length && shadows < 40; rootIndex += 1) {
        const { root, depth } = roots[rootIndex]; const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); let inspected = 0;
        for (let node = walker.nextNode(); node && inspected < 600; node = walker.nextNode(), inspected += 1) {
          const element = node as Element;
          if (surfaces.length < 30 && element.matches(selector)) surfaces.push(element);
          if (element.shadowRoot && depth < 4 && roots.length < 41) { roots.push({ root: element.shadowRoot, depth: depth + 1 }); shadows += 1; }
        }
      }
      const strong = surfaces.filter((surface) => {
        const style = surface instanceof HTMLElement ? getComputedStyle(surface) : null;
        const marker = `${surface.id} ${surface.getAttribute('class') || ''} ${String((surface as HTMLElement).innerText || surface.textContent || '').slice(0, 1200)}`;
        return visible(surface) && /cookie|consent|privacy|tracking/i.test(marker) && (surface.getAttribute('role') === 'dialog' || surface.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky');
      });
      const composedParent = (element: Element) => element.parentElement || (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
      const scopeFor = (surface: Element) => {
        let candidate: Element | null = surface;
        for (let level = 0; candidate && level <= 5; level += 1) {
          const style = candidate instanceof HTMLElement ? getComputedStyle(candidate) : null;
          const marker = `${candidate.id} ${candidate.getAttribute('class') || ''}`;
          if (level > 0 && candidate !== document.body && candidate !== document.documentElement && (candidate.getAttribute('role') === 'dialog' || candidate.getAttribute('aria-modal') === 'true' || style?.position === 'fixed' || style?.position === 'sticky' || /cookie|consent|privacy|cybot|didomi|usercentrics/i.test(marker))) return candidate;
          candidate = composedParent(candidate);
        }
        return surface;
      };
      let semantic = 0;
      for (const surface of strong) {
        const stack = [scopeFor(surface)]; let inspected = 0;
        while (stack.length && inspected < 150 && semantic < 30) {
          const element = stack.pop()!; inspected += 1;
          if (visible(element) && element.getAttribute('aria-disabled') !== 'true' && action(label(element))) semantic += 1;
          for (const child of Array.from(element.children).reverse()) stack.push(child);
          if (element.shadowRoot) for (const child of Array.from(element.shadowRoot.children).reverse()) stack.push(child);
        }
      }
      const providerRootVisible = ['#CybotCookiebotDialog', '#usercentrics-cmp-ui', '#didomi-host', '#didomi-notice'].some((item) => visible(document.querySelector(item)));
      return { strong_visible_surface_count: strong.length, visible_semantic_control_count: semantic, open_shadow_roots_observed: shadows, provider_root_visible: providerRootVisible };
    };
    const ready = (state: ConsentUiProbe) => requireSemanticControls
      ? state.visible_semantic_control_count > 0
      : state.strong_visible_surface_count > 0 || state.visible_semantic_control_count > 0 || state.provider_root_visible;
    const initial = probe(); if (ready(initial)) return initial;
    return await new Promise<ConsentUiProbe>((resolve) => {
      let settled = false; const finish = (state: ConsentUiProbe) => { if (settled) return; settled = true; observer.disconnect(); clearInterval(poll); clearTimeout(timeout); resolve(state); };
      const check = () => { const state = probe(); if (ready(state)) finish(state); };
      const observer = new MutationObserver(check); observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'role', 'aria-modal', 'aria-label', 'aria-disabled', 'tabindex'] });
      const poll = window.setInterval(check, 250); const timeout = window.setTimeout(() => finish(probe()), maximumMs);
    });
  }, { maximumMs: Math.max(0, Math.min(maximumMs, 4000)), requireSemanticControls });
}

const observation = (facts: BrowserConsentFacts, selector: string) => facts.observations.find((item) => item.selector === selector);
const control = (facts: BrowserConsentFacts, selector: string, within = true) => ({ selector, id: selector, accessible_name: observation(facts, selector)?.text || '', visible: Boolean(observation(facts, selector)?.visible), enabled: Boolean(observation(facts, selector)?.enabled), actionable: Boolean(observation(facts, selector)?.visible && observation(facts, selector)?.enabled), within_confirmed_cookiebot_surface: within, within_confirmed_cookieyes_surface: within, within_confirmed_usercentrics_surface: within });
const storage = (facts: BrowserConsentFacts) => [...facts.cookie_names.map((key_name) => ({ key_name, name: key_name, storage_type: 'cookie' as const, exists: true })), ...facts.storage_keys.map((key_name) => ({ key_name, name: key_name, storage_type: 'local_storage' as const, exists: true }))];
const click = (page: Page, selector: string) => page.locator(selector).first().click().then(() => true).catch(() => false);
const clickDidomiControl = (page: Page, id: string) => {
  const separator = id.lastIndexOf(':');
  const rootSelector = id.slice(0, separator);
  const index = Number(id.slice(separator + 1));
  if (!['#didomi-host', '#didomi-notice'].includes(rootSelector) || !Number.isInteger(index) || index < 0) return Promise.resolve(false);
  return page.locator(rootSelector).locator('button, [role="button"], a').nth(index).click().then(() => true).catch(() => false);
};
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
export async function buildProviderContexts(page: Page, facts: BrowserConsentFacts, framework: ConsentFrameworkObservations, semanticDiscovery?: ProviderSemanticDiscovery, geo?: 'USA' | 'EU' | 'UK') {
  const common = { asset_urls: facts.assets, cookies: facts.cookie_names.map((name) => ({ name, exists: true })), storage: storage(facts), tcf_active: framework.tcf.lifecycle !== 'absent', gpp_active: framework.gpp.lifecycle !== 'absent' };
  const tcf = framework.tcf.latest_event;
  const sourcepointFramework = { tcf_present: framework.tcf.lifecycle !== 'absent', tcf_event_status: tcf?.event_status || undefined, tcf_purpose_decision: tcf ? tcfAggregateDecision(tcf.purpose_consents) : undefined, tcf_vendor_decision: tcf ? tcfAggregateDecision(tcf.vendor_consents) : undefined, gpp_present: framework.gpp.lifecycle !== 'absent' };
  const sourcepoint = await captureSourcepointFrameFacts(page);
  return new Map<CmpAdapterProviderId, unknown>([
    ['onetrust', { ...common, window_globals: facts.globals, surfaces: ONETRUST_STANDARD_ROOTS.map((selector) => ({ selector, present: Boolean(observation(facts, selector)), visible: Boolean(observation(facts, selector)?.visible) })), controls: Object.values(ONETRUST_DOCUMENTED_CONTROLS).map((selector) => control(facts, selector)), generic_surfaces: facts.generic.surfaces, generic_controls: facts.generic.controls, action_targets: [documentTarget('accept_all', ONETRUST_DOCUMENTED_CONTROLS.accept, control(facts, ONETRUST_DOCUMENTED_CONTROLS.accept)), documentTarget('reject_all', ONETRUST_DOCUMENTED_CONTROLS.reject, control(facts, ONETRUST_DOCUMENTED_CONTROLS.reject)), documentTarget('open_preferences', ONETRUST_DOCUMENTED_CONTROLS.preferences, control(facts, ONETRUST_DOCUMENTED_CONTROLS.preferences))], public_methods: facts.onetrust_public_methods, active_group_ids: facts.onetrust?.active_group_ids, provider_events: facts.onetrust?.provider_events, invoke_control: (selector: string) => click(page, selector), invoke_public_method: (method: string) => page.evaluate((name) => { const api = (window as any).OneTrust; if (typeof api?.[name] !== 'function') return false; api[name](); return true; }, method).catch(() => false) }],
    ['cookiebot', { ...common, geo, window_globals: facts.globals, data_cbid_present: facts.cookiebot_data_cbid_present, surfaces: [{ selector: COOKIEBOT_STANDARD_ROOT, present: Boolean(observation(facts, COOKIEBOT_STANDARD_ROOT)), visible: Boolean(observation(facts, COOKIEBOT_STANDARD_ROOT)?.visible) }], controls: [...Object.values(COOKIEBOT_STANDARD_CONTROLS).map((selector) => control(facts, selector)), ...(semanticDiscovery?.controls.map((item) => ({ id: item.id, accessible_name: item.accessible_name, semantic_action: item.action, visible: item.visible, enabled: item.enabled, actionable: item.actionable, within_confirmed_cookiebot_surface: true })) || []), ...facts.generic.controls.map((item, index) => ({ id: item.id || `generic:${index}`, accessible_name: item.accessible_name, semantic_action: semanticActionForConsentLabel(item.accessible_name) || undefined, visible: item.visible, enabled: item.enabled, actionable: item.actionable, within_confirmed_cookiebot_surface: item.id?.startsWith('provider-semantic:') || facts.generic.surfaces.some((surface) => surface.id === item.surface_id && surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent') }))], generic_surfaces: facts.generic.surfaces, generic_controls: facts.generic.controls.map((item) => ({ ...item, semantic_action: semanticActionForConsentLabel(item.accessible_name) || undefined })), action_targets: [documentTarget('accept_all', COOKIEBOT_STANDARD_CONTROLS.accept, control(facts, COOKIEBOT_STANDARD_CONTROLS.accept)), documentTarget('reject_all', COOKIEBOT_STANDARD_CONTROLS.decline, control(facts, COOKIEBOT_STANDARD_CONTROLS.decline)), documentTarget('reject_all', COOKIEBOT_STANDARD_CONTROLS.level_decline_all, control(facts, COOKIEBOT_STANDARD_CONTROLS.level_decline_all), 'preference_center'), documentTarget('open_preferences', COOKIEBOT_STANDARD_CONTROLS.preferences, control(facts, COOKIEBOT_STANDARD_CONTROLS.preferences)), ...(semanticDiscovery?.controls.filter((item) => item.action === 'accept_all' || item.action === 'reject_all' || item.action === 'only_necessary' || item.action === 'open_preferences').map((item) => ({ action: item.action, category: null, target_ref: item.id, surface_type: 'dialog' as const, frame_path: ['top'], shadow_mode: item.shadow_mode, accessible_control: true, attached: true, visible: true, enabled: item.enabled })) || [])], runtime: facts.cookiebot, invoke_control: (selector: string) => selector.startsWith('provider-semantic:') ? semanticDiscovery?.invoke(selector) || Promise.resolve(false) : click(page, selector) }],
    ['usercentrics', { ...common, uc_ui_type: facts.globals.includes('UC_UI') ? 'object' : 'undefined', surfaces: [{ selector: USERCENTRICS_STANDARD_ROOT, present: facts.usercentrics.present, visible: facts.usercentrics.visible, shadow_mode: facts.usercentrics.shadow_mode }], lifecycle: facts.usercentrics.lifecycle, generic_surfaces: facts.generic.surfaces, controls: [...facts.usercentrics.controls.map((item) => ({ id: item.id, accessible_name: item.accessible_name, visible: item.visible, enabled: item.enabled })), ...facts.generic.controls.map((item, index) => ({ id: item.id || `generic:${index}`, accessible_name: item.accessible_name, visible: item.visible, enabled: item.enabled }))].map((item) => ({ id: item.id, semantic_action: semanticActionForConsentLabel(item.accessible_name), visible: item.visible, enabled: item.enabled, actionable: item.visible && item.enabled, within_confirmed_usercentrics_surface: true, role: 'button' as const })).filter((item): item is { id: string; semantic_action: 'accept_all' | 'reject_all' | 'open_preferences'; visible: boolean; enabled: boolean; actionable: boolean; within_confirmed_usercentrics_surface: true; role: 'button' } => item.semantic_action === 'accept_all' || item.semantic_action === 'reject_all' || item.semantic_action === 'open_preferences'), action_targets: facts.usercentrics.controls.flatMap((item) => { const action = semanticActionForConsentLabel(item.accessible_name); return action ? [{ action: action as string, category: null, target_ref: `shadow:${item.id}`, surface_type: 'dialog' as const, frame_path: ['top'], shadow_mode: facts.usercentrics.shadow_mode, accessible_control: true, attached: facts.usercentrics.shadow_mode === 'open', visible: item.visible, enabled: item.enabled } satisfies BrowserActionTarget] : []; }), legacy_globals: facts.globals, invoke_control: (id: string) => id.startsWith('provider-semantic:') ? semanticDiscovery?.invoke(id) || Promise.resolve(false) : id.startsWith('generic:') ? Promise.resolve(false) : click(page, id) }],
    ['didomi', { ...common, window_globals: facts.globals, surfaces: DIDOMI_STANDARD_ROOTS.map((selector) => ({ selector, present: Boolean(observation(facts, selector)), visible: Boolean(observation(facts, selector)?.visible) })), generic_surfaces: facts.generic.surfaces, controls: [...facts.didomi_controls.map((item) => ({ id: item.id, accessible_name: item.accessible_name, visible: item.visible, enabled: item.enabled, within_confirmed_didomi_surface: true })), ...facts.generic.controls.filter((item) => item.id?.startsWith('provider-semantic:') || facts.generic.surfaces.some((surface) => surface.id === item.surface_id && surface.visible && surface.privacy_or_cookie_semantics && surface.intent === 'consent')).map((item, index) => ({ id: item.id || `generic:${index}`, accessible_name: item.accessible_name, visible: item.visible, enabled: item.enabled, within_confirmed_didomi_surface: true }))].flatMap((item) => { const action = semanticActionForConsentLabel(item.accessible_name); return action === 'accept_all' || action === 'reject_all' || action === 'open_preferences' ? [{ id: item.id, semantic_action: action, origin: 'semantic_ui' as const, visible: item.visible, enabled: item.enabled, actionable: item.visible && item.enabled, within_confirmed_didomi_surface: item.within_confirmed_didomi_surface }] : []; }), action_targets: facts.didomi_controls.flatMap((item) => { const action = semanticActionForConsentLabel(item.accessible_name); return action === 'accept_all' || action === 'reject_all' || action === 'open_preferences' ? [{ action, category: null, target_ref: `didomi:${item.id}`, surface_type: 'banner' as const, frame_path: ['top'], shadow_mode: 'none' as const, accessible_control: true, attached: true, visible: item.visible, enabled: item.enabled } satisfies BrowserActionTarget] : []; }), public_methods: Array.isArray(facts.didomi?.public_methods) ? facts.didomi.public_methods : [], runtime: facts.didomi, provider_events: facts.provider_events, invoke_control: (id: string) => id.startsWith('provider-semantic:') ? semanticDiscovery?.invoke(id) || Promise.resolve(false) : id.startsWith('generic:') ? Promise.resolve(false) : clickDidomiControl(page, id), invoke_public_method: (method: string) => page.evaluate((name) => { const api = (window as any).Didomi; const fn = name === 'preferences.show' ? api?.preferences?.show : api?.[name]; if (typeof fn !== 'function') return false; fn.call(name === 'preferences.show' ? api.preferences : api); return true; }, method).catch(() => false) }],
    ['cookieyes', { ...common, runtime_functions: facts.cookieyes_runtime_functions, surfaces: [{ selector: COOKIEYES_STANDARD_ROOT, present: Boolean(observation(facts, COOKIEYES_STANDARD_ROOT)), visible: Boolean(observation(facts, COOKIEYES_STANDARD_ROOT)?.visible) }], controls: Object.values(COOKIEYES_STABLE_CONTROLS).map((selector) => control(facts, selector)), action_targets: [documentTarget('accept_all', COOKIEYES_STABLE_CONTROLS.accept, control(facts, COOKIEYES_STABLE_CONTROLS.accept)), documentTarget('reject_all', COOKIEYES_STABLE_CONTROLS.reject, control(facts, COOKIEYES_STABLE_CONTROLS.reject)), documentTarget('open_preferences', COOKIEYES_STABLE_CONTROLS.customize, control(facts, COOKIEYES_STABLE_CONTROLS.customize))], consent: facts.cookieyes, persistence: storage(facts), invoke_control: (selector: string) => click(page, selector), invoke_public_action: (action: string) => page.evaluate((value) => { const fn = (window as any).performBannerAction; if (typeof fn !== 'function') return false; fn(value); return true; }, action).catch(() => false) }],
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
    return state ? { tcf: { ...state.tcf, present: state.tcf?.present === true || typeof w.__tcfapi === 'function' }, gpp: { ...state.gpp, present: state.gpp?.present === true || typeof w.__gpp === 'function' }, usp: state.usp_present === true || typeof w.__uspapi === 'function' } : { tcf: { present: typeof w.__tcfapi === 'function', ping: null, latest_event: null, event_count: 0, listener_registered: false, listener_event_observed: false, listener_registration_failed: false }, gpp: { present: typeof w.__gpp === 'function', ping: null, latest_event: null, event_count: 0 }, usp: typeof w.__uspapi === 'function' };
  }, FRAMEWORK_OBSERVATIONS_KEY);
  let captured = await readBridge();
  // `addInitScript` observes navigations. A same-document fixture or a page
  // reached before the bootstrap was installed can still expose a real public
  // framework API, so probe only its lifecycle ping as a bounded fallback.
  if ((captured.tcf.present && !captured.tcf.ping) || (captured.gpp.present && !captured.gpp.ping)) {
    const direct = await page.evaluate(async () => {
      const call = (invoke: (callback: (payload: unknown, success?: boolean) => void) => void) => new Promise<unknown>((resolve) => {
        let settled = false;
        const finish = (value: unknown) => { if (!settled) { settled = true; resolve(value); } };
        try { invoke((payload, success) => finish(success === false ? null : payload)); } catch { finish(null); }
        setTimeout(() => finish(null), 250);
      });
      const sanitizeGppPing = (value: any) => {
        if (!value || typeof value !== 'object') return null;
        const parsedSections = value.parsedSections && typeof value.parsedSections === 'object' && !Array.isArray(value.parsedSections) ? value.parsedSections : null;
        const parsedSectionPrefixes: string[] = [];
        if (parsedSections) for (const prefix in parsedSections) {
          if (!Object.prototype.hasOwnProperty.call(parsedSections, prefix)) continue;
          const segments = parsedSections[prefix];
          if (/^[a-z][a-z0-9]{0,15}$/i.test(prefix) && Array.isArray(segments) && segments.length > 0 && segments[0] && typeof segments[0] === 'object' && !Array.isArray(segments[0])) {
            parsedSectionPrefixes.push(prefix.toLowerCase());
            if (parsedSectionPrefixes.length >= 50) break;
          }
        }
        return {
          gppVersion: typeof value.gppVersion === 'string' ? value.gppVersion.slice(0, 16) : null,
          cmpStatus: typeof value.cmpStatus === 'string' ? value.cmpStatus.slice(0, 32) : null,
          cmpDisplayStatus: typeof value.cmpDisplayStatus === 'string' ? value.cmpDisplayStatus.slice(0, 32) : null,
          signalStatus: typeof value.signalStatus === 'string' ? value.signalStatus.slice(0, 32) : null,
          supportedAPIs: Array.isArray(value.supportedAPIs) ? value.supportedAPIs.filter((item: unknown) => typeof item === 'string').slice(0, 50) : [],
          sectionList: Array.isArray(value.sectionList) ? value.sectionList.filter((item: unknown) => Number.isInteger(item)).slice(0, 50) : [],
          applicableSections: Array.isArray(value.applicableSections) ? value.applicableSections.filter((item: unknown) => Number.isInteger(item)).slice(0, 50) : [],
          parsedSectionsAvailable: parsedSectionPrefixes.length > 0,
          parsedSectionPrefixes
        };
      };
      const w = window as any;
      return {
        tcf: typeof w.__tcfapi === 'function' ? await call((callback) => w.__tcfapi('ping', 2, callback)) : null,
        gpp: typeof w.__gpp === 'function' ? sanitizeGppPing(await call((callback) => w.__gpp('ping', callback))) : null
      };
    });
    if (!captured.tcf.ping && direct.tcf) captured.tcf.ping = direct.tcf as any;
    if (!captured.gpp.ping && direct.gpp) captured.gpp.ping = direct.gpp as any;
  }
  // The bridge is already observing for the page lifetime. Only a framework
  // that is present but has not replied gets this short bounded chance to
  // deliver its delayed ping/listener callback.
  const awaitingCallback = (captured.tcf.present && !captured.tcf.listener_event_observed && !captured.tcf.listener_registration_failed) || (captured.gpp.present && !captured.gpp.ping && !captured.gpp.latest_event);
  if (awaitingCallback) {
    await page.waitForFunction((frameworkKey) => {
      const state = (window as any)[frameworkKey];
      if (!state) return false;
      const tcfPresent = state.tcf?.present === true || typeof (window as any).__tcfapi === 'function';
      const gppPresent = state.gpp?.present === true || typeof (window as any).__gpp === 'function';
      const tcfDone = !tcfPresent || state.tcf?.listener_event_observed === true || state.tcf?.listener_registration_failed === true;
      const gppDone = !gppPresent || Boolean(state.gpp?.ping || state.gpp?.latest_event);
      return tcfDone && gppDone;
    }, FRAMEWORK_OBSERVATIONS_KEY, { timeout: 350 }).catch(() => undefined);
    captured = await readBridge();
  }
  const runtime = {
    __tcfapi: captured.tcf.present ? ((command: string, _version: number, callback: (payload: unknown, success?: boolean) => void) => {
      if (command === 'ping' && captured.tcf.ping) callback(captured.tcf.ping, true);
      if (command === 'addEventListener' && captured.tcf.latest_event) callback({ ...captured.tcf.latest_event, ...(captured.tcf.listener_registered ? { listenerId: 1 } : {}) }, true);
    }) : undefined,
    __gpp: captured.gpp.present ? ((command: string, callback: (payload: unknown, success?: boolean) => void) => {
      if (command === 'ping') callback(captured.gpp.ping, Boolean(captured.gpp.ping));
      if (command === 'addEventListener' && captured.gpp.latest_event) callback({ pingData: captured.gpp.latest_event, eventCount: captured.gpp.event_count }, true);
    }) : undefined,
    __uspapi: captured.usp ? (() => undefined) : undefined
  };
  const observers = observeConsentFrameworks(runtime);
  const result = { tcf: { ...observers.tcf.state, event_count: Math.max(0, Number(captured.tcf?.event_count) || 0), listener_registered: captured.tcf?.listener_registered === true, listener_event_observed: captured.tcf?.listener_event_observed === true, listener_registration_failed: captured.tcf?.listener_registration_failed === true }, gpp: { ...observers.gpp.state, event_count: Math.max(0, Number(captured.gpp?.event_count) || 0) }, usp: observers.usp };
  observers.tcf.stop(); observers.gpp.stop();
  return result;
}

export function buildPersistenceStorage(facts: BrowserConsentFacts) {
  return storage(facts).filter((entry) => /consent|cookie|privacy|ucdata|ucstring|didomi/i.test(entry.key_name)).slice(0, 20).map((entry) => ({ ...entry, domain: null, path: null, expiry_class: 'unknown' as const, secure: null, http_only: null, same_site: null }));
}
