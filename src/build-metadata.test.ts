import { afterEach, describe, expect, it, vi } from 'vitest';
import { certificationSafeConsentV2RolloutControls, consentV2ActionsEnabledFor, consentV2RolloutControls } from './scanner/consent/rollout-controls';

afterEach(() => vi.unstubAllEnvs());

describe('scanner execution provenance', () => {
  it('labels direct source execution noncertifiable despite environment-supplied build claims', async () => {
    vi.stubEnv('BUILD_COMMIT', 'a'.repeat(40));
    vi.stubEnv('BUILD_DIRTY', 'false');
    vi.resetModules();
    const { buildMetadata } = await import('./build-metadata');
    expect(buildMetadata).toMatchObject({
      scanner_execution_mode: 'direct_source', build_commit: null, build_dirty: true,
      certification_eligible: false, execution_diagnostic: 'non_certifiable_execution_mode'
    });
  });

  it('disables every CMP action while retaining detection and compiled rollout settings', () => {
    const controls = consentV2RolloutControls({
      CONSENT_V2_ENABLED: 'true', CONSENT_V2_ACTIONS_ENABLED: 'true',
      CONSENT_V2_ACTION_SAMPLE_PERCENT: '100', CONSENT_USERCENTRICS_ACTIONS_ENABLED: 'true',
      CONSENT_ONETRUST_ACTIONS_ENABLED: 'true'
    });
    expect(consentV2ActionsEnabledFor(controls, 'usercentrics', 'example.test')).toBe(true);
    expect(certificationSafeConsentV2RolloutControls(controls, true)).toBe(controls);
    const gated = certificationSafeConsentV2RolloutControls(controls, false);
    expect(gated.enabled).toBe(true);
    expect(gated.providers.usercentrics.detection_enabled).toBe(true);
    expect(gated.actions_enabled).toBe(false);
    expect(Object.values(gated.providers).every((provider) => !provider.actions_enabled)).toBe(true);
    expect(consentV2ActionsEnabledFor(gated, 'usercentrics', 'example.test')).toBe(false);
    expect(consentV2ActionsEnabledFor(gated, 'onetrust', 'example.test')).toBe(false);
  });
});
