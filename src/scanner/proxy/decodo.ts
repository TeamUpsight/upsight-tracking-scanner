const VALID_EU_COUNTRIES = new Set(['de', 'nl', 'fr', 'it', 'es']);

export interface ProxyMetrics {
  total_connects_by_geo: Record<string, number>;
  errors_by_geo: Record<string, number>;
  total_connects_by_port: Record<number, number>;
  errors_by_port: Record<number, number>;
  retry_attempts_by_port: Record<number, number>;
  retry_successes_by_port: Record<number, number>;
  retry_attempts_after_port_rotation: number;
  retry_successes_after_port_rotation: number;
  total_connect_time_by_port: Record<number, number>;
  connect_count_by_port: Record<number, number>;
}

export type ProxyMetricKind = 'connect' | 'error' | 'retry' | 'retry_success' | 'storefront_success';

export interface ProxyMetricEvent {
  kind: ProxyMetricKind;
  geo: string;
  port: number | null;
  duration_ms?: number;
  rotated?: boolean;
  occurred_at?: string;
}

interface PortHealthState {
  consecutive_errors: number;
  quarantined_until: number;
  last_success_at: number | null;
}

const portHealth = new Map<string, PortHealthState>();
const proxyPortAllocationCursor = new Map<string, number>();

function healthKey(geo: string, port: number) {
  return `${geo.toUpperCase()}:${port}`;
}

function stateFor(geo: string, port: number) {
  const key = healthKey(geo, port);
  const existing = portHealth.get(key) || { consecutive_errors: 0, quarantined_until: 0, last_success_at: null };
  portHealth.set(key, existing);
  return existing;
}

export function hydrateProxyHealth(rows: Array<{ geo: string; port: number; consecutive_errors?: number; quarantined_until?: string | null; last_success_at?: string | null }>) {
  for (const row of rows) {
    if (!Number.isInteger(row.port)) continue;
    portHealth.set(healthKey(row.geo, row.port), {
      consecutive_errors: Math.max(0, Number(row.consecutive_errors || 0)),
      quarantined_until: row.quarantined_until ? new Date(row.quarantined_until).getTime() : 0,
      last_success_at: row.last_success_at ? new Date(row.last_success_at).getTime() : null
    });
  }
}

export function getProxyHealthSnapshot() {
  const now = Date.now();
  return Object.fromEntries([...portHealth.entries()].map(([key, value]) => [key, {
    consecutive_errors: value.consecutive_errors,
    quarantined: value.quarantined_until > now,
    quarantined_until: value.quarantined_until ? new Date(value.quarantined_until).toISOString() : null,
    last_success_at: value.last_success_at ? new Date(value.last_success_at).toISOString() : null
  }]));
}

export const proxyMetrics: ProxyMetrics = {
  total_connects_by_geo: {},
  errors_by_geo: {},
  total_connects_by_port: {},
  errors_by_port: {},
  retry_attempts_by_port: {},
  retry_successes_by_port: {},
  retry_attempts_after_port_rotation: 0,
  retry_successes_after_port_rotation: 0,
  total_connect_time_by_port: {},
  connect_count_by_port: {}
};

export function isValidProxy(proxy: string) {
  if (!proxy) return false;
  try {
    const parsed = new URL(proxy);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'socks5:') &&
      Boolean(parsed.hostname) && Boolean(parsed.port);
  } catch {
    return false;
  }
}

export function parseProxyUrl(proxy: string) {
  try {
    const parsed = new URL(proxy);
    return { host: parsed.hostname, port: Number(parsed.port) || null, protocol: parsed.protocol.replace(':', '') };
  } catch {
    return { host: 'unknown', port: null, protocol: 'unknown' };
  }
}

export function getProxyPortsForGeo(geo: string) {
  const value = process.env[`DECODO_PROXY_${geo.toUpperCase()}_PORTS`] || '';
  return [...new Set(value.split(',')
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535))]
    .slice(0, 20);
}

export function setProxyPort(proxy: string, port: number) {
  if (!isValidProxy(proxy)) return proxy;
  const parsed = new URL(proxy);
  parsed.port = String(port);
  return parsed.toString();
}

