import { describe, expect, it } from 'vitest';
import type { ConsentV2RolloutControls } from './rollout-controls';
import { runConsentV2Session } from './v2-session';
import type { BrowserConsentFacts } from './browser-context-builders';

const rollout: ConsentV2RolloutControls = {
  enabled: true, actions_enabled: false, action_sample_percent: 0,
  providers: Object.fromEntries(['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'cookieyes', 'sourcepoint', 'shopify', 'generic'].map((provider) => [provider, { detection_enabled: true, actions_enabled: false }])) as ConsentV2RolloutControls['providers']
};

const framework = (gpp = false) => ({ tcf: { present: false, ping: null, event: null }, gpp: { present: gpp, ping: gpp ? { gppVersion: '1.1', cmpStatus: 'stub', cmpDisplayStatus: 'visible', signalStatus: 'not_ready', cmpId: 1, supportedAPIs: [], sectionList: [], applicableSections: [] } : null, event: null }, usp: false });
const facts = (overrides: Partial<BrowserConsentFacts> = {}): BrowserConsentFacts => ({ globals: [], assets: [], cookie_names: [], storage_keys: [], observations: [], cookiebot: null, cookieyes: null, shopify: null, consent_commands: [], generic: { surfaces: [], controls: [] }, ...overrides });

/** A deterministic local browser-page fixture. Its evaluate boundary is the same one used by production builders. */
function pageFixture(browserFacts: BrowserConsentFacts, frameworkFacts = framework()) {
  let evaluation = 0;
  return {
    on() {}, off() {}, url: () => 'https://fixture.local/', isClosed: () => false,
    async evaluate() { return evaluation++ === 0 ? browserFacts : frameworkFacts; },
    async reload() {}, async waitForLoadState() {}, async waitForTimeout() {}, locator() { throw new Error('actions are disabled in production fixtures'); }
  } as any;
}

const sessionInput = { geo: 'EU' as const, geo_verified: true, page_valid: true, rollout };

describe('Consent V2 production session wiring', () => {
  it('uses the OneTrust adapter for provider evidence, state, banner, and actions', async () => {
    const result = await runConsentV2Session(pageFixture(facts({ globals: ['OneTrust'], assets: ['https://cdn.cookielaw.org/otSDKStub.js'], cookie_names: ['OptanonConsent'], observations: [{ selector: '#onetrust-banner-sdk', visible: true, enabled: true, text: '' }, { selector: '#onetrust-reject-all-handler', visible: true, enabled: true, text: 'Reject all' }] })), sessionInput);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('direct');
  });

  it('keeps Shopify Customer Privacy as a separate commerce privacy runtime beside OneTrust', async () => {
    const shopify = { shopify_object_present: true, customer_privacy_object_present: true, runtime_methods: ['currentVisitorConsent', 'analyticsProcessingAllowed', 'marketingAllowed', 'preferencesProcessingAllowed', 'saleOfDataAllowed', 'shouldShowBanner'], visitor_consent: { analytics: 'no', marketing: 'no', preferences: 'no', sale_of_data: 'no' }, processing_allowed: { analytics: false, marketing: false, preferences: false, sale_of_data: false }, should_show_banner: false, region_available: true };
    const result = await runConsentV2Session(pageFixture(facts({ globals: ['OneTrust'], assets: ['https://cdn.cookielaw.org/otSDKStub.js'], cookie_names: ['OptanonConsent'], observations: [{ selector: '#onetrust-banner-sdk', visible: true, enabled: true, text: '' }], shopify })), sessionInput);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toEqual(expect.arrayContaining(['cmp', 'commerce_privacy_runtime']));
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
  });

  it('reports a GPP stub as stub_present through the framework observer', async () => {
    const result = await runConsentV2Session(pageFixture(facts({ globals: ['__gpp'] }), framework(true)), sessionInput);
    expect(result.result.frameworks.gpp).toBe('stub_present');
    expect(result.result.frameworks.reason_codes).toContain('GPP_STUB_PRESENT');
  });

  it('does not classify a newsletter dialog as a custom CMP', async () => {
    const newsletter = facts({ generic: { surfaces: [{ id: 'newsletter', surface_type: 'dialog', visible: true, privacy_or_cookie_semantics: false, intent: 'newsletter' }], controls: [{ surface_id: 'newsletter', visible: true, enabled: true, actionable: true, accessible_name: 'Sign up' }] } });
    const result = await runConsentV2Session(pageFixture(newsletter), sessionInput);
    expect(result.result.mechanisms.some((item) => item.mechanism === 'custom')).toBe(false);
  });

  it('routes an unknown custom consent banner through the generic detector', async () => {
    const custom = facts({ generic: { surfaces: [{ id: 'consent', surface_type: 'banner', visible: true, privacy_or_cookie_semantics: true, intent: 'consent' }], controls: [{ surface_id: 'consent', visible: true, enabled: true, actionable: true, accessible_name: 'Accept all' }, { surface_id: 'consent', visible: true, enabled: true, actionable: true, accessible_name: 'Reject all' }] } });
    const result = await runConsentV2Session(pageFixture(custom), sessionInput);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'custom')?.provider?.reason_codes).toContain('CMP_PROVIDER_UNKNOWN');
  });
});
