import { describe, expect, it } from 'vitest';
import { CONSENT_V2_FIXTURES, type ConsentV2Fixture } from './consent-v2-fixtures';

const providerMinimums: Record<Exclude<ConsentV2Fixture['group'], 'generic' | 'shopify'>, string[]> = {
  onetrust: ['detection', 'direct_reject', 'api_capability', 'preferences_only_reject', 'close_not_reject', 'custom_category_ids', 'tcf', 'gpp', 'persistence'],
  cookiebot: ['detection', 'direct_decline', 'decline_event', 'semantic_state', 'persistence', 'tcf_off', 'tcf_on', 'customized_controls'],
  usercentrics: ['uc_ui_detection', 'open_shadow_root', 'semantic_reject', 'localized_labels', 'ucdata_ucstring', 'persistence', 'api_action_disabled', 'tcf'],
  didomi: ['detection', 'direct_reject', 'api_capability', 'preferences_flow', 'consent_changed_event', 'semantic_state', 'tcf', 'persistence'],
  cookieyes: ['detection', 'direct_reject', 'api_reject', 'get_cky_consent', 'partial_consent', 'persistence'],
  sourcepoint: ['detection', 'cross_origin_style_iframe', 'first_layer_actions', 'privacy_manager_actions', 'tcf_useractioncomplete', 'gpp', 'detached_frame', 'persistence']
};

const genericMinimums = [
  'custom_accept_reject', 'preferences_only', 'json_cookie', 'local_storage', 'tcf_only_unknown', 'gpp_only_unknown',
  'us_privacy_link_only', 'manual_gtm_gating', 'advanced_consent_mode', 'basic_consent_mode', 'newsletter_false_positive',
  'login_false_positive', 'age_gate_false_positive', 'country_location_selector_false_positive', 'generic_accept_false_positive',
  'banner_disappeared_no_state_change', 'reject_clicked_state_remains_granted', 'verified_reject_meta_event',
  'verified_reject_script_only', 'framework_provider_contradiction', 'closed_shadow_root', 'navigation_after_save',
  'geo_unverified', 'bot_challenge_page'
];

describe('complete deterministic Consent V2 fixture contracts', () => {
  it('uses unique local-only fixture identifiers and never embeds public storefronts', () => {
    expect(new Set(CONSENT_V2_FIXTURES.map((fixture) => fixture.id)).size).toBe(CONSENT_V2_FIXTURES.length);
    expect(CONSENT_V2_FIXTURES.every((fixture) => fixture.origin === 'https://fixture.local')).toBe(true);
    expect(JSON.stringify(CONSENT_V2_FIXTURES)).not.toMatch(/https?:\/\/(?!fixture\.local)/);
  });

  it('declares every output dimension required for a V2 compatibility run', () => {
    for (const fixture of CONSENT_V2_FIXTURES) {
      for (const key of ['provider', 'mechanisms', 'banner_state', 'actions', 'consent_state', 'verification', 'persistence', 'framework_state', 'consent_mode_state', 'tracking_consistency', 'external_compatibility']) {
        expect(Object.hasOwn(fixture.expected, key), `${fixture.id}:${key}`).toBe(true);
      }
      expect(Array.isArray(fixture.expected.mechanisms), `${fixture.id}:mechanisms`).toBe(true);
      expect(Array.isArray(fixture.expected.actions), `${fixture.id}:actions`).toBe(true);
      expect(typeof fixture.expected.banner_state).toBe('object');
      expect(typeof fixture.expected.framework_state).toBe('object');
      expect(typeof fixture.expected.external_compatibility).toBe('object');
    }
  });

  it('contains every P0 provider fixture minimum', () => {
    for (const [group, scenarios] of Object.entries(providerMinimums)) {
      const covered = new Set(CONSENT_V2_FIXTURES.filter((fixture) => fixture.group === group).flatMap((fixture) => fixture.scenarios));
      for (const scenario of scenarios) expect(covered.has(scenario), `${group}:${scenario}`).toBe(true);
    }
  });

  it('contains Shopify composition fixtures and every aggressive generic/negative fixture', () => {
    const shopify = new Set(CONSENT_V2_FIXTURES.filter((fixture) => fixture.group === 'shopify').flatMap((fixture) => fixture.scenarios));
    expect(['runtime', 'unanswered', 'granted', 'denied', 'should_show_banner_false', 'visible_native_surface', 'shopify_plus_onetrust', 'shopify_plus_unknown_cmp'].every((scenario) => shopify.has(scenario))).toBe(true);
    const generic = new Set(CONSENT_V2_FIXTURES.filter((fixture) => fixture.group === 'generic').flatMap((fixture) => fixture.scenarios));
    for (const scenario of genericMinimums) expect(generic.has(scenario), scenario).toBe(true);
  });

  it('does not place raw consent payloads, query strings, or user identifiers in fixture contracts', () => {
    const serialized = JSON.stringify(CONSENT_V2_FIXTURES);
    expect(serialized).not.toMatch(/(?:euconsent|gpp_string|usp_string|cookie_value|localstorage_value|sessionid|userid|[?&](?:token|id)=)/i);
  });
});