export function countryForGeo(geo: string, attempt = 0) {
  const normalized = geo.toUpperCase();
  if (normalized === 'USA') return 'us';
  if (normalized === 'UK') return 'gb';
  const configured = (process.env.DECODO_PROXY_EU_COUNTRY_FALLBACKS || 'de,nl,fr,it,es')
    .split(',').map((country) => country.trim().toLowerCase())
    .filter((country) => VALID_EU_COUNTRIES.has(country));
  const countries = configured.length ? configured : ['de', 'nl', 'fr', 'it', 'es'];
  return countries[attempt % countries.length];
}

export function getProxyCountryHint(proxy: string, geo: string, attempt = 0) {
  if (isValidProxy(proxy)) {
    const parsed = new URL(proxy);
    const username = decodeURIComponent(parsed.username || '');
    const advancedCountry = username.match(/-country-([a-z]{2})(?:-|$)/i)?.[1];
    if (advancedCountry) return advancedCountry.toLowerCase();
    const endpointCountry = parsed.hostname.toLowerCase().match(/^([a-z]{2})\.decodo\.com$/)?.[1];
    if (endpointCountry && endpointCountry !== 'eu') return endpointCountry === 'uk' ? 'gb' : endpointCountry;
  }
  return countryForGeo(geo, attempt);
}

export function validateProxyConfiguration(maxRetries = 1) {
  const issues: Array<{ geo: string; code: string; message: string }> = [];
  for (const geo of ['USA', 'UK', 'EU']) {
    const proxy = process.env[`DECODO_PROXY_${geo}`] || '';
    if (!proxy) {
      issues.push({ geo, code: 'PROXY_NOT_CONFIGURED', message: `DECODO_PROXY_${geo} is not configured.` });
      continue;
    }
    if (!isValidProxy(proxy)) {
      issues.push({ geo, code: 'PROXY_INVALID', message: `DECODO_PROXY_${geo} is not a valid proxy URL.` });
      continue;
    }
    const parsed = new URL(proxy);
    const ports = getProxyPortsForGeo(geo);
    if (ports.length && ports.length < Math.min(maxRetries + 1, 2)) {
      issues.push({ geo, code: 'PROXY_PORT_ROTATION_LIMITED', message: `${geo} needs at least two distinct configured ports for an effective retry.` });
    }
    if (!ports.length && !isBackconnectProxy(parsed)) {
      issues.push({ geo, code: 'PROXY_PORTS_NOT_CONFIGURED', message: `${geo} has no configured alternate sticky ports.` });
    }
  }
  return issues;
}

function isBackconnectProxy(parsed: URL) {
  const configuredGateway = (process.env.DECODO_ROTATING_GATEWAY_HOST || 'gate.decodo.com').toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  return parsed.port === '7000' || hostname === 'gate.decodo.com' || hostname === configuredGateway;
}

function rotateExistingSessionUsername(username: string, sessionId: string) {
  return /-session-(?!duration-)[^-]+/i.test(username)
    ? username.replace(/-session-(?!duration-)[^-]+/i, `-session-${sessionId}`)
    : username;
}

function normalizeSessionDuration(username: string) {
  const match = username.match(/-sessionduration-([^-]+)/i);
  if (!match) return `${username}-sessionduration-60`;
  const duration = Number(match[1]);
  return Number.isInteger(duration) && duration >= 1 && duration <= 1440
    ? username
    : username.replace(/-sessionduration-[^-]+/i, '-sessionduration-60');
}

function ensureAdvancedUsername(username: string) {
  return /^user-/i.test(username) ? username : `user-${username}`;
}

export function rotateDecodoSessionUsername(username: string, geo: string, sessionId: string) {
  if (!username) return '';
  const country = geo.length === 2 ? geo.toLowerCase() : countryForGeo(geo);
  let result = username;
  result = /-country-[^-]+/i.test(result)
    ? result.replace(/-country-[^-]+/i, `-country-${country}`)
    : `${result}-country-${country}`;
  result = /-session-(?!duration-)[^-]+/i.test(result)
    ? result.replace(/-session-(?!duration-)[^-]+/i, `-session-${sessionId}`)
    : `${result}-session-${sessionId}`;
  return normalizeSessionDuration(result);
}

