import type { CmpProvider, ConsentStatus } from '../../types';
import type {
  ActionAvailability,
  BannerSurface,
  BannerVisibility,
  ConsentActionType,
  ConsentDecision,
  ConsentMechanismType,
  FrameworkPresence,
  PersistenceStatus,
  VerificationStatus
} from './domain-types';
import type { GoogleConsentModeClassification } from './google-consent-mode-observer';
import type { TrackingConsistencyStatus } from './tracking-consistency';

export interface ConsentV2FixtureExpectation {
  provider: CmpProvider | null;
  mechanisms: ConsentMechanismType[];
  banner_state: { surface: BannerSurface; visibility: BannerVisibility };
  actions: Array<{ action: ConsentActionType; availability: ActionAvailability }>;
  consent_state: ConsentDecision;
  verification: VerificationStatus;
  persistence: PersistenceStatus;
  framework_state: { tcf: FrameworkPresence; gpp: FrameworkPresence; usp: FrameworkPresence };
  consent_mode_state: GoogleConsentModeClassification;
  tracking_consistency: TrackingConsistencyStatus;
  external_compatibility: { cmp_provider: CmpProvider | null; consent_status: ConsentStatus };
}

export interface ConsentV2Fixture {
  id: string;
  group: 'onetrust' | 'cookiebot' | 'usercentrics' | 'didomi' | 'cookieyes' | 'sourcepoint' | 'shopify' | 'generic';
  /** All browser fixtures are local and deterministic; no public storefront is referenced. */
  origin: 'https://fixture.local';
  scenarios: string[];
  expected: ConsentV2FixtureExpectation;
}

const base = (overrides: Partial<ConsentV2FixtureExpectation> = {}): ConsentV2FixtureExpectation => ({
  provider: null,
  mechanisms: [],
  banner_state: { surface: 'none', visibility: 'not_visible' },
  actions: [],
  consent_state: 'ambiguous',
  verification: 'inconclusive',
  persistence: 'not_applicable',
  framework_state: { tcf: 'not_present', gpp: 'not_present', usp: 'not_present' },
  consent_mode_state: 'not_configured',
  tracking_consistency: 'not_applicable',
  external_compatibility: { cmp_provider: null, consent_status: 'inconclusive' },
  ...overrides
});

const fixture = (id: string, group: ConsentV2Fixture['group'], scenarios: string[], expected: Partial<ConsentV2FixtureExpectation> = {}): ConsentV2Fixture => ({
  id, group, origin: 'https://fixture.local', scenarios, expected: base(expected)
});

const named = (id: string, group: Exclude<ConsentV2Fixture['group'], 'generic' | 'shopify'>, provider: CmpProvider, scenarios: string[], expected: Partial<ConsentV2FixtureExpectation> = {}) =>
  fixture(id, group, scenarios, {
    provider, mechanisms: ['cmp'], banner_state: { surface: 'banner', visibility: 'visible' },
    external_compatibility: { cmp_provider: provider, consent_status: 'pass' }, ...expected
  });

