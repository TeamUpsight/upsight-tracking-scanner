import type { ProxyProvider } from './proxy/provider';

export type AccessEvent = 'valid_storefront' | 'proxy_failure' | 'challenge' | 'rate_limited' | 'unrecoverable';
export type AccessAction = 'continue' | 'retry_decodo' | 'fallback_browserless_residential' | 'solve_challenge' | 'finalize';

// A coherent access identity is retired as a unit. Browser/context objects stay
// owned by the runner; this is the sanitized decision/telemetry representation.
export interface AccessIdentity {
  provider: ProxyProvider;
  geo: string;
  proxyPort: number | null;
  proxySession: 'fresh';
  browserSession: 'fresh';
  context: 'fresh' | 'browserless_default';
  locale: string;
  timezone: string;
  attempt: number;
}

export function decideAccessTransition(input: {
  event: AccessEvent;
  isBulk?: boolean;
  decodoAttempts: number;
  maxDecodoRetries: number;
  fallbackEnabled: boolean;
  challengeSolvingEnabled: boolean;
}) : AccessAction {
  if (input.event === 'valid_storefront') return 'continue';
  if ((input.event === 'proxy_failure' || input.event === 'rate_limited') && input.decodoAttempts < input.maxDecodoRetries) {
    return 'retry_decodo';
  }
  if (input.event === 'challenge' && input.challengeSolvingEnabled && !input.isBulk) return 'solve_challenge';
  if ((input.event === 'proxy_failure' || input.event === 'challenge') && !input.isBulk && input.fallbackEnabled) {
    return 'fallback_browserless_residential';
  }
  return 'finalize';
}