export function reserveProxyPortOffset(geo: string) {
  const normalized = geo.toUpperCase();
  const ports = getProxyPortsForGeo(normalized);
  if (!ports.length) return 0;
  const current = proxyPortAllocationCursor.get(normalized) || 0;
  proxyPortAllocationCursor.set(normalized, (current + 1) % ports.length);
  return current % ports.length;
}

export function getExternalProxyForGeo(geo: string, attempt = 0, portOffset = 0) {
  const normalized = geo.toUpperCase();
  const configured = process.env[`DECODO_PROXY_${normalized}`] || '';
  if (!configured || !isValidProxy(configured)) return '';
  const parsed = new URL(configured);
  const ports = getProxyPortsForGeo(normalized);
  const healthyPorts = ports.filter((port) => stateFor(normalized, port).quarantined_until <= Date.now());
  const selectablePorts = healthyPorts.length ? healthyPorts : ports;
  if (selectablePorts.length) parsed.port = String(selectablePorts[(portOffset + attempt) % selectablePorts.length]);
  if (parsed.username) {
    const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const username = decodeURIComponent(parsed.username);
    parsed.username = isBackconnectProxy(parsed)
      ? rotateDecodoSessionUsername(ensureAdvancedUsername(username), countryForGeo(normalized, attempt), sessionId)
      : rotateExistingSessionUsername(username, sessionId);
  }
  return parsed.toString();
}

