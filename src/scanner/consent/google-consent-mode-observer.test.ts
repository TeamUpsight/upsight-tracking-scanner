import { describe, expect, it } from 'vitest';
import { GoogleConsentModeObserver, normalizeGoogleConsentState } from './google-consent-mode-observer';
import { ConsentAuditCodes } from './domain-types';

const googleMeasurementUrl = (query: string) => `https://www.google-analytics.com/g/collect?${query}`;

describe('Google Consent Mode observer', () => {
  it('reports no GCM as not configured', () => {
    const result = new GoogleConsentModeObserver().result();

    expect(result).toMatchObject({ classification: 'not_configured', lifecycle: 'not_observed', reason_codes: [] });
  });

  it('normalizes default denied commands and supported state fields', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeGtagCall('consent', 'default', {
      ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', unknown_value: 'secret'
    }, 10);

    expect(observer.result()).toMatchObject({
      classification: 'ambiguous',
      lifecycle: 'default_observed',
      commands: [{ state: { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', security_storage: 'unset' } }],
      reason_codes: [ConsentAuditCodes.CONSENT_MODE_PRESENT, ConsentAuditCodes.CONSENT_MODE_AMBIGUOUS]
    });
  });

  it('captures default and granted updates from dataLayer representations', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeDataLayerEntry(['consent', 'default', { ad_storage: 'denied' }], 10);
    observer.observeDataLayerEntry({ 0: 'consent', 1: 'update', 2: { ad_storage: 'granted', analytics_storage: 'granted' } }, 20);

    expect(observer.result()).toMatchObject({
      lifecycle: 'default_and_update',
      commands: [{ source: 'data_layer', command: 'default' }, { source: 'data_layer', command: 'update' }]
    });
  });

  it('normalizes default and denied updates without treating them as a tracking classification', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeGtagCall('consent', 'default', { ad_storage: 'denied' }, 10);
    observer.observeGtagCall('consent', 'update', { ad_storage: 'denied' }, 20);

    expect(observer.result()).toMatchObject({ classification: 'ambiguous', lifecycle: 'default_and_update' });
  });

  it('classifies multiple denied-default and pre-choice measurement signals as advanced-like', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeGtagCall('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied' }, 10);
    observer.observeMeasurementRequest({ url: googleMeasurementUrl('gcs=G100&gcd=opaque-gcd-value'), timestamp: 20 });
    observer.markUserChoice(30);

    expect(observer.result()).toMatchObject({ classification: 'advanced_candidate', default_issued_late: false });
  });

  it('classifies gated measurement that starts after a positive update as basic-like', () => {
    const observer = new GoogleConsentModeObserver();
    observer.markTrackingGated();
    observer.markPreChoiceMeasurementWindowObserved();
    observer.observeGtagCall('consent', 'default', { ad_storage: 'denied' }, 10);
    observer.markUserChoice(20);
    observer.observeGtagCall('consent', 'update', { ad_storage: 'granted' }, 21);
    observer.observeMeasurementRequest({ url: googleMeasurementUrl('gcs=G111'), timestamp: 30 });

    expect(observer.result()).toMatchObject({ classification: 'basic_candidate', tracking_gated: true });
  });

  it('identifies explicit tracking gates without a Consent Mode lifecycle as manual gating', () => {
    const observer = new GoogleConsentModeObserver();
    observer.markTrackingGated();

    expect(observer.result()).toMatchObject({ classification: 'manual_gating_candidate', lifecycle: 'not_observed', reason_codes: [] });
  });

  it('keeps update-only evidence ambiguous', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeGtagCall('consent', 'update', { analytics_storage: 'granted' }, 10);

    expect(observer.result()).toMatchObject({
      classification: 'ambiguous',
      lifecycle: 'update_only',
      reason_codes: [ConsentAuditCodes.CONSENT_MODE_PRESENT, ConsentAuditCodes.CONSENT_MODE_AMBIGUOUS]
    });
  });

  it('marks a default issued after measurement as ambiguous rather than advanced', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeMeasurementRequest({ url: googleMeasurementUrl('gcs=G100'), timestamp: 10 });
    observer.observeGtagCall('consent', 'default', { ad_storage: 'denied' }, 20);
    observer.markUserChoice(30);

    expect(observer.result()).toMatchObject({ classification: 'ambiguous', default_issued_late: true });
  });

  it('normalizes wait_for_update without retaining non-consent command fields', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeGtagCall('consent', 'default', { ad_storage: 'denied', wait_for_update: 500, identifier: 'do-not-store' }, 10);

    expect(observer.result().commands[0].state).toMatchObject({ wait_for_update_present: true, wait_for_update_ms: 500 });
    expect(JSON.stringify(observer.result())).not.toContain('do-not-store');
  });

  it('keeps unknown gcd encodings opaque and cannot classify from gcd alone', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeMeasurementRequest({ url: googleMeasurementUrl('gcd=13t3t3t3t5l1&gcs=G100'), timestamp: 10 });

    expect(observer.result()).toMatchObject({
      classification: 'ambiguous',
      network: [{ parameters: { gcd: { present: true, value_length: 12, encoding: 'opaque' } } }]
    });
    expect(JSON.stringify(observer.result())).not.toContain('13t3t3t3t5l1');
  });

  it('uses unset and unknown distinctly for normalized consent state', () => {
    expect(normalizeGoogleConsentState({ ad_storage: 'granted', analytics_storage: 'pending' })).toMatchObject({
      ad_storage: 'granted', analytics_storage: 'unknown', ad_user_data: 'unset'
    });
  });

  it('bounds command and network evidence', () => {
    const observer = new GoogleConsentModeObserver({ max_commands: 1, max_network_observations: 1 });
    observer.observeGtagCall('consent', 'default', { ad_storage: 'denied' }, 1);
    observer.observeGtagCall('consent', 'update', { ad_storage: 'granted' }, 2);
    observer.observeMeasurementRequest({ url: googleMeasurementUrl('gcs=G100'), timestamp: 3 });
    observer.observeMeasurementRequest({ url: googleMeasurementUrl('gcs=G111'), timestamp: 4 });

    expect(observer.result().commands).toHaveLength(1);
    expect(observer.result().network).toHaveLength(1);
    expect(Object.isFrozen(observer.result().commands[0].state)).toBe(true);
    expect(Object.isFrozen(observer.result().network[0].parameters)).toBe(true);
  });
});
