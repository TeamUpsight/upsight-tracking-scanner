import { lookup } from 'node:dns/promises';
import type { AccessChallengeType, ErrorCategory } from '../types';

export const INVALID_STOREFRONT_STATUSES = new Set([403, 407, 408, 423, 425, 429, 451]);

export type DnsResolutionStatus = 'resolved' | 'not_resolved' | 'inconclusive';
export type DnsSourceStatus = DnsResolutionStatus;

export interface DnsResolutionEvidence {
  status: DnsResolutionStatus;
  sources: Record<string, DnsSourceStatus>;
}

export interface AccessSignals {
  status: number | null;
  headers?: Record<string, string>;
  url?: string;
  title?: string;
  bodyText?: string;
  domSignals?: string[];
  scriptUrls?: string[];
  iframeUrls?: string[];
  cookieNames?: string[];
  networkUrls?: string[];
  redirectPaths?: string[];
}

export interface AccessDecision {
  category: ErrorCategory | 'none';
  reasonCode: string;
  botProvider: string | null;
  botSignals: string[];
  challengeType: AccessChallengeType | null;
  retryAfterMs: number | null;
}

function normalizedHeaders(headers: Record<string, string> = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()) {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), 86_400_000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return null;
  return Math.min(Math.max(0, dateMs - nowMs), 86_400_000);
}

