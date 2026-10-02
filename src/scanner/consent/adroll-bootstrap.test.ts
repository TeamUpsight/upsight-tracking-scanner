import { describe, expect, it } from 'vitest';
import {
  ADROLL_BOOTSTRAP_GRACE_MAX_MS,
  ADROLL_CONSENT_RESPONSE_MAX_BYTES,
  AdRollBootstrapObserver,
  adRollBootstrapNetworkStage,
  attachAdRollBootstrapObserver,
  classifyAdRollConsentCheckResponse,
  normalizeAdRollConsentCheckContentType,
  parseAdRollConsentCheckResponse
} from './adroll-bootstrap';

const decision = '__adroll.set_consent(null, false, true, "LV", "AE", {"banner":"adroll","ipgeo":{"country_code":"LV","region_name":"Riga"}});';
const harDecision = 'window.adroll_exp_list = []; __adroll.set_consent(null, false, true, "LV", "AE", {"arconsent":null,"euconsent":null,"purposes":null,"eucookie":null,"banner":"adroll","ipgeo":{"country_code":"LV","region_name":"Riga"},"etld":"matwprojectme.org","max_vendor_id":4202,"networks":["a","g"],"isipv6":false});';

async function observeResponse(options: {
  body?: string;
  contentLength?: string | null;
  contentType?: string | null;
  responseHeaders?: Record<string, string>;
  status?: number;
} = {}) {
  const listeners = new Map<string, Set<(value: any) => void>>();
  const page = {
    on(event: string, listener: (value: any) => void) {
      const handlers = listeners.get(event) || new Set();
      handlers.add(listener);
      listeners.set(event, handlers);
      return page;
    },
    off(event: string, listener: (value: any) => void) {
      listeners.get(event)?.delete(listener);
      return page;
    }
  } as unknown as Parameters<typeof attachAdRollBootstrapObserver>[0];
  const attached = attachAdRollBootstrapObserver(page, 1_000);
  const body = options.body ?? decision;
  let bodyReadCount = 0;
  const headers: Record<string, string> = { ...options.responseHeaders };
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/javascript; charset=utf-8';
  if (options.contentLength !== null) headers['content-length'] = options.contentLength ?? String(Buffer.byteLength(body));
  const response = {
    url: () => 'https://d.adroll.com/consent/check/private-advertiser-id?session=private-session-id',
    status: () => options.status ?? 200,
    allHeaders: async () => headers,
    finished: async () => null,
    text: async () => { bodyReadCount += 1; return body; }
  };
  for (const listener of listeners.get('response') || []) listener(response);
  await attached.observer.flushResponseTasks();
  const snapshot = attached.observer.snapshot();
  attached.dispose();
  return { snapshot, bodyReadCount };
}

describe('AdRoll consent bootstrap parser', () => {
  it('parses only the bounded allowlisted fields from the observed call shape', () => {
    expect(parseAdRollConsentCheckResponse(decision)).toEqual({
      parsed: true,
      status: 'parsed',
      gdpr_applies: true,
      user_country: 'LV',
      advertiser_country: 'AE',
      banner_mode: 'adroll',
      ipgeo_country: 'LV',
      ipgeo_region: 'Riga'
    });
  });

  it('parses the real HAR-shaped response and retains only allowlisted fields', () => {
    expect(parseAdRollConsentCheckResponse(harDecision)).toEqual({
      parsed: true,
      status: 'parsed',
      gdpr_applies: true,
      user_country: 'LV',
      advertiser_country: 'AE',
      banner_mode: 'adroll',
      ipgeo_country: 'LV',
      ipgeo_region: 'Riga'
    });
  });

  it.each([
    ['arbitrary prefix', `doSomething(); ${decision}`],
    ['wrong AdRoll prefix', `window.adroll_exp_list = [1]; ${decision}`],
    ['extra suffix', `${decision} doSomething();`]
  ])('rejects %s JavaScript', (_name, body) => {
    expect(parseAdRollConsentCheckResponse(body)).toEqual({ parsed: false, status: 'malformed' });
  });

  it.each([
    ['unrelated JavaScript', 'window.unrelated = true;', 'unrelated'],
    ['malformed call', '__adroll.set_consent(null, false);', 'malformed'],
    ['oversized body', `${decision}${' '.repeat(ADROLL_CONSENT_RESPONSE_MAX_BYTES)}`, 'oversized'],
    ['invalid object JSON', '__adroll.set_consent(null, false, true, "LV", "AE", {"banner":});', 'invalid_json'],
    ['lookalike function', '__adroll_evil.set_consent(null, false, true, "LV", "AE", {"banner":"adroll"});', 'unrelated']
  ])('returns unparsed without throwing for %s', (_name, body, status) => {
    expect(() => parseAdRollConsentCheckResponse(body)).not.toThrow();
    expect(parseAdRollConsentCheckResponse(body)).toEqual({ parsed: false, status });
  });

  it('never executes the JavaScript response', () => {
    let calls = 0;
    const previous = (globalThis as any).__adroll;
    (globalThis as any).__adroll = { set_consent() { calls += 1; } };
    try {
      expect(parseAdRollConsentCheckResponse(decision).parsed).toBe(true);
      expect(parseAdRollConsentCheckResponse(harDecision).parsed).toBe(true);
      expect(calls).toBe(0);
    } finally {
      (globalThis as any).__adroll = previous;
    }
  });
});

