import { describe, expect, it } from 'vitest';
import type { TrackingRequestEvidence } from '../../types';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { replayEvidence } from '../quality/replay';
import { classifyCollection, serverRequestObservationComplete } from './classify-collection';

const request = (collector: TrackingRequestEvidence['collector'], timestamp = 1): TrackingRequestEvidence => ({
  vendor: 'ga4', kind: 'collection', collector, host: collector === 'third_party' ? 'www.google-analytics.com' : 'collect.example.com',
  path: '/g/collect', method: 'GET', phase: 'homepage', timestamp, event: 'page_view', measurement_id: 'G-TEST',
  page_url: 'https://shop.example.com/', correlation: { ga4_client: 'audit-local-client', ga4_session: 'audit-local-session' }
});

const classify = (requests: TrackingRequestEvidence[], extras: Partial<Parameters<typeof classifyCollection>[0]> = {}) =>
  classifyCollection({ executed: true, page_valid: true, observation_complete: true, requests, ...extras });

const evidence = () => {
  const bundle = new EvidenceCollector({ auditId: 'ln05', domain: 'example.com', geo: 'USA', selectedModules: ['server_side'] }).bundle;
  bundle.page.valid = true;
  bundle.server_side.executed = true;
  bundle.server_side.passive_classification_completed = true;
  Object.assign(bundle.network.observation!, { request_listener_active: true, request_capture_completed: true });
  return bundle;
};