export function detectAccessChallenge(input: AccessSignals) {
  const headers = normalizedHeaders(input.headers);
  const status = input.status;
  const url = String(input.url || '').toLowerCase();
  const title = String(input.title || '').toLowerCase();
  const body = String(input.bodyText || '').slice(0, 20_000).toLowerCase();
  const dom = (input.domSignals || []).map((value) => value.toLowerCase());
  const scripts = (input.scriptUrls || []).map((value) => value.toLowerCase());
  const frames = (input.iframeUrls || []).map((value) => value.toLowerCase());
  const cookies = (input.cookieNames || []).map((value) => value.toLowerCase());
  const network = (input.networkUrls || []).map((value) => value.toLowerCase());
  const redirects = (input.redirectPaths || []).map((value) => value.toLowerCase());
  const allMarkers = [...dom, ...scripts, ...frames, ...cookies, ...network, ...redirects, url];
  const signals: string[] = [];
  let provider: string | null = null;

  const add = (signal: string) => { if (!signals.includes(signal)) signals.push(signal); };
  const server = headers.server?.toLowerCase() || '';
  const turnstile = allMarkers.some((value) => value.includes('turnstile') || value.includes('challenges.cloudflare.com'));
  const cloudflare = Boolean(headers['cf-ray']) || server.includes('cloudflare') ||
    url.includes('/cdn-cgi/challenge') || url.includes('cf-chl-') ||
    allMarkers.some((value) => value.includes('cf-chl-') || value.includes('__cf_bm') || value.includes('cf_clearance') || value.includes('challenge-form'));
  if (cloudflare) {
    provider = 'Cloudflare';
    add('cloudflare');
    if (headers['cf-ray']) add('cf_ray');
    if (headers['cf-mitigated']?.toLowerCase() === 'challenge') add('cf_mitigated_challenge');
  }

  const datadome = Boolean(headers['x-datadome']) || allMarkers.some((value) => /datadome|captcha-delivery/.test(value));
  if (datadome) { provider = provider || 'DataDome'; add('datadome'); }

  const akamai = Boolean(headers['akamai-grn']) || allMarkers.some((value) => /akamai|akam\//.test(server + value));
  if (akamai) { provider = provider || 'Akamai'; add('akamai'); }

  const perimeterX = Boolean(headers['x-px']) || allMarkers.some((value) => /px-captcha|perimeterx|humansecurity/.test(value));
  if (perimeterX) { provider = provider || 'HUMAN/PerimeterX'; add('perimeterx'); }

  const captcha = allMarkers.some((value) => /captcha|recaptcha|hcaptcha/.test(value));
  const genericWaf = Boolean(headers['x-waf'] || headers['x-sucuri-id'] || headers['x-firewall']) ||
    /waf|web application firewall|request (?:blocked|denied)/.test(body) ||
    allMarkers.some((value) => /waf|web application firewall|request (?:blocked|denied)/.test(value));
  const strongDom = allMarkers.some((value) => /turnstile|captcha|challenge/.test(value));
  if (strongDom) add('challenge_dom');
  const challengeUrl = /captcha|challenge|verify/.test(url);
  if (challengeUrl) add('challenge_url');
  const phrase = ['just a moment', 'verify you are human', 'checking your browser', 'attention required']
    .find((value) => title.includes(value) || body.includes(value));
  if (phrase) add('challenge_phrase');

  const statusSupportsChallenge = status === null || status === 200 || status === 202 || status === 403 || status === 429 || status === 503;
  const providerEvidence = cloudflare || datadome || akamai || perimeterX || genericWaf;
  const detected = statusSupportsChallenge && (
    strongDom || challengeUrl ||
    (providerEvidence && (status === 403 || status === 429 || status === 503 || Boolean(phrase))) ||
    (Boolean(phrase) && (status === 403 || status === 503 || title.includes(phrase!)))
  );
  const challengeType: AccessChallengeType | null = !detected ? null
    : turnstile ? 'turnstile'
    : cloudflare ? 'cloudflare'
    : datadome ? 'datadome'
    : akamai ? 'akamai'
    : perimeterX ? 'perimeterx'
    : genericWaf ? 'generic_waf'
    : captcha ? 'captcha'
    : 'unknown_challenge';
  return { detected, provider: detected ? (provider || challengeType) : null, signals: detected ? signals.slice(0, 30) : [], challengeType };
}

// Compatibility export; access callers should use the normalized detector.
export const detectBotChallengeEvidence = detectAccessChallenge;

function challengeReasonCode(type: AccessChallengeType) {
  return ({
    cloudflare: 'CLOUDFLARE_CHALLENGE', turnstile: 'TURNSTILE_CHALLENGE', datadome: 'DATADOME_CHALLENGE',
    akamai: 'AKAMAI_CHALLENGE', perimeterx: 'PERIMETERX_CHALLENGE', rate_limit: 'RATE_LIMITED'
  } satisfies Partial<Record<AccessChallengeType, string>>)[type] || 'GENERIC_WAF_CHALLENGE';
}

export function resolveAccessDecision(input: AccessSignals): AccessDecision {
  const headers = normalizedHeaders(input.headers);
  const retryAfterMs = parseRetryAfterMs(headers['retry-after']);
  if (input.status === 407) {
    return { category: 'proxy_error', reasonCode: 'PROXY_PROVIDER_UNREACHABLE', botProvider: null, botSignals: [], challengeType: 'proxy_failure', retryAfterMs };
  }
  if (input.status === 429) {
    return { category: 'rate_limited', reasonCode: 'RATE_LIMITED', botProvider: null, botSignals: [], challengeType: 'rate_limit', retryAfterMs };
  }
  const bot = detectAccessChallenge(input);
  if (bot.detected) {
    return { category: 'bot_protection', reasonCode: challengeReasonCode(bot.challengeType!), botProvider: bot.provider, botSignals: bot.signals, challengeType: bot.challengeType, retryAfterMs };
  }
  if (input.status !== null && (INVALID_STOREFRONT_STATUSES.has(input.status) || input.status >= 500)) {
    return { category: 'access_blocked', reasonCode: `HTTP_${input.status}`, botProvider: null, botSignals: [], challengeType: null, retryAfterMs };
  }
  return { category: 'none', reasonCode: 'STOREFRONT_VALID', botProvider: null, botSignals: [], challengeType: null, retryAfterMs };
}

export function classifyHttpAccess(status: number | null): ErrorCategory | 'none' {
  return resolveAccessDecision({ status }).category;
}

export function isValidStorefrontStatus(status: number | null) {
  return status !== null && status >= 200 && status < 400 && classifyHttpAccess(status) === 'none';
}

async function resolveDohProvider(
  endpoint: string,
  hostname: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<DnsSourceStatus> {
  const results: DnsSourceStatus[] = [];
  for (const type of ['A', 'AAAA']) {
    const url = new URL(endpoint);
    url.searchParams.set('name', hostname);
    url.searchParams.set('type', type);
    try {
      const response = await fetchFn(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) { results.push('inconclusive'); continue; }
      const payload = await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      if (payload.Status === 0 && payload.Answer?.some((answer) => (answer.type === 1 || answer.type === 28) && Boolean(answer.data))) {
        return 'resolved';
      }
      if (payload.Status === 3 || (payload.Status === 0 && !payload.Answer?.length)) results.push('not_resolved');
      else results.push('inconclusive');
    } catch {
      results.push('inconclusive');
    }
  }
  return results.every((result) => result === 'not_resolved') ? 'not_resolved' : 'inconclusive';
}

export async function resolveHostnameEvidence(
  hostname: string,
  options: {
    timeoutMs?: number;
    dohTimeoutMs?: number;
    lookupFn?: typeof lookup;
    fetchFn?: typeof fetch;
  } = {}
): Promise<DnsResolutionEvidence> {
  const timeoutMs = Math.max(250, Math.min(options.timeoutMs ?? 2_000, 10_000));
  const dohTimeoutMs = Math.max(1_000, Math.min(options.dohTimeoutMs ?? 6_000, 15_000));
  const lookupFn = options.lookupFn || lookup;
  const fetchFn = options.fetchFn || fetch;
  const sources: Record<string, DnsSourceStatus> = {};
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await Promise.race([
      lookupFn(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), timeoutMs);
      })
    ]);
    sources.local = addresses.length > 0 ? 'resolved' : 'not_resolved';
    if (sources.local === 'resolved') return { status: 'resolved', sources };
  } catch (error) {
    const code = String((error as NodeJS.ErrnoException)?.code || '').toUpperCase();
    sources.local = code === 'ENOTFOUND' || code === 'ENODATA' ? 'not_resolved' : 'inconclusive';
  } finally {
    if (timer) clearTimeout(timer);
  }

  const providers = [
    ['cloudflare', 'https://cloudflare-dns.com/dns-query'],
    ['google', 'https://dns.google/resolve']
  ] as const;
  const results = await Promise.all(providers.map(async ([name, endpoint]) => {
    const status = await resolveDohProvider(endpoint, hostname, fetchFn, dohTimeoutMs);
    sources[name] = status;
    return status;
  }));
  if (results.includes('resolved')) return { status: 'resolved', sources };
  if (results.every((result) => result === 'not_resolved')) return { status: 'not_resolved', sources };
  return { status: 'inconclusive', sources };
}

export async function resolveHostnameStatus(
  hostname: string,
  options: Parameters<typeof resolveHostnameEvidence>[1] = {}
): Promise<DnsResolutionStatus> {
  return (await resolveHostnameEvidence(hostname, options)).status;
}
