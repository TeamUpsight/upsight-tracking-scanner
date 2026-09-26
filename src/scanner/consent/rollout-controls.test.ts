import { describe, expect, it } from 'vitest';
import { certificationSafeConsentV2RolloutControls, consentV2ActionsEnabledFor, consentV2RolloutControls, legacyAcceptActionEnabled } from './rollout-controls';

describe('Consent V2 rollout controls', () => {
  it('keeps legacy Accept off by default and limits production action to certified Cookiebot', () => {
    const defaultControls = consentV2RolloutControls({});
    expect(legacyAcceptActionEnabled(defaultControls, 'Cookiebot', 'storefront.example')).toBe(false);
    const requested = consentV2RolloutControls({
      CONSENT_V2_ACTIONS_ENABLED: 'true', CONSENT_V2_ACTION_SAMPLE_PERCENT: '100',
      CONSENT_COOKIEBOT_ACTIONS_ENABLED: 'true', CONSENT_USERCENTRICS_ACTIONS_ENABLED: 'true',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true'
    });
    const production = certificationSafeConsentV2RolloutControls(requested, true, { NODE_ENV: 'production' });
    expect(consentV2ActionsEnabledFor(production, 'cookiebot', 'storefront.example')).toBe(true);
    expect(consentV2ActionsEnabledFor(production, 'usercentrics', 'storefront.example')).toBe(false);
    expect(consentV2ActionsEnabledFor(production, 'onetrust', 'storefront.example')).toBe(false);
    expect(legacyAcceptActionEnabled(production, 'Cookiebot', 'storefront.example')).toBe(true);
    expect(legacyAcceptActionEnabled(production, 'Usercentrics', 'storefront.example')).toBe(false);
    expect(legacyAcceptActionEnabled(production, 'TrustArc', 'storefront.example')).toBe(false);
    const missingMode = certificationSafeConsentV2RolloutControls(requested, true, {});
    expect(legacyAcceptActionEnabled(missingMode, 'Usercentrics', 'storefront.example')).toBe(false);
    const uncertified = certificationSafeConsentV2RolloutControls(requested, false, { NODE_ENV: 'production' });
    expect(legacyAcceptActionEnabled(uncertified, 'Cookiebot', 'storefront.example')).toBe(false);
  });
  it('defaults to observation-only while retaining provider detection', () => {
    const controls = consentV2RolloutControls({});
    expect(controls.enabled).toBe(true);
    expect(controls.providers.onetrust.detection_enabled).toBe(true);
    expect(controls.providers.onetrust.actions_enabled).toBe(false);
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'storefront.example')).toBe(false);
  });

  it('can disable provider detection without disabling the overall V2 audit', () => {
    const controls = consentV2RolloutControls({ CONSENT_COOKIEBOT_ENABLED: 'false' });
    expect(controls.enabled).toBe(true);
    expect(controls.providers.cookiebot.detection_enabled).toBe(false);
    expect(controls.providers.onetrust.detection_enabled).toBe(true);
  });

  it('disables the V2 session and every action cohort when the global flag is false', () => {
    const controls = consentV2RolloutControls({
      CONSENT_V2_ENABLED: 'false',
      CONSENT_V2_ACTIONS_ENABLED: 'true',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true',
      CONSENT_V2_ACTION_SAMPLE_PERCENT: '100'
    });
    expect(controls.enabled).toBe(false);
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'storefront.example')).toBe(false);
  });

  it('keeps actions disabled when the global actions flag is false even if provider and sample gates are open', () => {
    const controls = consentV2RolloutControls({
      CONSENT_V2_ACTIONS_ENABLED: 'false',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true',
      CONSENT_V2_ACTION_SAMPLE_PERCENT: '100'
    });
    expect(controls.providers.onetrust.actions_enabled).toBe(false);
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'storefront.example')).toBe(false);
  });

  it('requires global, provider, and sample controls before permitting an action', () => {
    const controls = consentV2RolloutControls({
      CONSENT_V2_ACTIONS_ENABLED: 'true',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true',
      CONSENT_V2_ACTION_SAMPLE_PERCENT: '100'
    });
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'storefront.example')).toBe(true);
    expect(consentV2ActionsEnabledFor(controls, 'cookiebot', 'storefront.example')).toBe(false);
  });

  it('keeps a storefront in the same cohort across routes, query strings, fragments, and same-host redirects', () => {
    const controls = consentV2RolloutControls({
      CONSENT_V2_ACTIONS_ENABLED: 'true',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true',
      CONSENT_V2_ACTION_SAMPLE_PERCENT: '47'
    });
    const cohort = consentV2ActionsEnabledFor(controls, 'onetrust', 'https://storefront.example/');
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'https://storefront.example/products/item?campaign=1#details')).toBe(cohort);
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'storefront.example')).toBe(cohort);
  });

  it('does not enroll any provider at sample zero and enrolls an enabled provider at one hundred', () => {
    const base = { CONSENT_V2_ACTIONS_ENABLED: 'true', CONSENT_ONETRUST_ACTIONS_ENABLED: 'true' };
    expect(consentV2ActionsEnabledFor(consentV2RolloutControls({ ...base, CONSENT_V2_ACTION_SAMPLE_PERCENT: '0' }), 'onetrust', 'storefront.example')).toBe(false);
    expect(consentV2ActionsEnabledFor(consentV2RolloutControls({ ...base, CONSENT_V2_ACTION_SAMPLE_PERCENT: '100' }), 'onetrust', 'storefront.example')).toBe(true);
  });
});
