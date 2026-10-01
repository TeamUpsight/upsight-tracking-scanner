import type { Page, Request, Response } from 'playwright-core';

export const ADROLL_CONSENT_RESPONSE_MAX_BYTES = 8 * 1024;
export const ADROLL_BOOTSTRAP_GRACE_MAX_MS = 12_000;

export type AdRollBootstrapState =
  | 'not_observed'
  | 'roundtrip_pending'
  | 'consent_check_pending'
  | 'decision_received'
  | 'banner_script_pending'
  | 'banner_script_loaded'
  | 'banner_visible'
  | 'completed_without_banner'
  | 'timed_out'
  | 'parse_failed';

export type AdRollConsentCheckParseStatus =
  | 'not_attempted'
  | 'parsed'
  | 'unrelated'
  | 'malformed'
  | 'oversized'
  | 'invalid_json'
  | 'invalid_fields'
  | 'body_unavailable'
  | 'http_error';

export interface AdRollConsentDecision {
  gdpr_applies: boolean;
  user_country: string;
  advertiser_country: string;
  banner_mode: string | null;
  ipgeo_country: string | null;
  ipgeo_region: string | null;
}

export type AdRollConsentCheckParseResult =
  | ({ parsed: true; status: 'parsed' } & AdRollConsentDecision)
  | { parsed: false; status: Exclude<AdRollConsentCheckParseStatus, 'not_attempted' | 'parsed' | 'body_unavailable' | 'http_error'> };

export interface AdRollBootstrapTelemetry {
  roundtrip_observed: boolean;
  roundtrip_requested_at_ms: number | null;
  roundtrip_completed_at_ms: number | null;
  consent_check_observed: boolean;
  consent_check_status: number | null;
  consent_check_parsed: boolean;
  consent_check_parse_status: AdRollConsentCheckParseStatus;
  consent_check_requested_at_ms: number | null;
  consent_check_completed_at_ms: number | null;
  gdpr_applies: boolean | null;
  user_country: string | null;
  advertiser_country: string | null;
  banner_mode: string | null;
  ipgeo_country: string | null;
  ipgeo_region: string | null;
  consent_script_observed: boolean;
  consent_script_requested_at_ms: number | null;
  consent_script_completed_at_ms: number | null;
  banner_root_observed: boolean;
  banner_visible: boolean;
  adroll_banner_expected: boolean;
  adroll_country_matches_requested_country: boolean | null;
  grace_triggered: boolean;
  grace_elapsed_ms: number;
  grace_max_ms: number;
  grace_timed_out: boolean;
  bootstrap_state: AdRollBootstrapState;
}

export type AdRollBootstrapNetworkStage = 'roundtrip' | 'consent_check' | 'consent_script';

/** Exact host/path matching deliberately discards query strings and advertiser identifiers. */
export function adRollBootstrapNetworkStage(rawUrl: string): AdRollBootstrapNetworkStage | null {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === 's.adroll.com' && /^\/j\/[^/]+\/roundtrip\.js$/.test(url.pathname)) return 'roundtrip';
    if (host === 'd.adroll.com' && /^\/consent\/check\/[^/]+\/?$/.test(url.pathname)) return 'consent_check';
    if (host === 's.adroll.com' && url.pathname === '/j/consent_tcfv2.js') return 'consent_script';
  } catch {
    // Invalid URLs are unrelated evidence.
  }
  return null;
}

function boundedString(value: unknown, maximum: number, pattern?: RegExp) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || (pattern && !pattern.test(normalized))) return null;
  return normalized;
}

/**
 * Parses only the documented six-argument call shape, optionally preceded by
 * AdRoll's exact empty experiment-list assignment. The response is never
 * evaluated or executed; JSON.parse is limited to the structurally isolated,
 * size-bounded object argument.
 */
