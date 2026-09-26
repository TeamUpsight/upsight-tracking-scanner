import { describe, expect, it } from 'vitest';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { replayEvidence } from '../quality/replay';
import { classifyCollectorRelationship } from './collector-relationship';
import { classifyCollection } from './classify-collection';

const collector = (domain = 'example.com', mode: 'normal' | 'diagnostic' = 'normal') =>
  new EvidenceCollector({ auditId: 'ln04', domain, geo: 'USA', mode, selectedModules: ['server_side'] });

function capture(url: string, body = '', page = 'https://shop.example.com/products/a') {
  const evidence = collector();
  evidence.captureRequests({ url, body, method: body ? 'POST' : 'GET', phase: 'product_pdp_load', timestamp: 1,
    observed_page_id: 'page_1', observed_page_url: page, navigation_epoch: 1 });
  return evidence;
}

function classify(evidence: EvidenceCollector) {
  return classifyCollection({ executed: true, page_valid: true, observation_complete: true,
    requests: evidence.bundle.network.relevant_requests,
    measurement_candidates: evidence.bundle.server_side.measurement_candidates,
    candidate_truncated: evidence.bundle.server_side.candidate_truncated });
}

describe('LN-04 collector relationship', () => {
  it.each([
    ['https://shop.example.com/products/a', 'https://collect.example.com/events', 'first_party'],
    ['https://shop.example.co.uk/products/a', 'https://analytics.example.co.uk/collect', 'first_party'],
    ['https://shop.example.co.uk', 'https://analytics.other.co.uk', 'third_party'],
    ['https://example.com/products/a', 'https://example.com/events', 'same_origin'],
    ['https://example.com', 'https://example.com:443/events', 'same_origin'],
    ['http://example.com', 'http://example.com:80/events', 'same_origin'],
    ['https://example.com', 'https://example.com:8443/events', 'first_party'],
    ['https://example.com', 'http://example.com/events', 'first_party'],
    ['https://www.example.com', 'https://example.com/events', 'first_party'],
    [undefined, 'https://example.com/events', 'unclassifiable'],
    ['not a URL', 'https://example.com/events', 'unclassifiable'],
    ['https://example.com', 'not a URL', 'unclassifiable']
  ] as const)('%s to %s is %s', (page, request, expected) => {
    expect(classifyCollectorRelationship(request, page)).toBe(expected);
  });

  it('uses committed observed origin after a redirect and leaves unassociated requests uncertain', () => {
    const evidence = collector();
    evidence.captureRequests({ url: 'https://www.example.com/custom?v=2&tid=G-TEST&en=page_view',
      phase: 'homepage', observed_page_url: 'https://www.example.com/', timestamp: 1 });
    expect(evidence.bundle.network.relevant_requests[0].collector).toBe('same_origin');
    const worker = collector();
    worker.captureRequests({ url: 'https://example.com/custom?v=2&tid=G-TEST&en=page_view',
      phase: 'homepage', source: 'service_worker', timestamp: 1 });
    expect(worker.bundle.network.relevant_requests[0].collector).toBe('unclassifiable');
  });
});

