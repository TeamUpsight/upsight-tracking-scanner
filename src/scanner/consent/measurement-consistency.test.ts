import { describe, expect, it } from 'vitest';
import { captureConsentTrackingRequest, ConsentRequestBuffer, normalizeConsentMeasurement, reconcileConsentMeasurement } from './tracking-consistency';
import { GoogleConsentModeObserver } from './google-consent-mode-observer';
import { unavailableConsentV2Telemetry } from './v2-session';
import type { StorefrontAudit } from '../../types';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { replayEvidence } from '../quality/replay';
import { buildDebugPackageFiles } from '../quality/debug-package';

const request = (marker = 'G100', phase = 'consent_v2', timestamp = 20) => ({ ...captureConsentTrackingRequest({
  url: `https://www.google-analytics.com/g/collect?en=page_view${marker ? `&gcs=${marker}` : ''}`,
  resource_type: 'fetch', method: 'GET', timestamp
})!, phase });
const denied = () => {
  const observer = new GoogleConsentModeObserver();
  observer.observeGtagCall('consent', 'default', { analytics_storage: 'denied' }, 10);
  return observer;
};

// Sanitized Morphe audit pattern: the shared PDP ping carried a limited marker,
// but the old fresh event heuristic returned full and the initial-phase summary
// returned zero. No live storefront or opaque encoding interpretation is needed.
const morpheRequest = (phase: string) => ({ ...captureConsentTrackingRequest({
  url: 'https://www.google-analytics.com/g/collect?en=page_view&gcs=G100',
  resource_type: 'fetch', method: 'GET', timestamp: 20
})!, phase });