export function parseAdRollConsentCheckResponse(body: string): AdRollConsentCheckParseResult {
  try {
    if (Buffer.byteLength(body, 'utf8') > ADROLL_CONSENT_RESPONSE_MAX_BYTES) return { parsed: false, status: 'oversized' };
    const trimmed = body.trim();
    if (!trimmed.includes('__adroll.set_consent')) return { parsed: false, status: 'unrelated' };
    const match = trimmed.match(/^(?:window\s*\.\s*adroll_exp_list\s*=\s*\[\s*\]\s*;\s*)?__adroll\.set_consent\s*\(\s*null\s*,\s*(?:true|false)\s*,\s*(true|false)\s*,\s*"([A-Za-z]{2})"\s*,\s*"([A-Za-z]{2})"\s*,\s*(\{[\s\S]*\})\s*\)\s*;?$/);
    if (!match) return { parsed: false, status: 'malformed' };
    let payload: unknown;
    try {
      payload = JSON.parse(match[4]);
    } catch {
      return { parsed: false, status: 'invalid_json' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { parsed: false, status: 'invalid_fields' };
    const record = payload as Record<string, unknown>;
    const ipgeo = record.ipgeo && typeof record.ipgeo === 'object' && !Array.isArray(record.ipgeo)
      ? record.ipgeo as Record<string, unknown> : null;
    const bannerMode = record.banner === undefined || record.banner === null
      ? null : boundedString(record.banner, 32, /^[A-Za-z0-9_-]+$/)?.toLowerCase() || null;
    if (record.banner !== undefined && record.banner !== null && bannerMode === null) return { parsed: false, status: 'invalid_fields' };
    const ipgeoCountry = ipgeo?.country_code === undefined || ipgeo?.country_code === null
      ? null : boundedString(ipgeo.country_code, 2, /^[A-Za-z]{2}$/)?.toUpperCase() || null;
    const ipgeoRegion = ipgeo?.region_name === undefined || ipgeo?.region_name === null
      ? null : boundedString(ipgeo.region_name, 80) || null;
    if ((ipgeo?.country_code !== undefined && ipgeo?.country_code !== null && ipgeoCountry === null) ||
      (ipgeo?.region_name !== undefined && ipgeo?.region_name !== null && ipgeoRegion === null)) {
      return { parsed: false, status: 'invalid_fields' };
    }
    return {
      parsed: true,
      status: 'parsed',
      gdpr_applies: match[1] === 'true',
      user_country: match[2].toUpperCase(),
      advertiser_country: match[3].toUpperCase(),
      banner_mode: bannerMode,
      ipgeo_country: ipgeoCountry,
      ipgeo_region: ipgeoRegion
    };
  } catch {
    return { parsed: false, status: 'malformed' };
  }
}

const emptyTelemetry = (): AdRollBootstrapTelemetry => ({
  roundtrip_observed: false,
  roundtrip_requested_at_ms: null,
  roundtrip_completed_at_ms: null,
  consent_check_observed: false,
  consent_check_status: null,
  consent_check_parsed: false,
  consent_check_parse_status: 'not_attempted',
  consent_check_requested_at_ms: null,
  consent_check_completed_at_ms: null,
  gdpr_applies: null,
  user_country: null,
  advertiser_country: null,
  banner_mode: null,
  ipgeo_country: null,
  ipgeo_region: null,
  consent_script_observed: false,
  consent_script_requested_at_ms: null,
  consent_script_completed_at_ms: null,
  banner_root_observed: false,
  banner_visible: false,
  adroll_banner_expected: false,
  adroll_country_matches_requested_country: null,
  grace_triggered: false,
  grace_elapsed_ms: 0,
  grace_max_ms: ADROLL_BOOTSTRAP_GRACE_MAX_MS,
  grace_timed_out: false,
  bootstrap_state: 'not_observed'
});

function boundedElapsed(startedAt: number, observedAt: number) {
  return Math.max(0, Math.min(120_000, Math.round(observedAt - startedAt)));
}

export class AdRollBootstrapObserver {
  private readonly observationStartedAt: number;
  private readonly telemetry = emptyTelemetry();
  private readonly pendingResponseTasks = new Set<Promise<void>>();
  private requestedCountry: string | null = null;

  constructor(observationStartedAt = Date.now()) {
    this.observationStartedAt = observationStartedAt;
  }

  setRequestedCountry(country: string | null | undefined) {
    this.requestedCountry = boundedString(country, 2, /^[A-Za-z]{2}$/)?.toUpperCase() || null;
    this.updateCountryMatch();
  }

  observeRequest(rawUrl: string, observedAt = Date.now()) {
    const stage = adRollBootstrapNetworkStage(rawUrl);
    const elapsed = boundedElapsed(this.observationStartedAt, observedAt);
    if (stage === 'roundtrip') {
      this.telemetry.roundtrip_observed = true;
      this.telemetry.roundtrip_requested_at_ms ??= elapsed;
    } else if (stage === 'consent_check') {
      this.telemetry.consent_check_observed = true;
      this.telemetry.consent_check_requested_at_ms ??= elapsed;
    } else if (stage === 'consent_script') {
      this.telemetry.consent_script_observed = true;
      this.telemetry.consent_script_requested_at_ms ??= elapsed;
    }
    return stage;
  }

  observeRequestCompleted(rawUrl: string, observedAt = Date.now()) {
    const stage = this.observeRequest(rawUrl, observedAt);
    const elapsed = boundedElapsed(this.observationStartedAt, observedAt);
    if (stage === 'roundtrip') this.telemetry.roundtrip_completed_at_ms ??= elapsed;
    if (stage === 'consent_check') this.telemetry.consent_check_completed_at_ms ??= elapsed;
    if (stage === 'consent_script') this.telemetry.consent_script_completed_at_ms ??= elapsed;
  }

  observeConsentCheckResponse(rawUrl: string, status: number, observedAt = Date.now()) {
    if (adRollBootstrapNetworkStage(rawUrl) !== 'consent_check') return false;
    this.observeRequest(rawUrl, observedAt);
    this.telemetry.consent_check_status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    return true;
  }

  observeConsentCheckBody(body: string) {
    const parsed = parseAdRollConsentCheckResponse(body);
    this.telemetry.consent_check_parse_status = parsed.status;
    this.telemetry.consent_check_parsed = parsed.parsed;
    if (!parsed.parsed) return parsed;
    this.telemetry.gdpr_applies = parsed.gdpr_applies;
    this.telemetry.user_country = parsed.user_country;
    this.telemetry.advertiser_country = parsed.advertiser_country;
    this.telemetry.banner_mode = parsed.banner_mode;
    this.telemetry.ipgeo_country = parsed.ipgeo_country;
    this.telemetry.ipgeo_region = parsed.ipgeo_region;
    this.telemetry.adroll_banner_expected = parsed.gdpr_applies && parsed.banner_mode === 'adroll';
    this.updateCountryMatch();
    return parsed;
  }

  markConsentCheckUnparsed(status: 'body_unavailable' | 'http_error' | 'oversized') {
    if (!this.telemetry.consent_check_parsed) this.telemetry.consent_check_parse_status = status;
  }

  observeBannerRoot(present: boolean, visible: boolean) {
    this.telemetry.banner_root_observed ||= present;
    this.telemetry.banner_visible ||= visible;
  }

  startGrace(maximumMs: number) {
    this.telemetry.grace_triggered = true;
    this.telemetry.grace_max_ms = Math.max(0, Math.min(ADROLL_BOOTSTRAP_GRACE_MAX_MS, Math.round(maximumMs)));
  }

  finishGrace(elapsedMs: number, timedOut: boolean) {
    this.telemetry.grace_elapsed_ms = Math.max(0, Math.min(ADROLL_BOOTSTRAP_GRACE_MAX_MS, Math.round(elapsedMs)));
    this.telemetry.grace_timed_out = timedOut;
  }

  hasObjectiveBootstrapEvidence() {
    return this.telemetry.roundtrip_observed || this.telemetry.consent_check_observed ||
      this.telemetry.consent_script_observed || this.telemetry.banner_mode === 'adroll';
  }

  resolvedWithoutBanner() {
    return this.telemetry.consent_check_parsed &&
      (this.telemetry.gdpr_applies === false || this.telemetry.banner_mode !== 'adroll');
  }

  protectsCmpAbsence() {
    return this.hasObjectiveBootstrapEvidence() && !this.resolvedWithoutBanner();
  }

  trackResponseTask(task: Promise<void>) {
    this.pendingResponseTasks.add(task);
    void task.finally(() => this.pendingResponseTasks.delete(task));
  }

  async flushResponseTasks() {
    await Promise.allSettled([...this.pendingResponseTasks]);
  }

  snapshot(): AdRollBootstrapTelemetry {
    const value = { ...this.telemetry };
    value.bootstrap_state = value.grace_timed_out && this.protectsCmpAbsence() ? 'timed_out'
      : value.banner_visible ? 'banner_visible'
        : this.resolvedWithoutBanner() ? 'completed_without_banner'
          : value.consent_script_observed && value.consent_script_completed_at_ms !== null ? 'banner_script_loaded'
            : value.consent_script_observed ? 'banner_script_pending'
              : value.consent_check_parsed ? 'decision_received'
                : value.consent_check_parse_status !== 'not_attempted' ? 'parse_failed'
                  : value.consent_check_observed ? 'consent_check_pending'
                    : value.roundtrip_observed ? 'roundtrip_pending'
                      : 'not_observed';
    return value;
  }

  private updateCountryMatch() {
    this.telemetry.adroll_country_matches_requested_country = this.requestedCountry && this.telemetry.user_country
      ? this.requestedCountry === this.telemetry.user_country : null;
  }
}

export interface AttachedAdRollBootstrapObserver {
  observer: AdRollBootstrapObserver;
  dispose(): void;
}

/** Installs passive listeners only; it never calls any AdRoll runtime function. */
export function attachAdRollBootstrapObserver(page: Page, observationStartedAt = Date.now()): AttachedAdRollBootstrapObserver {
  const observer = new AdRollBootstrapObserver(observationStartedAt);
  const onRequest = (request: Request) => { observer.observeRequest(request.url()); };
  const onRequestCompleted = (request: Request) => { observer.observeRequestCompleted(request.url()); };
  const onResponse = (response: Response) => {
    if (!observer.observeConsentCheckResponse(response.url(), response.status())) return;
    const task = (async () => {
      try {
        if (response.status() < 200 || response.status() >= 300) {
          observer.markConsentCheckUnparsed('http_error');
          return;
        }
        const completionError = await response.finished();
        if (completionError) {
          observer.markConsentCheckUnparsed('body_unavailable');
          return;
        }
        const headers = await response.allHeaders();
        const rawLength = headers['content-length'];
        if (!rawLength || !/^\d+$/.test(rawLength.trim())) {
          observer.markConsentCheckUnparsed('body_unavailable');
          return;
        }
        const contentLength = Number(rawLength);
        if (!Number.isSafeInteger(contentLength) || contentLength > ADROLL_CONSENT_RESPONSE_MAX_BYTES) {
          observer.markConsentCheckUnparsed('oversized');
          return;
        }
        const body = await response.text();
        observer.observeConsentCheckBody(body);
      } catch {
        observer.markConsentCheckUnparsed('body_unavailable');
      }
    })();
    observer.trackResponseTask(task);
  };
  page.on('request', onRequest);
  page.on('requestfinished', onRequestCompleted);
  page.on('requestfailed', onRequestCompleted);
  page.on('response', onResponse);
  let disposed = false;
  return {
    observer,
    dispose() {
      if (disposed) return;
      disposed = true;
      page.off('request', onRequest);
      page.off('requestfinished', onRequestCompleted);
      page.off('requestfailed', onRequestCompleted);
      page.off('response', onResponse);
    }
  };
}

/** Separate AdRoll-only wait; the normal Consent appearance window is not restarted. */
export async function waitForAdRollBootstrapGrace(page: Page, observer: AdRollBootstrapObserver, maximumMs = ADROLL_BOOTSTRAP_GRACE_MAX_MS) {
  const boundedMaximum = Math.max(0, Math.min(ADROLL_BOOTSTRAP_GRACE_MAX_MS, Math.round(maximumMs)));
  if (!observer.hasObjectiveBootstrapEvidence() || boundedMaximum === 0) return observer.snapshot();
  observer.startGrace(boundedMaximum);
  const startedAt = Date.now();
  while (true) {
    const root = page.locator('#adroll_consent_banner').first();
    const present = await root.count().then((count) => count > 0).catch(() => false);
    const visible = present ? await root.isVisible().catch(() => false) : false;
    observer.observeBannerRoot(present, visible);
    if (visible || observer.resolvedWithoutBanner()) {
      observer.finishGrace(Date.now() - startedAt, false);
      return observer.snapshot();
    }
    const remaining = boundedMaximum - (Date.now() - startedAt);
    if (remaining <= 0) {
      observer.finishGrace(Date.now() - startedAt, true);
      return observer.snapshot();
    }
    await page.waitForTimeout(Math.min(200, remaining));
  }
}
