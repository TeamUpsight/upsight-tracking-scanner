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

function sampleBucket(key: string) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return hash % 100;
}

/** Stable sampling keeps a domain consistently in or out of the action cohort. */
export function consentV2ActionsEnabledFor(
  controls: ConsentV2RolloutControls,
  provider: ConsentV2RolloutProvider,
  stableKey: string
) {
  return controls.enabled && controls.providers[provider].actions_enabled && sampleBucket(stableKey) < controls.action_sample_percent;
}