export function buildRotatingFallbackProxy(baseProxy: string, geo: string) {
  if (process.env.DECODO_ENABLE_ROTATING_GATEWAY_FALLBACK !== 'true' || !isValidProxy(baseProxy)) return '';
  const parsed = new URL(baseProxy);
  const host = process.env.DECODO_ROTATING_GATEWAY_HOST || 'gate.decodo.com';
  const port = boundedInteger(process.env.DECODO_ROTATING_GATEWAY_PORT, 7000, 1, 65_535);
  if (!host) return '';
  parsed.hostname = host;
  parsed.port = String(port);
  if (parsed.username) {
    parsed.username = rotateDecodoSessionUsername(
      ensureAdvancedUsername(decodeURIComponent(parsed.username)),
      countryForGeo(geo, 0),
      `gateway${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    );
  }
  return parsed.toString();
}

export function buildBrowserlessCdpUrl(options: {
  host: string;
  token: string;
  route: 'standard' | 'stealth';
  externalProxyServer?: string;
  solveCaptchas?: boolean;
  timeoutMs?: number;
  browserLocale?: string;
  builtInProxy?: 'residential' | 'datacenter';
  proxyCountry?: string;
  proxySticky?: boolean;
  proxyLocaleMatch?: boolean;
}) {
  const params = new URLSearchParams({ token: options.token });
  if (options.externalProxyServer) params.set('externalProxyServer', options.externalProxyServer);
  if (!options.externalProxyServer && options.builtInProxy) params.set('proxy', options.builtInProxy);
  if (!options.externalProxyServer && options.proxyCountry) params.set('proxyCountry', options.proxyCountry);
  if (!options.externalProxyServer && options.proxySticky) params.set('proxySticky', 'true');
  if (!options.externalProxyServer && options.proxyLocaleMatch) params.set('proxyLocaleMatch', 'true');
  if (options.solveCaptchas) params.set('solveCaptchas', 'true');
  if (options.timeoutMs) params.set('timeout', String(options.timeoutMs));
  if (options.browserLocale) {
    params.set('launch', JSON.stringify({ args: [`--lang=${options.browserLocale}`, '--window-size=1280,800'] }));
  }
  return `wss://${options.host}${options.route === 'stealth' ? '/stealth' : ''}?${params.toString()}`;
}

export function summarizeCdpUrlForTrace(cdpUrl: string) {
  try {
    const parsed = new URL(cdpUrl);
    return {
      host: parsed.host,
      route: parsed.pathname || '/',
      has_token: parsed.searchParams.has('token'),
      has_external_proxy: parsed.searchParams.has('externalProxyServer'),
      proxy_mode: parsed.searchParams.has('externalProxyServer') ? 'external' : parsed.searchParams.get('proxy') || 'direct',
      proxy_country: parsed.searchParams.get('proxyCountry'),
      solve_captchas: parsed.searchParams.get('solveCaptchas') === 'true'
    };
  } catch {
    return { host: 'unknown', route: 'unknown', has_token: false, has_external_proxy: false, solve_captchas: false };
  }
}

export function recordProxyConnect(geo: string, port: number | null, durationMs: number) {
  proxyMetrics.total_connects_by_geo[geo] = (proxyMetrics.total_connects_by_geo[geo] || 0) + 1;
  if (port === null) return;
  proxyMetrics.total_connects_by_port[port] = (proxyMetrics.total_connects_by_port[port] || 0) + 1;
  proxyMetrics.total_connect_time_by_port[port] = (proxyMetrics.total_connect_time_by_port[port] || 0) + durationMs;
  proxyMetrics.connect_count_by_port[port] = (proxyMetrics.connect_count_by_port[port] || 0) + 1;
}

export function recordProxyError(geo: string, port: number | null) {
  proxyMetrics.errors_by_geo[geo] = (proxyMetrics.errors_by_geo[geo] || 0) + 1;
  if (port !== null) {
    proxyMetrics.errors_by_port[port] = (proxyMetrics.errors_by_port[port] || 0) + 1;
    const state = stateFor(geo, port);
    state.consecutive_errors += 1;
    const threshold = boundedInteger(process.env.PROXY_PORT_ERROR_THRESHOLD, 3, 2, 20);
    if (state.consecutive_errors >= threshold) {
      state.quarantined_until = Date.now() + boundedInteger(process.env.PROXY_PORT_QUARANTINE_MS, 600_000, 30_000, 86_400_000);
    }
  }
}

export function recordProxySuccess(geo: string, port: number | null) {
  if (port === null) return;
  const state = stateFor(geo, port);
  state.consecutive_errors = 0;
  state.quarantined_until = 0;
  state.last_success_at = Date.now();
}

export function recordProxyRetry(port: number | null, rotated: boolean, success = false) {
  if (port === null) return;
  if (success) {
    proxyMetrics.retry_successes_by_port[port] = (proxyMetrics.retry_successes_by_port[port] || 0) + 1;
    if (rotated) proxyMetrics.retry_successes_after_port_rotation += 1;
  } else {
    proxyMetrics.retry_attempts_by_port[port] = (proxyMetrics.retry_attempts_by_port[port] || 0) + 1;
    if (rotated) proxyMetrics.retry_attempts_after_port_rotation += 1;
  }
}

export function getProxyMetricsReport() {
  const rate = (errors: Record<string | number, number>, totals: Record<string | number, number>) =>
    Object.fromEntries(Object.keys(totals).map((key) => [key, totals[key] ? (errors[key] || 0) / totals[key] : 0]));
  const averages = Object.fromEntries(Object.keys(proxyMetrics.total_connect_time_by_port).map((key) => [
    key,
    proxyMetrics.connect_count_by_port[Number(key)]
      ? proxyMetrics.total_connect_time_by_port[Number(key)] / proxyMetrics.connect_count_by_port[Number(key)]
      : 0
  ]));
  return {
    ...proxyMetrics,
    proxy_error_rate_by_geo: rate(proxyMetrics.errors_by_geo, proxyMetrics.total_connects_by_geo),
    proxy_error_rate_by_port: rate(proxyMetrics.errors_by_port, proxyMetrics.total_connects_by_port),
    proxy_retry_success_rate_by_port: rate(proxyMetrics.retry_successes_by_port, proxyMetrics.retry_attempts_by_port),
    retry_recovery_rate: proxyMetrics.retry_attempts_after_port_rotation
      ? proxyMetrics.retry_successes_after_port_rotation / proxyMetrics.retry_attempts_after_port_rotation
      : 0,
    avg_proxy_connect_time_by_port: averages,
    port_health: getProxyHealthSnapshot()
  };
}
import { boundedInteger } from '../../shared/config';