describe('AdRoll consent-check response diagnostics', () => {
  it.each([
    ['direct decision', decision, 'javascript', 'set_consent', false, true, true],
    ['known HAR wrapper', harDecision, 'javascript', 'experiment_list_and_set_consent', true, true, true],
    ['experiment list only', 'window.adroll_exp_list = [];', 'javascript', 'experiment_list_only', true, false, false],
    ['HTML', '<!DOCTYPE html><html><body>Unavailable</body></html>', 'html', 'html', false, false, false],
    ['JSON', '{"private_vendor_array":[1,2],"session":"discard-me"}', 'json', 'json', false, false, false],
    ['other JavaScript', 'window.someAdrollState = true;', 'javascript', 'other_javascript', false, false, false],
    ['empty', '   ', 'text', 'empty', false, false, false]
  ] as const)('classifies %s without changing parser compatibility', (_name, body, contentType, responseShape, experiment, setConsent, parsed) => {
    expect(classifyAdRollConsentCheckResponse(body, contentType)).toEqual({
      response_shape: responseShape,
      contains_adroll_exp_list: experiment,
      contains_set_consent: setConsent
    });
    expect(parseAdRollConsentCheckResponse(body).parsed).toBe(parsed);
  });

  it.each([
    ['application/javascript; charset=utf-8', 'javascript'],
    ['text/javascript', 'javascript'],
    ['text/html; charset=UTF-8', 'html'],
    ['application/problem+json', 'json'],
    ['text/plain', 'text'],
    ['application/octet-stream', 'other'],
    [null, 'unknown'],
    ['', 'unknown']
  ] as const)('normalizes Content-Type %j to %s', (contentType, expected) => {
    expect(normalizeAdRollConsentCheckContentType(contentType)).toBe(expected);
  });

  it('records bounded body metadata and markers for a safe response', async () => {
    const { snapshot, bodyReadCount } = await observeResponse();
    expect(bodyReadCount).toBe(1);
    expect(snapshot).toMatchObject({
      consent_check_body_bytes: Buffer.byteLength(decision),
      consent_check_content_type: 'javascript',
      consent_check_content_length_bytes: Buffer.byteLength(decision),
      consent_check_body_read_status: 'read',
      consent_check_response_shape: 'set_consent',
      consent_check_contains_adroll_exp_list: false,
      consent_check_contains_set_consent: true,
      consent_check_parsed: true
    });
  });

  it('does not read an oversized declared body', async () => {
    const { snapshot, bodyReadCount } = await observeResponse({ contentLength: String(ADROLL_CONSENT_RESPONSE_MAX_BYTES + 1) });
    expect(bodyReadCount).toBe(0);
    expect(snapshot).toMatchObject({
      consent_check_body_bytes: null,
      consent_check_content_length_bytes: ADROLL_CONSENT_RESPONSE_MAX_BYTES + 1,
      consent_check_body_read_status: 'oversized',
      consent_check_response_shape: 'unknown',
      consent_check_contains_adroll_exp_list: false,
      consent_check_contains_set_consent: false,
      consent_check_parsed: false,
      consent_check_parse_status: 'oversized'
    });
  });

  it('keeps a missing Content-Length unavailable and does not throw or read', async () => {
    const { snapshot, bodyReadCount } = await observeResponse({ contentLength: null });
    expect(bodyReadCount).toBe(0);
    expect(snapshot).toMatchObject({
      consent_check_content_length_bytes: null,
      consent_check_body_bytes: null,
      consent_check_body_read_status: 'body_unavailable',
      consent_check_response_shape: 'unknown',
      consent_check_parse_status: 'body_unavailable'
    });
  });

  it('does not read an HTTP error body', async () => {
    const { snapshot, bodyReadCount } = await observeResponse({ status: 503 });
    expect(bodyReadCount).toBe(0);
    expect(snapshot).toMatchObject({
      consent_check_status: 503,
      consent_check_body_read_status: 'http_error',
      consent_check_response_shape: 'unknown',
      consent_check_parse_status: 'http_error'
    });
  });

  it('persists no raw body, URL, query data, IDs, consent strings, arrays, or arbitrary values', async () => {
    const body = '{"advertiser_id":"private-advertiser-id","session_id":"private-session-id","consent_string":"private-consent-string","vendor_array":[77],"arbitrary":"private-value"}';
    const { snapshot } = await observeResponse({
      body,
      contentType: 'application/json; private-parameter=private-content-type-value',
      responseHeaders: { 'set-cookie': 'private-cookie-value', 'x-advertiser-id': 'private-header-id' }
    });
    expect(snapshot).toMatchObject({
      consent_check_body_read_status: 'read',
      consent_check_response_shape: 'json',
      consent_check_contains_adroll_exp_list: false,
      consent_check_contains_set_consent: false,
      consent_check_parse_status: 'unrelated'
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private-advertiser-id|private-session-id|private-consent-string|vendor_array|private-value|private-content-type-value|private-cookie-value|private-header-id|consent\/check|\?session=/);
  });
});

describe('AdRoll bootstrap network observation', () => {
  it('matches only the three exact endpoint families and ignores query parameters', () => {
    expect(adRollBootstrapNetworkStage('https://s.adroll.com/j/fixture-advertiser/roundtrip.js?session=secret')).toBe('roundtrip');
    expect(adRollBootstrapNetworkStage('https://d.adroll.com/consent/check/fixture-advertiser?session=secret')).toBe('consent_check');
    expect(adRollBootstrapNetworkStage('https://s.adroll.com/j/consent_tcfv2.js?cache=1')).toBe('consent_script');
    expect(adRollBootstrapNetworkStage('https://s.adroll.com/j/fixture-advertiser/not-roundtrip.js')).toBeNull();
    expect(adRollBootstrapNetworkStage('https://s.adroll.com.evil.example/j/fixture-advertiser/roundtrip.js')).toBeNull();
    expect(adRollBootstrapNetworkStage('https://d.adroll.com/consent/check/fixture/extra')).toBeNull();
  });

  it('keeps roundtrip-only evidence provider-neutral and absence-protecting', () => {
    const observer = new AdRollBootstrapObserver(1_000);
    observer.observeRequest('https://s.adroll.com/j/fixture-advertiser/roundtrip.js?ignored=yes', 1_025);
    observer.observeRequestCompleted('https://s.adroll.com/j/fixture-advertiser/roundtrip.js?ignored=yes', 1_050);
    expect(observer.snapshot()).toMatchObject({
      roundtrip_observed: true,
      roundtrip_requested_at_ms: 25,
      roundtrip_completed_at_ms: 50,
      consent_check_observed: false,
      consent_check_parsed: false,
      bootstrap_state: 'roundtrip_pending'
    });
    expect(observer.protectsCmpAbsence()).toBe(true);
  });

  it('retains vendor decision geo separately without changing transport geo facts', () => {
    const transport = { requested_country: 'DE', actual_egress_country: 'DE', exact_country_match: true, proxy_country_verified: true };
    const observer = new AdRollBootstrapObserver(1_000);
    observer.setRequestedCountry(transport.requested_country);
    observer.observeRequest('https://d.adroll.com/consent/check/fixture-advertiser', 1_010);
    observer.observeConsentCheckResponse('https://d.adroll.com/consent/check/fixture-advertiser', 200, 1_020);
    observer.observeConsentCheckBody(decision);
    expect(observer.snapshot()).toMatchObject({
      user_country: 'LV', ipgeo_country: 'LV', advertiser_country: 'AE',
      adroll_country_matches_requested_country: false,
      adroll_banner_expected: true,
      bootstrap_state: 'decision_received'
    });
    expect(transport).toEqual({ requested_country: 'DE', actual_egress_country: 'DE', exact_country_match: true, proxy_country_verified: true });
  });

  it('marks a parsed no-banner decision complete and eligible for early exit', () => {
    const observer = new AdRollBootstrapObserver();
    observer.observeRequest('https://d.adroll.com/consent/check/fixture-advertiser');
    observer.observeConsentCheckBody('__adroll.set_consent(null, false, false, "LV", "AE", {"banner":"none","ipgeo":{"country_code":"LV"}});');
    expect(observer.resolvedWithoutBanner()).toBe(true);
    expect(observer.protectsCmpAbsence()).toBe(false);
    expect(observer.snapshot()).toMatchObject({ adroll_banner_expected: false, bootstrap_state: 'completed_without_banner' });
  });

  it('uses a strict twelve-second maximum grace', () => {
    expect(ADROLL_BOOTSTRAP_GRACE_MAX_MS).toBe(12_000);
    const observer = new AdRollBootstrapObserver();
    observer.startGrace(99_999);
    expect(observer.snapshot().grace_max_ms).toBe(ADROLL_BOOTSTRAP_GRACE_MAX_MS);
  });
});
