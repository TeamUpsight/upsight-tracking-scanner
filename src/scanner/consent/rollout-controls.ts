import { boundedInteger } from '../../shared/config';

export const CONSENT_V2_ROLLOUT_PROVIDERS = [
  'onetrust', 'cookiebot', 'usercentrics', 'didomi', 'cookieyes', 'sourcepoint', 'shopify', 'generic'
] as const;

export type ConsentV2RolloutProvider = typeof CONSENT_V2_ROLLOUT_PROVIDERS[number];

export interface ConsentV2RolloutControls {
  enabled: boolean;
  actions_enabled: boolean;
  action_sample_percent: number;
  providers: Record<ConsentV2RolloutProvider, { detection_enabled: boolean; actions_enabled: boolean }>;
}

function enabled(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  return value === 'true';
}

function providerEnvironmentName(provider: ConsentV2RolloutProvider) {
  return provider.toUpperCase();
}

/**
 * Environment-only rollout controls. Detection is on by default, while all
 * interaction is explicit opt-in so a newly deployed V2 runs observation-only.
 */
export function consentV2RolloutControls(environment: NodeJS.ProcessEnv = process.env): ConsentV2RolloutControls {
  const actionsEnabled = enabled(environment.CONSENT_V2_ACTIONS_ENABLED, false);
  const providers = Object.fromEntries(CONSENT_V2_ROLLOUT_PROVIDERS.map((provider) => {
    const name = providerEnvironmentName(provider);
    return [provider, {
      detection_enabled: enabled(environment[`CONSENT_${name}_ENABLED`], true),
      actions_enabled: actionsEnabled && enabled(environment[`CONSENT_${name}_ACTIONS_ENABLED`], false)
    }];
  })) as ConsentV2RolloutControls['providers'];
  return {
    enabled: enabled(environment.CONSENT_V2_ENABLED, true),
    actions_enabled: actionsEnabled,
    action_sample_percent: boundedInteger(environment.CONSENT_V2_ACTION_SAMPLE_PERCENT, 0, 0, 100),
    providers
  };
}

/** Audit-runner boundary: an unproven execution artifact cannot activate CMP controls. */
export function certificationSafeConsentV2RolloutControls(
  controls: ConsentV2RolloutControls,
  certificationEligible: boolean,
  environment: NodeJS.ProcessEnv = process.env
): ConsentV2RolloutControls {
  if (certificationEligible && environment.NODE_ENV === 'test') return controls;
  return {
    ...controls,
    actions_enabled: certificationEligible && controls.actions_enabled,
    action_sample_percent: certificationEligible ? controls.action_sample_percent : 0,
    providers: Object.fromEntries(CONSENT_V2_ROLLOUT_PROVIDERS.map((provider) => [provider, {
      ...controls.providers[provider], actions_enabled: certificationEligible &&
        (environment.NODE_ENV === 'test' || provider === 'cookiebot') && controls.providers[provider].actions_enabled
    }])) as ConsentV2RolloutControls['providers']
  };
}

/** Legacy Product/Accept comparisons may act only through an explicit certified provider gate. */
export function legacyAcceptActionEnabled(
  controls: ConsentV2RolloutControls,
  provider: string,
  stableKey: string
): boolean {
  const id = ({ Cookiebot: 'cookiebot', OneTrust: 'onetrust', Usercentrics: 'usercentrics',
    Didomi: 'didomi', CookieYes: 'cookieyes', Sourcepoint: 'sourcepoint' } as Record<string, ConsentV2RolloutProvider>)[provider];
  return Boolean(id && consentV2ActionsEnabledFor(controls, id, stableKey));
}

function sampleBucket(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return hash % 100;
}

/**
 * Cohort assignment follows the storefront hostname, not the route used for
 * this audit. Callers should prefer the submitted normalized domain so a
 * redirect to another host cannot move the same audit target between cohorts.
 */
export function normalizeConsentV2RolloutKey(key: string) {
  const trimmed = key.trim();
  try {
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return new URL(url).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Stable sampling keeps a domain consistently in or out of the action cohort. */
export function consentV2ActionsEnabledFor(
  controls: ConsentV2RolloutControls,
  provider: ConsentV2RolloutProvider,
  stableKey: string
) {
  return controls.enabled && controls.providers[provider].actions_enabled &&
    sampleBucket(normalizeConsentV2RolloutKey(stableKey)) < controls.action_sample_percent;
}
