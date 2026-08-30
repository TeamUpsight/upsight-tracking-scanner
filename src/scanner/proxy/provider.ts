import { browserGeoProfile } from '../browser-session';
import { buildBrowserlessCdpUrl, countryForGeo, getExternalProxyForGeo, getProxyCountryHint, parseProxyUrl } from './decodo';

export type ProxyProvider = 'decodo' | 'browserless_residential';
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
  portOffset?: number;
  browserlessHost: string;
  browserlessToken: string;
  sessionTimeoutMs: number;
}) : ProxyAttemptPlan {
  const externalProxyServer = input.provider === 'decodo'
    ? getExternalProxyForGeo(input.geo, input.attempt, input.portOffset || 0)
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
      // Browserless Residential has its own proxy configuration. Do not add an external proxy.
      externalProxyServer: externalProxyServer || undefined,
      builtInProxy: input.provider === 'browserless_residential' ? 'residential' : undefined,
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
