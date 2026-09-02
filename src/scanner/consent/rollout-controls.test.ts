import { describe, expect, it } from 'vitest';
import { consentV2ActionsEnabledFor, consentV2RolloutControls } from './rollout-controls';

describe('Consent V2 rollout controls', () => {
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

  it('requires global, provider, and sample controls before permitting an action', () => {
    const controls = consentV2RolloutControls({
      CONSENT_V2_ACTIONS_ENABLED: 'true',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true',
      CONSENT_V2_ACTION_SAMPLE_PERCENT: '100'
    });
    expect(consentV2ActionsEnabledFor(controls, 'onetrust', 'storefront.example')).toBe(true);
    expect(consentV2ActionsEnabledFor(controls, 'cookiebot', 'storefront.example')).toBe(false);
  });
});