describe('LN-04 provider-neutral candidates', () => {
  const strong = 'event_name=purchase&client_id=RAW_SECRET_CLIENT_123&session_id=RAW_SESSION_123&page_url=https%3A%2F%2Fexample.com%2Fcheckout%3Femail%3DRAW_EMAIL_TEST%40example.com&currency=USD&value=99.00';
  const medium = 'event_name=page_view&session_id=RAW_SESSION_123&page_url=https%3A%2F%2Fexample.com%2Fhome';

  it.each(['/v1/ingest', '/a'])('accepts strong behavioral semantics on %s without retaining values', (path) => {
    const evidence = capture(`https://collect.example.com${path}`, strong);
    expect(evidence.bundle.server_side.measurement_candidates).toEqual([
      expect.objectContaining({ strength: 'strong', provider_hint: 'unknown', relationship: 'first_party', path })
    ]);
    expect(classify(evidence)).toMatchObject({ status: 'first_party_collection_detected', first_party_collection_count: 1 });
    expect(JSON.stringify(evidence.bundle)).not.toMatch(/RAW_SECRET_CLIENT_123|RAW_SESSION_123|RAW_EMAIL_TEST|email%3D/);
  });

  it('does not promote path names or one weak event parameter', () => {
    expect(capture('https://collect.example.com/events', 'event=save').bundle.server_side.measurement_candidates).toEqual([]);
    expect(capture('https://collect.example.com/collect').bundle.server_side.measurement_candidates).toEqual([]);
  });

  it('detects bounded JSON semantics without making generic repetition or cookies confidence evidence', () => {
    const evidence = capture('https://collect.example.com/a', JSON.stringify({
      event_name: 'purchase', client_id: 'RAW_SECRET_CLIENT_123', session_id: 'RAW_SESSION_123',
      page_url: 'https://example.com/private?email=RAW_EMAIL_TEST@example.com', currency: 'USD', value: 99
    }));
    expect(evidence.bundle.server_side.measurement_candidates[0].strength).toBe('strong');
    for (let i = 0; i < 3; i += 1) evidence.captureRequests({ url: 'https://collect.example.com/a',
      body: 'event_name=purchase&client_id=x&session_id=y&page_url=z&currency=USD',
      phase: 'homepage', observed_page_url: 'https://shop.example.com/' });
    expect(classifyCollection({ executed: true, page_valid: true, observation_complete: true,
      requests: evidence.bundle.network.relevant_requests,
      measurement_candidates: evidence.bundle.server_side.measurement_candidates,
      collector_cookie_detected: true, collector_cookie_persisted: true }).status).toBe('first_party_collection_detected');
    expect(JSON.stringify(evidence.bundle)).not.toMatch(/RAW_SECRET_CLIENT_123|RAW_SESSION_123|RAW_EMAIL_TEST/);
  });

  it('does not retain generic candidates when Server-side is unselected', () => {
    const evidence = new EvidenceCollector({ auditId: 'ln04', domain: 'example.com', geo: 'USA', selectedModules: ['tracking'] });
    evidence.captureRequests({ url: 'https://collect.example.com/a', body: strong,
      phase: 'homepage', observed_page_url: 'https://example.com/' });
    expect(evidence.bundle.server_side.measurement_candidates).toEqual([]);
  });

  it('removes identifier-shaped path segments and keeps parameter parsing bounded', () => {
    const evidence = capture('https://collect.example.com/a/RAW_SECRET_CLIENT_123',
      `${strong}&${Array.from({ length: 1000 }, (_, index) => `unknown_${index}=x`).join('&')}`);
    expect(evidence.bundle.server_side.measurement_candidates[0].path).toBe('/a/:id');
    expect(JSON.stringify(evidence.bundle)).not.toContain('RAW_SECRET_CLIENT_123');
    expect(evidence.bundle.server_side.measurement_candidates[0].semantic_groups.length).toBeLessThanOrEqual(5);
  });

  it('keeps one medium candidate inconclusive, but corroborates a compatible endpoint family', () => {
    const evidence = capture('https://collect.example.com/v1/events', medium);
    expect(evidence.bundle.server_side.measurement_candidates[0].strength).toBe('medium');
    expect(classify(evidence)).toMatchObject({ status: 'inconclusive', reason_code: 'SERVER_MEASUREMENT_CANDIDATE_AMBIGUOUS' });
    evidence.captureRequests({ url: 'https://collect.example.com/v1/events', body: medium,
      method: 'POST', phase: 'product_pdp_load', timestamp: 2, observed_page_url: 'https://shop.example.com/products/a' });
    expect(classify(evidence)).toMatchObject({ status: 'first_party_collection_detected', first_party_collection_count: 1 });
  });

  it.each([
    ['/api/cart', 'product_id=SKU1&variant_id=V1&quantity=1'],
    ['/graphql', 'operationName=ProductQuery&variables=%7B%22id%22%3A1%7D'],
    ['/api/search?q=shoes', ''],
    ['/api/checkout/shipping', 'address_id=1&shipping_method=express'],
    ['/api/inventory', 'product_id=SKU1&location=Dubai'],
    ['/api/recommendations', 'product_id=SKU1&session_id=RAW_SESSION_123'],
    ['/sentry/envelope', 'exception=Error&stacktrace=trace&event_name=error&session_id=x&page_url=x'],
    ['/v1/traces', 'trace_id=x&span_id=y&service=web&duration=1&event_name=load'],
    ['/health', 'status=ok'],
    ['/metrics', 'metric=cpu&value=1']
  ])('rejects functional or technical traffic at %s', (path, body) => {
    expect(capture(`https://collect.example.com${path}`, body).bundle.server_side.measurement_candidates).toEqual([]);
  });

  it('keeps third-party and uncertain strong candidates conservative', () => {
    const third = capture('https://vendor.example.net/a', strong);
    expect(classify(third)).toMatchObject({ status: 'not_detected', collection_type: 'third_party', third_party_collection_count: 1 });
    const unknown = capture('https://collect.example.com/a', strong, 'invalid URL');
    expect(classify(unknown)).toMatchObject({ status: 'inconclusive', collection_type: 'inconclusive', reason_code: 'SERVER_COLLECTOR_RELATIONSHIP_UNCLASSIFIABLE' });
  });

  it('does not duplicate known GA4 or Meta collection as generic evidence', () => {
    const ga4 = capture('https://collect.example.com/custom-prefix/collect?v=2&tid=G-TEST&en=page_view', strong);
    expect(ga4.bundle.network.relevant_requests[0]).toMatchObject({ vendor: 'ga4', kind: 'collection', collector: 'first_party' });
    expect(ga4.bundle.server_side.measurement_candidates).toEqual([]);
    const meta = capture('https://www.facebook.com/tr/?id=123&ev=Purchase', strong);
    expect(meta.bundle.network.relevant_requests[0]).toMatchObject({ vendor: 'meta', kind: 'collection', collector: 'third_party' });
    expect(meta.bundle.server_side.measurement_candidates).toEqual([]);
  });

  it('caps candidate evidence, marks truncation, and handles malformed or oversized bodies', () => {
    const evidence = collector();
    for (let i = 0; i < 55; i += 1) evidence.captureRequests({ url: `https://collect.example.com/a/${i}`,
      body: strong, method: 'POST', phase: 'homepage', observed_page_url: 'https://shop.example.com/' });
    expect(evidence.bundle.server_side.measurement_candidates).toHaveLength(50);
    expect(evidence.bundle.server_side.candidate_truncated).toBe(true);
    expect(classifyCollection({ executed: true, page_valid: true, observation_complete: true,
      requests: [], measurement_candidates: [], candidate_truncated: true }).status).toBe('inconclusive');
    expect(() => evidence.captureRequests({ url: 'https://collect.example.com/a', body: '{invalid', phase: 'homepage' })).not.toThrow();
    expect(() => evidence.captureRequests({ url: 'https://collect.example.com/a', body: `${strong}&junk=${'x'.repeat(100_000)}`, phase: 'homepage' })).not.toThrow();
    expect(JSON.stringify(evidence.bundle)).not.toContain('x'.repeat(1000));
  });

  it('replays persisted candidate summaries without the original body', () => {
    const evidence = capture('https://collect.example.com/a', strong);
    evidence.bundle.page.valid = true;
    evidence.bundle.server_side.executed = true;
    Object.assign(evidence.bundle.network.observation!, { request_listener_active: true, request_capture_completed: true,
      data_layer_capture_completed: true, performance_capture_completed: true });
    evidence.bundle.server_side.passive_classification_completed = true;
    const live = classify(evidence);
    const replay = replayEvidence(evidence.bundle);
    expect(replay.server_side_status).toBe(live.status);
    expect(replay.ss_collection_type).toBe(live.collection_type);
  });
});