export const CONSENT_V2_FIXTURES: ConsentV2Fixture[] = [
  named('OT-01', 'onetrust', 'OneTrust', ['detection']),
  named('OT-02', 'onetrust', 'OneTrust', ['direct_reject'], { actions: [{ action: 'reject_all', availability: 'direct' }], consent_state: 'rejected', verification: 'verified' }),
  named('OT-03', 'onetrust', 'OneTrust', ['api_capability'], { actions: [{ action: 'reject_all', availability: 'api_only' }] }),
  named('OT-04', 'onetrust', 'OneTrust', ['preferences_only_reject'], { actions: [{ action: 'open_preferences', availability: 'direct' }, { action: 'reject_all', availability: 'preferences_only' }] }),
  named('OT-05', 'onetrust', 'OneTrust', ['close_not_reject'], { actions: [], verification: 'inconclusive' }),
  named('OT-06', 'onetrust', 'OneTrust', ['custom_category_ids'], { consent_state: 'ambiguous' }),
  named('OT-07', 'onetrust', 'OneTrust', ['tcf'], { framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' } }),
  named('OT-08', 'onetrust', 'OneTrust', ['gpp'], { framework_state: { tcf: 'not_present', gpp: 'present', usp: 'not_present' } }),
  named('OT-09', 'onetrust', 'OneTrust', ['persistence'], { persistence: 'confirmed' }),

  named('CB-01', 'cookiebot', 'Cookiebot', ['detection']),
  named('CB-02', 'cookiebot', 'Cookiebot', ['direct_decline'], { actions: [{ action: 'reject_all', availability: 'direct' }], consent_state: 'rejected', verification: 'verified' }),
  named('CB-03', 'cookiebot', 'Cookiebot', ['decline_event'], { verification: 'inconclusive' }),
  named('CB-04', 'cookiebot', 'Cookiebot', ['semantic_state'], { consent_state: 'rejected' }),
  named('CB-05', 'cookiebot', 'Cookiebot', ['persistence'], { persistence: 'inconclusive' }),
  named('CB-06', 'cookiebot', 'Cookiebot', ['tcf_off']),
  named('CB-07', 'cookiebot', 'Cookiebot', ['tcf_on'], { framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' } }),
  named('CB-08', 'cookiebot', 'Cookiebot', ['customized_controls'], { actions: [{ action: 'reject_all', availability: 'direct' }] }),

  named('UC-01', 'usercentrics', 'Usercentrics', ['uc_ui_detection']),
  named('UC-02', 'usercentrics', 'Usercentrics', ['open_shadow_root']),
  named('UC-03', 'usercentrics', 'Usercentrics', ['semantic_reject'], { actions: [{ action: 'reject_all', availability: 'direct' }], verification: 'verified', consent_state: 'rejected' }),
  named('UC-04', 'usercentrics', 'Usercentrics', ['localized_labels']),
  named('UC-05', 'usercentrics', 'Usercentrics', ['ucdata_ucstring']),
  named('UC-06', 'usercentrics', 'Usercentrics', ['persistence'], { persistence: 'confirmed' }),
  named('UC-07', 'usercentrics', 'Usercentrics', ['api_action_disabled'], { actions: [{ action: 'reject_all', availability: 'not_present' }] }),
  named('UC-08', 'usercentrics', 'Usercentrics', ['tcf'], { framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' } }),

  named('DI-01', 'didomi', 'Didomi', ['detection']),
  named('DI-02', 'didomi', 'Didomi', ['direct_reject'], { actions: [{ action: 'reject_all', availability: 'direct' }], consent_state: 'rejected', verification: 'verified' }),
  named('DI-03', 'didomi', 'Didomi', ['api_capability'], { actions: [{ action: 'reject_all', availability: 'api_only' }] }),
  named('DI-04', 'didomi', 'Didomi', ['preferences_flow'], { actions: [{ action: 'open_preferences', availability: 'direct' }, { action: 'reject_all', availability: 'preferences_only' }] }),
  named('DI-05', 'didomi', 'Didomi', ['consent_changed_event']),
  named('DI-06', 'didomi', 'Didomi', ['semantic_state'], { consent_state: 'rejected' }),
  named('DI-07', 'didomi', 'Didomi', ['tcf'], { framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' } }),
  named('DI-08', 'didomi', 'Didomi', ['persistence'], { persistence: 'inconclusive' }),

  named('CY-01', 'cookieyes', 'CookieYes', ['detection']),
  named('CY-02', 'cookieyes', 'CookieYes', ['direct_reject'], { actions: [{ action: 'reject_all', availability: 'direct' }], verification: 'verified', consent_state: 'rejected' }),
  named('CY-03', 'cookieyes', 'CookieYes', ['api_reject'], { actions: [{ action: 'reject_all', availability: 'api_only' }] }),
  named('CY-04', 'cookieyes', 'CookieYes', ['get_cky_consent'], { consent_state: 'rejected' }),
  named('CY-05', 'cookieyes', 'CookieYes', ['partial_consent'], { consent_state: 'partial' }),
  named('CY-06', 'cookieyes', 'CookieYes', ['persistence'], { persistence: 'confirmed' }),

  named('SP-01', 'sourcepoint', 'Sourcepoint', ['detection']),
  named('SP-02', 'sourcepoint', 'Sourcepoint', ['cross_origin_style_iframe'], { banner_state: { surface: 'dialog', visibility: 'visible' } }),
  named('SP-03', 'sourcepoint', 'Sourcepoint', ['first_layer_actions'], { actions: [{ action: 'reject_all', availability: 'direct' }], verification: 'verified', consent_state: 'rejected' }),
  named('SP-04', 'sourcepoint', 'Sourcepoint', ['privacy_manager_actions'], { actions: [{ action: 'open_preferences', availability: 'direct' }, { action: 'reject_all', availability: 'preferences_only' }] }),
  named('SP-05', 'sourcepoint', 'Sourcepoint', ['tcf_useractioncomplete'], { framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' }, consent_state: 'rejected', verification: 'verified' }),
  named('SP-06', 'sourcepoint', 'Sourcepoint', ['gpp'], { framework_state: { tcf: 'not_present', gpp: 'present', usp: 'not_present' } }),
  named('SP-07', 'sourcepoint', 'Sourcepoint', ['detached_frame'], { banner_state: { surface: 'unknown', visibility: 'unknown' }, verification: 'inconclusive', external_compatibility: { cmp_provider: null, consent_status: 'inconclusive' } }),
  named('SP-08', 'sourcepoint', 'Sourcepoint', ['persistence'], { persistence: 'confirmed' }),

  fixture('SH-01', 'shopify', ['runtime'], { provider: 'Shopify Privacy', mechanisms: ['commerce_privacy_runtime'], consent_state: 'ambiguous', external_compatibility: { cmp_provider: 'Shopify Privacy', consent_status: 'pass' } }),
  fixture('SH-02', 'shopify', ['unanswered'], { provider: 'Shopify Privacy', mechanisms: ['commerce_privacy_runtime'], consent_state: 'unanswered', external_compatibility: { cmp_provider: 'Shopify Privacy', consent_status: 'pass' } }),
  fixture('SH-03', 'shopify', ['granted'], { provider: 'Shopify Privacy', mechanisms: ['commerce_privacy_runtime'], consent_state: 'accepted', external_compatibility: { cmp_provider: 'Shopify Privacy', consent_status: 'pass' } }),
  fixture('SH-04', 'shopify', ['denied'], { provider: 'Shopify Privacy', mechanisms: ['commerce_privacy_runtime'], consent_state: 'rejected', external_compatibility: { cmp_provider: 'Shopify Privacy', consent_status: 'pass' } }),
  fixture('SH-05', 'shopify', ['should_show_banner_false'], { provider: 'Shopify Privacy', mechanisms: ['commerce_privacy_runtime'], external_compatibility: { cmp_provider: 'Shopify Privacy', consent_status: 'pass' } }),
  fixture('SH-06', 'shopify', ['visible_native_surface'], { provider: 'Shopify Privacy', mechanisms: ['commerce_privacy_runtime'], banner_state: { surface: 'banner', visibility: 'visible' }, actions: [{ action: 'reject_all', availability: 'unknown' }], external_compatibility: { cmp_provider: 'Shopify Privacy', consent_status: 'pass' } }),
  fixture('SH-07', 'shopify', ['shopify_plus_onetrust'], { provider: 'OneTrust', mechanisms: ['commerce_privacy_runtime', 'cmp'], external_compatibility: { cmp_provider: 'OneTrust', consent_status: 'pass' } }),
  fixture('SH-08', 'shopify', ['shopify_plus_unknown_cmp'], { provider: 'Unknown', mechanisms: ['commerce_privacy_runtime', 'custom'], external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),

  fixture('GEN-01', 'generic', ['custom_accept_reject'], { provider: 'Unknown', mechanisms: ['custom'], banner_state: { surface: 'banner', visibility: 'visible' }, actions: [{ action: 'accept_all', availability: 'direct' }, { action: 'reject_all', availability: 'direct' }], external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-02', 'generic', ['preferences_only'], { provider: 'Unknown', mechanisms: ['custom'], actions: [{ action: 'open_preferences', availability: 'direct' }, { action: 'reject_all', availability: 'preferences_only' }], external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-03', 'generic', ['json_cookie'], { provider: 'Unknown', mechanisms: ['custom'], external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-04', 'generic', ['local_storage'], { provider: 'Unknown', mechanisms: ['custom'], external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-05', 'generic', ['tcf_only_unknown'], { mechanisms: ['framework'], framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' } }),
  fixture('GEN-06', 'generic', ['gpp_only_unknown'], { mechanisms: ['framework'], framework_state: { tcf: 'not_present', gpp: 'present', usp: 'not_present' } }),
  fixture('GEN-07', 'generic', ['us_privacy_link_only'], { banner_state: { surface: 'link_only', visibility: 'visible' } }),
  fixture('GEN-08', 'generic', ['manual_gtm_gating'], { mechanisms: ['consent_mode'], consent_mode_state: 'manual_gating_candidate' }),
  fixture('GEN-09', 'generic', ['advanced_consent_mode'], { mechanisms: ['consent_mode'], consent_mode_state: 'advanced_candidate' }),
  fixture('GEN-10', 'generic', ['basic_consent_mode'], { mechanisms: ['consent_mode'], consent_mode_state: 'basic_candidate' }),
  fixture('GEN-11', 'generic', ['newsletter_false_positive']),
  fixture('GEN-12', 'generic', ['login_false_positive']),
  fixture('GEN-13', 'generic', ['age_gate_false_positive']),
  fixture('GEN-14', 'generic', ['country_location_selector_false_positive']),
  fixture('GEN-15', 'generic', ['generic_accept_false_positive']),
  fixture('GEN-16', 'generic', ['banner_disappeared_no_state_change'], { provider: 'Unknown', mechanisms: ['custom'], verification: 'inconclusive', external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-17', 'generic', ['reject_clicked_state_remains_granted'], { provider: 'Unknown', mechanisms: ['custom'], consent_state: 'accepted', verification: 'not_verified', external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-18', 'generic', ['verified_reject_meta_event'], { provider: 'Unknown', mechanisms: ['custom'], verification: 'verified', tracking_consistency: 'contradiction', external_compatibility: { cmp_provider: 'Unknown', consent_status: 'consent_leakage' } }),
  fixture('GEN-19', 'generic', ['verified_reject_script_only'], { provider: 'Unknown', mechanisms: ['custom'], verification: 'verified', tracking_consistency: 'consistent', external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-20', 'generic', ['framework_provider_contradiction'], { mechanisms: ['cmp', 'framework'], framework_state: { tcf: 'present', gpp: 'not_present', usp: 'not_present' } }),
  fixture('GEN-21', 'generic', ['closed_shadow_root'], { provider: 'Unknown', mechanisms: ['custom'], verification: 'inconclusive', external_compatibility: { cmp_provider: null, consent_status: 'inconclusive' } }),
  fixture('GEN-22', 'generic', ['navigation_after_save'], { provider: 'Unknown', mechanisms: ['custom'], persistence: 'inconclusive', external_compatibility: { cmp_provider: 'Unknown', consent_status: 'inconclusive' } }),
  fixture('GEN-23', 'generic', ['geo_unverified'], { provider: 'Unknown', mechanisms: ['custom'], external_compatibility: { cmp_provider: null, consent_status: 'inconclusive' } }),
  fixture('GEN-24', 'generic', ['bot_challenge_page'], { external_compatibility: { cmp_provider: null, consent_status: 'inconclusive' } })
];