describe('LN-05 conservative Server-side resolver', () => {
  it('does not promote repeated known first-party collection', () => {
    for (const count of [1, 2, 3, 10]) {
      expect(classify(Array.from({ length: count }, (_, index) => request('first_party', index + 1))))
        .toMatchObject({ status: 'first_party_collection_detected', collection_type: 'first_party' });
    }
  });

  it('treats observed and persisted collector cookies as support, including legacy replay', () => {
    expect(classify([request('first_party')], { collector_cookie_detected: true }).status).toBe('first_party_collection_detected');
    expect(classify([request('first_party')], { collector_cookie_persisted: true }).status).toBe('first_party_collection_detected');
    const legacy = evidence();
    legacy.network.relevant_requests = [request('first_party')];
    legacy.server_side.collector_cookie_names = ['collector_id'];
    legacy.server_side.collector_cookie_persisted = true;
    expect(replayEvidence(legacy).server_side_status).toBe('first_party_collection_detected');
    expect(legacy.server_side.collector_cookie_persisted).toBe(true);
  });

  it('retains strict duplicate diagnostics without changing status or overall result', () => {
    const pair = [request('first_party'), request('third_party', 2)];
    expect(classify(pair)).toMatchObject({ strict_duplicate_count: 1, collection_type: 'mixed', status: 'first_party_collection_detected',
      reason_code: 'SERVER_FIRST_PARTY_COLLECTION_DETECTED', evidence_codes: ['FIRST_PARTY_COLLECTION_OBSERVED', 'THIRD_PARTY_COLLECTION_OBSERVED', 'STRICT_DUPLICATE_CORRELATION_OBSERVED', 'REQUEST_OBSERVATION_COMPLETE'] });
    const bundle = evidence();
    bundle.network.relevant_requests = pair;
    bundle.server_side.strict_duplicate_count = 1;
    const replay = replayEvidence(bundle);
    expect(replay).toMatchObject({ server_side_status: 'first_party_collection_detected', ss_collection_type: 'mixed' });
    expect(replay.overall_status).not.toBe('fail');
    expect(replay.finding_confidence?.server_side).toMatchObject({ confidence: 'high', evidence: expect.arrayContaining(['STRICT_DUPLICATE_CORRELATION_OBSERVED']) });
  });

  it('preserves first-party positives through incomplete and truncated request observation', () => {
    expect(classify([request('first_party')], { observation_complete: false, candidate_truncated: true, request_evidence_truncated: true }))
      .toMatchObject({ status: 'first_party_collection_detected' });
  });

  it('requires complete, untruncated request observation for negative conclusions', () => {
    expect(classify([], { observation_complete: false })).toMatchObject({ status: 'inconclusive', reason_code: 'SERVER_OBSERVATION_INCOMPLETE' });
    expect(classify([], { request_evidence_truncated: true })).toMatchObject({ status: 'inconclusive' });
    expect(classify([], { candidate_truncated: true })).toMatchObject({ status: 'inconclusive' });
    expect(classify([])).toMatchObject({ status: 'not_detected', collection_type: 'not_detected', reason_code: 'SERVER_NOT_DETECTED' });
    expect(classify([request('third_party')])).toMatchObject({ status: 'not_detected', collection_type: 'third_party', reason_code: 'SERVER_THIRD_PARTY_ONLY' });
  });

  it.each([
    [false, true], [true, false]
  ])('uses request capture when DataLayer=%s and Performance=%s', (dataLayer, performance) => {
    const bundle = evidence();
    Object.assign(bundle.network.observation!, { data_layer_capture_completed: dataLayer, performance_capture_completed: performance });
    const replay = replayEvidence(bundle);
    expect(replay).toMatchObject({ server_side_status: 'not_detected', ss_collection_type: 'not_detected' });
    expect(replay.evidence_bundle?.decision_summary?.find((decision) => decision.decision_name === 'server_side')?.observation_complete).toBe(true);
    expect(serverRequestObservationComplete(bundle.network.observation)).toBe(true);
  });

  it('caps known same-origin and qualified generic evidence at collection observed', () => {
    expect(classify([request('same_origin')])).toMatchObject({ status: 'first_party_collection_detected', collection_type: 'same_origin' });
    const collector = new EvidenceCollector({ auditId: 'generic', domain: 'example.com', geo: 'USA', selectedModules: ['server_side'] });
    const body = 'event_name=purchase&client_id=client&session_id=session&page_url=https%3A%2F%2Fshop.example.com%2F&currency=USD&value=99';
    for (let index = 0; index < 3; index++) collector.captureRequests({ url: `https://collect.example.com/a/${index}`, body, method: 'POST', phase: 'homepage', observed_page_url: 'https://shop.example.com/', timestamp: index + 1 });
    for (const candidates of [collector.bundle.server_side.measurement_candidates.slice(0, 1), collector.bundle.server_side.measurement_candidates]) {
      expect(classify([], { measurement_candidates: candidates, collector_cookie_detected: true, collector_cookie_persisted: true }))
        .toMatchObject({ status: 'first_party_collection_detected' });
    }
  });

  it('keeps ambiguous medium and unclassifiable strong candidates inconclusive', () => {
    const collector = new EvidenceCollector({ auditId: 'generic-uncertain', domain: 'example.com', geo: 'USA', selectedModules: ['server_side'] });
    collector.captureRequests({ url: 'https://collect.example.com/a', body: 'event_name=page_view&session_id=s&page_url=https%3A%2F%2Fshop.example.com', method: 'POST', phase: 'homepage', observed_page_url: 'https://shop.example.com/' });
    expect(classify([], { measurement_candidates: collector.bundle.server_side.measurement_candidates }))
      .toMatchObject({ status: 'inconclusive', reason_code: 'SERVER_MEASUREMENT_CANDIDATE_AMBIGUOUS' });
    collector.bundle.server_side.measurement_candidates[0].strength = 'strong';
    collector.bundle.server_side.measurement_candidates[0].relationship = 'unclassifiable';
    expect(classify([], { measurement_candidates: collector.bundle.server_side.measurement_candidates }))
      .toMatchObject({ status: 'inconclusive', reason_code: 'SERVER_COLLECTOR_RELATIONSHIP_UNCLASSIFIABLE' });
  });

  it('replays generic first-party collection and preserves positives after interruption or truncation', () => {
    const collector = new EvidenceCollector({ auditId: 'generic-replay', domain: 'example.com', geo: 'USA', selectedModules: ['server_side'] });
    collector.captureRequests({ url: 'https://collect.example.com/a',
      body: 'event_name=purchase&client_id=private&session_id=private&page_url=https%3A%2F%2Fshop.example.com%2F&currency=USD&value=99',
      method: 'POST', phase: 'homepage', observed_page_url: 'https://shop.example.com/' });
    const bundle = evidence();
    bundle.server_side.measurement_candidates = collector.bundle.server_side.measurement_candidates;
    bundle.network.observation!.request_capture_completed = false;
    bundle.network.relevant_requests_truncated = true;
    bundle.server_side.candidate_truncated = true;
    const live = classify([], { measurement_candidates: bundle.server_side.measurement_candidates, observation_complete: false,
      request_evidence_truncated: true, candidate_truncated: true });
    const replay = replayEvidence(bundle);
    expect(live).toMatchObject({ status: 'first_party_collection_detected', collection_type: 'first_party' });
    expect(replay).toMatchObject({ server_side_status: live.status, ss_collection_type: live.collection_type });
    expect(replay.evidence_bundle?.decision_summary?.find((decision) => decision.decision_name === 'server_side')?.blocking_uncertainty).toEqual([]);
  });

  it('replays request truncation as inconclusive when no positive is retained', () => {
    const bundle = evidence();
    bundle.network.relevant_requests_truncated = true;
    const replay = replayEvidence(bundle);
    expect(replay).toMatchObject({ server_side_status: 'inconclusive', ss_collection_type: 'inconclusive' });
    expect(replay.finding_confidence?.server_side.reason_code).toBe('SERVER_REQUEST_EVIDENCE_TRUNCATED');
  });

  it.each([
    ['first-party', [request('first_party')], false],
    ['mixed duplicate', [request('first_party'), request('third_party', 2)], false],
    ['third-party only', [request('third_party')], false],
    ['incomplete', [], true],
    ['complete negative', [], false]
  ] as const)('matches live classification and canonical replay for %s', (_, requests, incomplete) => {
    const bundle = evidence();
    bundle.network.relevant_requests = [...requests];
    bundle.network.observation!.request_capture_completed = !incomplete;
    const live = classify([...requests], { observation_complete: !incomplete });
    const replay = replayEvidence(bundle);
    expect(replay.server_side_status).toBe(live.status);
    expect(replay.ss_collection_type).toBe(live.collection_type);
  });
});
