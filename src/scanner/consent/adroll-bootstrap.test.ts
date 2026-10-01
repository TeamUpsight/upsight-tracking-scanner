import { describe, expect, it } from 'vitest';
import {
  ADROLL_BOOTSTRAP_GRACE_MAX_MS,
  ADROLL_CONSENT_RESPONSE_MAX_BYTES,
  AdRollBootstrapObserver,
  adRollBootstrapNetworkStage,
  parseAdRollConsentCheckResponse
} from './adroll-bootstrap';

const decision = '__adroll.set_consent(null, false, true, "LV", "AE", {"banner":"adroll","ipgeo":{"country_code":"LV","region_name":"Riga"}});';

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
      expect(calls).toBe(0);
    } finally {
      (globalThis as any).__adroll = previous;
    }
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
    const observer = new AdRollBootstrapObserver();
    observer.startGrace(99_999);
    expect(observer.snapshot().grace_max_ms).toBe(ADROLL_BOOTSTRAP_GRACE_MAX_MS);
  });
});
