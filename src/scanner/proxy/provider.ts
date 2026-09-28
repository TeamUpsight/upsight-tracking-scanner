import { browserGeoProfile } from '../browser-session';
import type { AuditModule } from '../../types';
import { buildBrowserlessCdpUrl, countryForGeo, getExternalProxyForGeo, getProxyCountryHint, parseProxyUrl } from './decodo';

export type ProxyProvider = 'browserless_direct' | 'browserless_datacenter' | 'decodo' | 'browserless_residential';

export function initialProxyProvider(modules: AuditModule[]): ProxyProvider {
  return modules.includes('consent') ? 'decodo' : 'browserless_direct';
}

export function nextNonConsentProvider(provider: ProxyProvider, residentialEnabled: boolean, isBulk = false): ProxyProvider | null {
  if (provider === 'browserless_direct') return 'browserless_datacenter';
  if (provider === 'browserless_datacenter') return 'decodo';
  if (provider === 'decodo' && residentialEnabled && !isBulk) return 'browserless_residential';
  return null;
}

export function shouldProbeProxyEgress(input: {
  provider: ProxyProvider;
  consentSelected: boolean;
  diagnostic: boolean;
  configured: boolean;
  neutral: boolean;
}): boolean {
  return input.provider !== 'browserless_direct' &&
    (input.neutral || input.consentSelected || input.diagnostic || input.configured);
}
export type ProxyFailureClassification =
  | 'PROXY_PROVIDER_UNREACHABLE'
  | 'PROXY_EXTERNAL_TUNNEL_FAILED'
  | 'PROXY_TARGET_TUNNEL_FAILED';

export interface ProxyAttemptPlan {
  provider: ProxyProvider;
  attempt: number;
  geo: string;
  country: string;
  port: number | null;
  externalProxyServer?: string;
  cdpUrl: string;
}

export function buildProxyAttemptPlan(input: {
  provider: ProxyProvider;
  geo: string;
  attempt: number;
  exactCountry?: string | null;
  portOffset?: number;
  browserlessHost: string;
  browserlessToken: string;
  sessionTimeoutMs: number;
}) : ProxyAttemptPlan {
  const externalProxyServer = input.provider === 'decodo'
    ? getExternalProxyForGeo(input.geo, input.attempt, input.portOffset || 0, input.exactCountry)
    : '';
  if (input.provider === 'decodo' && !externalProxyServer) throw new Error(`No valid Decodo proxy is configured for ${input.geo}`);
  const country = input.provider === 'decodo'
    ? getProxyCountryHint(externalProxyServer, input.geo, input.attempt)
    : countryForGeo(input.geo, input.attempt);
  const profile = browserGeoProfile(country);
  return {
    provider: input.provider,
    attempt: input.attempt,
    geo: input.geo,
    country,
    port: input.provider === 'decodo' ? parseProxyUrl(externalProxyServer).port : null,
    ...(externalProxyServer ? { externalProxyServer } : {}),
    cdpUrl: buildBrowserlessCdpUrl({
      host: input.browserlessHost,
      token: input.browserlessToken,
      route: 'stealth',
      // Built-in Browserless proxies must not be combined with an external proxy.
      externalProxyServer: externalProxyServer || undefined,
      builtInProxy: input.provider === 'browserless_residential' ? 'residential'
        : input.provider === 'browserless_datacenter' ? 'datacenter' : undefined,
      proxyCountry: input.provider === 'browserless_residential' ? country : undefined,
      proxySticky: input.provider === 'browserless_residential',
      proxyLocaleMatch: input.provider === 'browserless_residential',
      timeoutMs: input.sessionTimeoutMs,
      browserLocale: profile.locale
    })
  };
}

export function classifyConfirmedTunnelFailure(phase: 'connect' | 'target', neutralProbeSucceeded?: boolean): ProxyFailureClassification {
  if (phase === 'connect') return 'PROXY_PROVIDER_UNREACHABLE';
  return neutralProbeSucceeded ? 'PROXY_TARGET_TUNNEL_FAILED' : 'PROXY_EXTERNAL_TUNNEL_FAILED';
}

export function shouldUseBrowserlessResidentialFallback(input: { isBulk?: boolean; enabled?: boolean }) {
  return input.isBulk !== true && input.enabled === true;
}

/** A Browserless Residential session may be freshened once for transient
 * transport trouble. Authentication, plan, and configuration errors never
 * meet this narrow classifier. */
export function shouldRetryBrowserlessResidential(input: {
  isBulk?: boolean;
  alreadyRetried: boolean;
  rawFailure: string;
  remainingMs: number;
  minRemainingMs: number;
}) {
  return input.isBulk !== true && !input.alreadyRetried && input.remainingMs >= input.minRemainingMs &&
    ['PROXY_TUNNEL_FAILED', 'PROXY_CONNECTION_RESET', 'PROXY_CONNECTION_FAILED'].includes(input.rawFailure);
}