describe('CMP-MEASURE Morphe measurement provenance regression', () => {
  it('CMP-MEASURE-01 denied default plus limited GA4 remains limited', () => {
    expect(normalizeConsentMeasurement([request()], 'fresh', null, denied().result()).state).toBe('limited_measurement');
  });

  it('CMP-MEASURE-02 full requires the existing explicit full-grant request semantics', () => {
    expect(normalizeConsentMeasurement([request('G111')], 'fresh', null).state).toBe('full_measurement');
    expect(normalizeConsentMeasurement([request('')], 'fresh', null).state).toBe('unknown');
  });

  it.each([
    ['CMP-MEASURE-03', 'G100', 'G100', 'limited_measurement'],
    ['CMP-MEASURE-04', 'G111', 'G100', 'unknown'],
    ['CMP-MEASURE-05', 'G100', 'G111', 'unknown']
  ])('%s reconciles shared and fresh positive facts without ranking', (_id, shared, fresh, expected) => {
    const result = reconcileConsentMeasurement([
      normalizeConsentMeasurement([request(shared, 'product_pdp_load')], 'shared', null),
      normalizeConsentMeasurement([request(fresh)], 'fresh', null)
    ]);
    expect(result.state).toBe(expected);
    expect(result.contradiction).toBe(shared !== fresh);
    expect(result.sources.map((source) => source.records[0])).toEqual([
      expect.objectContaining({ context: 'shared', phase: 'product_pdp_load', timestamp: 20, timing: 'pre_choice', evidence_type: 'collection' }),
      expect.objectContaining({ context: 'fresh', phase: 'consent_v2', timestamp: 20, timing: 'pre_choice', evidence_type: 'collection' })
    ]);
  });

  it('CMP-MEASURE-06 scripts alone cannot establish measurement', () => {
    const script = captureConsentTrackingRequest({ url: 'https://www.googletagmanager.com/gtag/js?id=G-TEST', resource_type: 'script', method: 'GET', timestamp: 20 })!;
    expect(normalizeConsentMeasurement([script], 'fresh', null)).toMatchObject({ state: false, pre_choice_script_loads: 1, pre_choice_event_hits: 0 });
  });

  it('CMP-MEASURE-07 observation-only advanced-style pings use request-time denied semantics', () => {
    const observer = denied();
    observer.observeMeasurementRequest({ url: 'https://www.google-analytics.com/g/collect?gcs=G100', timestamp: 20 });
    // Mode classification remains ambiguous without a choice; measurement does not depend on that label.
    expect(observer.result().classification).toBe('ambiguous');
    expect(normalizeConsentMeasurement([request('')], 'fresh', null, observer.result()).state).toBe('limited_measurement');
    expect(normalizeConsentMeasurement([request('G111')], 'fresh', null, observer.result())).toMatchObject({ state: 'unknown', contradiction: true, full_measurement_count: 1, limited_measurement_count: 1 });
  });

  it('CMP-MEASURE-08 counts the exact normalized event/script/GCM fixture', () => {
    const observer = denied();
    for (let timestamp = 20; timestamp < 23; timestamp++) observer.observeMeasurementRequest({ url: 'https://www.google-analytics.com/g/collect?gcs=G100', timestamp });
    const script = { ...request(), kind: 'script' as const, path: '/ga.js', event: undefined };
    expect(reconcileConsentMeasurement([normalizeConsentMeasurement([request(), request('G100', 'consent_v2', 21), script], 'fresh', null, observer.result())])).toMatchObject({
      tracking_requests_observed: 3, tracking_requests_retained: 3, tracking_signals_classified: 3,
      pre_choice_event_hits: 2, pre_choice_conversion_hits: 0, pre_choice_script_loads: 1,
      gcm_network_observations: 3, gcm_commands: 1, limited_measurement_count: 2, full_measurement_count: 0
    });
  });

  it('CMP-MEASURE-09 no evidence is not observed, never a violation', () => {
    expect(reconcileConsentMeasurement([normalizeConsentMeasurement([], 'fresh', null)])).toMatchObject({ state: false, contradiction: false, tracking_requests_observed: 0 });
  });

  it('CMP-MEASURE-10 retains both positive classes after the request bound and never infers absence', () => {
    const buffer = new ConsentRequestBuffer();
    for (let index = 0; index < 120; index++) buffer.append(request('G111'));
    buffer.append(request('G100'));
    const normalized = normalizeConsentMeasurement(buffer.requests, 'fresh', null, undefined, buffer.truncated, buffer.observed);
    expect(normalized).toMatchObject({ state: 'unknown', contradiction: true, truncated: true, tracking_requests_observed: 121, tracking_requests_retained: 100 });
    expect(normalized.full_measurement_count).toBeGreaterThan(0);
    expect(normalized.limited_measurement_count).toBeGreaterThan(0);
    expect(normalizeConsentMeasurement([], 'shared', null, undefined, true).state).toBe('unknown');
  });

  it('does not apply later commands, foreign-context commands, or post-choice requests to a pre-choice verdict', () => {
    const observer = denied();
    expect(normalizeConsentMeasurement([request('', 'consent_v2', 5)], 'fresh', null, observer.result()).state).toBe('unknown');
    expect(normalizeConsentMeasurement([request('', 'product_pdp_load')], 'shared', null, observer.result()).state).toBe('unknown');
    expect(normalizeConsentMeasurement([request('G111')], 'fresh', 15, observer.result()).state).toBe(false);
    expect(normalizeConsentMeasurement([request('G111', 'consent_fresh_initial_load')], 'shared', null).state).toBe(false);
    expect(normalizeConsentMeasurement([request('G111', 'consent_v2', NaN)], 'fresh', null).state).toBe('unknown');
  });

  it('keeps partial updates and eventless parsed collections without inventing an event name', () => {
    const observer = denied();
    observer.observeGtagCall('consent', 'update', { ad_storage: 'granted' }, 15);
    const hit = { ...request(''), event: undefined };
    expect(normalizeConsentMeasurement([hit], 'fresh', null, observer.result())).toMatchObject({ state: 'limited_measurement', pre_choice_event_hits: 1 });
    observer.observeGtagCall('consent', 'update', { analytics_storage: 'granted' }, 16);
    expect(normalizeConsentMeasurement([hit], 'fresh', null, observer.result()).state).toBe('unknown');
    const eventless = captureConsentTrackingRequest({ url: 'https://www.google-analytics.com/g/collect?tid=G-FIXTURE&gcs=G100', resource_type: 'fetch', method: 'GET', timestamp: 20 })!;
    expect(eventless.event).toBeUndefined();
    expect(normalizeConsentMeasurement([eventless], 'fresh', null)).toMatchObject({ pre_choice_event_hits: 1, state: 'limited_measurement' });
    expect(captureConsentTrackingRequest({ url: 'https://www.google-analytics.com/g/collect?gcs=G100', resource_type: 'fetch', method: 'GET' })).toBeNull();
    expect(normalizeConsentMeasurement([{ ...request(), path: '/unrelated', event: undefined }], 'fresh', null).tracking_signals_classified).toBe(0);
  });

  it('Morphe limited request facts must survive fresh event classification and product-phase summary', () => {
    const observer = new GoogleConsentModeObserver();
    observer.observeGtagCall('consent', 'default', { analytics_storage: 'denied' }, 10);
    const shared = normalizeConsentMeasurement([morpheRequest('product_pdp_load')], 'shared', null);
    const fresh = normalizeConsentMeasurement([morpheRequest('consent_v2')], 'fresh', null, observer.result());
    const result = reconcileConsentMeasurement([shared, fresh]);
    expect(result.state).toBe('limited_measurement');
    expect(result.limited_measurement_count).toBe(2);
    expect(result.pre_choice_event_hits).toBe(2);
    expect(result.full_measurement_count).toBe(0);
  });

  it('Morphe replay and exported Consent summary use the same evidence after serialization', () => {
    const collector = new EvidenceCollector({ auditId: 'morphe-regression', domain: 'morphe-fixture.example', geo: 'EU', selectedModules: ['consent'] });
    const evidence = collector.bundle;
    evidence.page.valid = true;
    evidence.consent.executed = true;
    evidence.consent.resolved_provider = 'OneTrust';
    evidence.network.relevant_requests = [morpheRequest('product_pdp_load')];
    const measurement = reconcileConsentMeasurement([normalizeConsentMeasurement(evidence.network.relevant_requests, 'shared', null)]);
    evidence.runtime.consent_v2 = { measurement } as NonNullable<typeof evidence.runtime.consent_v2>;
    // Old scalar must not override the normalized production provenance.
    evidence.consent.pre_choice_measurement = 'full_measurement';
    const audit = replayEvidence(JSON.parse(JSON.stringify(evidence))) as StorefrontAudit;
    expect(audit.consent_status).toBe('inconclusive');
    expect(audit.evidence_bundle?.consent.pre_choice_measurement).toBe('limited_measurement');
    const summary = JSON.parse(String(buildDebugPackageFiles(audit)['consent-summary.json']));
    expect(summary).toMatchObject({ pre_choice_measurement: 'limited_measurement', limited_measurement_count: 1, full_measurement_count: 0, measurement: { pre_choice_event_hits: 1 } });
    expect(summary.measurement).toEqual(measurement);
  });

  it.each([
    ['CMP-TELEM-SURVIVE-03', 'G111', 'full_measurement'],
    ['CMP-TELEM-SURVIVE-04', '', 'unknown'],
    ['CMP-TELEM-SURVIVE-05', null, false]
  ] as const)('%s retains the shared measurement snapshot when no fresh session is available', (_id, marker, expected) => {
    const requests = marker === null ? [] : [request(marker, 'product_pdp_load')];
    const measurement = reconcileConsentMeasurement([normalizeConsentMeasurement(requests, 'shared', null)]);
    const telemetry = unavailableConsentV2Telemetry(measurement);
    expect(telemetry).toMatchObject({ session_status: 'unavailable', observation_only: true, measurement: { state: expected } });
  });

  it.each([
    ['CMP-TELEM-SURVIVE-06', 'G100', 'G111'],
    ['CMP-TELEM-SURVIVE-07', 'G111', 'G100']
  ])('%s preserves a shared/fresh conflict as unknown', (_id, shared, fresh) => {
    const measurement = reconcileConsentMeasurement([
      normalizeConsentMeasurement([request(shared, 'product_pdp_load')], 'shared', null),
      normalizeConsentMeasurement([request(fresh)], 'fresh', null)
    ]);
    expect(measurement).toMatchObject({ state: 'unknown', contradiction: true });
  });

  it('CMP-TELEM-SURVIVE-08 debug summary reads persisted canonical measurement', () => {
    const collector = new EvidenceCollector({ auditId: 'telemetry-canonical', domain: 'fixture.example', geo: 'EU', selectedModules: ['consent'] });
    const evidence = collector.bundle;
    const measurement = reconcileConsentMeasurement([normalizeConsentMeasurement([request('G100', 'product_pdp_load')], 'shared', null)]);
    evidence.runtime.consent_v2 = unavailableConsentV2Telemetry(measurement);
    evidence.consent.pre_choice_measurement = 'full_measurement';
    const summary = JSON.parse(String(buildDebugPackageFiles({ evidence_bundle: evidence } as StorefrontAudit)['consent-summary.json']));
    expect(summary.measurement).toEqual(measurement);
    expect(summary.pre_choice_measurement).toBe('limited_measurement');
  });

  it('CMP-TELEM-SURVIVE-09 keeps the bounded legacy debug fallback for bundles without runtime telemetry', () => {
    const collector = new EvidenceCollector({ auditId: 'telemetry-legacy', domain: 'fixture.example', geo: 'EU', selectedModules: ['consent'] });
    const evidence = collector.bundle;
    evidence.network.relevant_requests = [request('G100', 'product_pdp_load')];
    const summary = JSON.parse(String(buildDebugPackageFiles({ evidence_bundle: evidence } as StorefrontAudit)['consent-summary.json']));
    expect(summary.measurement).toMatchObject({ state: 'limited_measurement', limited_measurement_count: 1 });
  });
});
