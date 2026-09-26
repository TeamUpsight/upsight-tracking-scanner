import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { normalizeReplayEvidence, replayEvidence } from '../quality/replay';
import { findStrictDuplicates } from '../server-side/classify-collection';
import { captureConsentTrackingRequests, ConsentRequestBuffer, normalizeConsentMeasurement } from '../consent/tracking-consistency';
import { GoogleConsentModeObserver } from '../consent/google-consent-mode-observer';
import { isGA4BatchTruncated, parseGA4Request, parseGA4Requests } from './ga4';
import type { TrackingRequestEvidence } from '../../types';

const endpoint = 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST&en=view_item&';
const collector = () => new EvidenceCollector({ auditId: 'ln03', domain: 'example.com', geo: 'USA' });

describe('LN-03 GA4 wire fidelity', () => {
  it('decodes compact values only after splitting literal wire delimiters', () => {
    expect(parseGA4Request(`${endpoint}pr1=idSKU123~nmCoffee%7ETable`)).toMatchObject({
      product_id: 'SKU123', product_name: 'Coffee~Table', has_product: true
    });
    expect(parseGA4Request(`${endpoint}pr1=idSKU%26123~nmCoffee%20Table%3DSpecial`)).toMatchObject({
      product_id: 'SKU&123', product_name: 'Coffee Table=Special', has_product: true
    });
  });

  it('retains bounded best-effort evidence for malformed compact encoding', () => {
    expect(() => parseGA4Request(`${endpoint}pr1=idSKU~nmBad%ZZName`)).not.toThrow();
    expect(parseGA4Request(`${endpoint}pr1=idSKU~nmBad%ZZName`)).toMatchObject({ product_id: 'SKU', has_product: true });
  });

  it('preserves POST form boundaries, plus encoding, and bounded item and batch limits', () => {
    expect(parseGA4Request('https://www.google-analytics.com/g/collect', 'v=2&tid=G-TEST&en=view_item&pr1=idSKU%3D42~nmCoffee+Table%26More')).toMatchObject({
      product_id: 'SKU=42', product_name: 'Coffee Table&More'
    });
    const products = Array.from({ length: 25 }, (_, index) => `pr${index + 1}=idSKU${index + 1}`).join('&');
    expect(parseGA4Request(`${endpoint}${products}`)?.product_item_count).toBe(20);
    const body = Array.from({ length: 25 }, (_, index) => `v=2&tid=G-TEST&en=event_${index}`).join('\n');
    expect(parseGA4Requests('https://www.google-analytics.com/g/collect', body)).toHaveLength(20);
    expect(isGA4BatchTruncated(Array.from({ length: 20 }, () => 'v=2&tid=G-TEST&en=page_view').join('\n') + '\n')).toBe(false);
    expect(isGA4BatchTruncated(body)).toBe(true);
    const padded = 'v=2&tid=G-TEST&en=page_view&x=';
    const last = 'v=2&tid=G-TEST&en=view_item&x=';
    const fullBatch = [
      ...Array.from({ length: 19 }, () => padded + 'x'.repeat(16_384 - padded.length)),
      last + 'x'.repeat(16_384 - last.length - '&pr1=idTAIL'.length) + '&pr1=idTAIL'
    ].join('\n');
    expect(isGA4BatchTruncated(fullBatch)).toBe(false);
    expect(parseGA4Requests('https://www.google-analytics.com/g/collect', fullBatch)[19]?.product_id).toBe('TAIL');
    const evidence = collector();
    evidence.captureRequests({ url: 'https://www.google-analytics.com/g/collect', body, phase: 'product_pdp_load' });
    expect(evidence.bundle.network.relevant_requests_truncated).toBe(true);
    expect(evidence.bundle.network.total_requests).toBe(1);
    const gcm = new GoogleConsentModeObserver();
    expect(gcm.observeMeasurementRequests({ url: 'https://www.google-analytics.com/g/collect', body: 'gcs=G100\ngcs=G111' })).toHaveLength(2);
  });

  it('selects the first usable product in numeric prN order and counts usable items', () => {
    expect(parseGA4Request(`${endpoint}pr2=idB~nmProduct%20B&pr1=idA~nmProduct%20A`)).toMatchObject({
      product_id: 'A', product_name: 'Product A', product_item_count: 2, has_product: true
    });
    expect(parseGA4Request(`${endpoint}pr1=brBrandOnly&pr2=idSKU2~nmSecond`)).toMatchObject({
      product_id: 'SKU2', product_item_count: 1, has_product: true
    });
  });

  it('retains every bounded GA4 batch event without multiplying physical request count', () => {
    const body = readFileSync(path.join(process.cwd(), 'tests/fixtures/ln03-ga4-batch.txt'), 'utf8');
    const parsed = parseGA4Requests('https://www.google-analytics.com/g/collect', body);
    expect(parsed.map((event) => event.event)).toEqual(['page_view', 'view_item']);
    expect(parsed[1]).toMatchObject({ has_product: true, product_id: 'SKU' });
    const evidence = collector();
    const captured = evidence.captureRequests({
      url: 'https://www.google-analytics.com/g/collect', body, method: 'POST', phase: 'product_pdp_load',
      observed_page_id: 'page_2', observed_page_url: 'https://example.com/products/widget?private=x', navigation_epoch: 3,
      source: 'page', timestamp: 100
    });
    expect(captured.map((event) => event.event)).toEqual(['page_view', 'view_item']);
    expect(evidence.bundle.network.total_requests).toBe(1);
    expect(evidence.bundle.product.ga4_view_item_hits).toHaveLength(1);
    expect(captured[1]).toMatchObject({ observed_page_id: 'page_2', observed_page_url: 'https://example.com/products/widget', navigation_epoch: 3, source: 'page', timestamp: 100 });
    const consentEvents = captureConsentTrackingRequests({ url: 'https://www.google-analytics.com/g/collect', post_data: body, resource_type: 'fetch', method: 'POST', timestamp: 100 });
    expect(consentEvents.map((event) => event.event)).toEqual(['page_view', 'view_item']);
    const buffer = new ConsentRequestBuffer();
    for (const event of consentEvents) buffer.append(event);
    expect(normalizeConsentMeasurement(buffer.requests, 'fresh', null).pre_choice_event_hits).toBe(2);
  });

  it('recognizes semantic GA4 on arbitrary routes and rejects weak controls', () => {
    expect(parseGA4Request('https://shop.example/custom-prefix/collect?v=2&tid=G-TEST123&en=view_item&pr1=idSKU~nmWidget')).toMatchObject({
      vendor: 'ga4', kind: 'collection', endpoint_type: 'first_party', event: 'view_item', has_product: true
    });
    for (const url of [
      '/custom?v=2&tid=G-TEST', '/custom?v=2&en=page_view', '/custom?tid=G-TEST&en=page_view',
      '/api/events?event=page_view&id=123', '/api/collect?cid=123&sid=456'
    ]) expect(parseGA4Request(`https://shop.example${url}`)).toBeNull();
    for (const host of ['google-analytics.com', 'analytics.google.com', 'region1.google-analytics.com', 'stats.g.doubleclick.net']) {
      expect(parseGA4Request(`https://${host}/g/collect?tid=G-TEST&en=page_view`)?.kind).toBe('collection');
    }
  });
});

describe('LN-03 privacy-safe correlation', () => {
  it('persists audit-local GA4 and Meta tokens without raw identifiers or unsafe vendor URLs', () => {
    const evidence = collector();
    const ga4Url = `${endpoint}cid=RAW_CLIENT_123456&sid=RAW_SESSION_987654&dl=${encodeURIComponent('https://example.com/products/widget?email=test@example.com&utm_source=x#reviews')}&pr1=idSKU`;
    const a = evidence.captureRequest({ url: ga4Url, phase: 'product_pdp_load', timestamp: 1 })!;
    const b = evidence.captureRequest({ url: ga4Url, phase: 'product_pdp_load', timestamp: 2 })!;
    const c = evidence.captureRequest({ url: ga4Url.replace('RAW_CLIENT_123456', 'OTHER_CLIENT'), phase: 'product_pdp_load', timestamp: 3 })!;
    const meta = evidence.captureRequest({ url: 'https://www.facebook.com/tr/?id=123456&ev=ViewContent&fbp=RAW_FBP_123456&fbc=RAW_FBC_987654&dl=https%3A%2F%2Fexample.com%2Fproducts%2Fwidget%3Femail%3Dprivate%23details', phase: 'product_pdp_load' })!;
    expect(a.page_url).toBe('https://example.com/products/widget');
    expect(meta.page_url).toBe('https://example.com/products/widget');
    expect(a.correlation?.ga4_client).toBeTruthy();
    expect(a.correlation?.ga4_client).toBe(b.correlation?.ga4_client);
    expect(a.correlation?.ga4_session).toBe(b.correlation?.ga4_session);
    expect(a.correlation?.ga4_client).not.toBe(c.correlation?.ga4_client);
    expect(meta.correlation?.meta_browser).toBeTruthy();
    expect(meta.correlation?.meta_click).toBeTruthy();
    const metaAgain = evidence.captureRequest({ url: 'https://www.facebook.com/tr/?id=123456&ev=ViewContent&fbp=RAW_FBP_123456&fbc=RAW_FBC_987654', phase: 'product_pdp_load' })!;
    expect(metaAgain.correlation?.meta_browser).toBe(meta.correlation?.meta_browser);
    expect(collector().captureRequest({ url: ga4Url, phase: 'product_pdp_load' })?.correlation?.ga4_client).not.toBe(a.correlation?.ga4_client);
    expect(JSON.stringify(evidence.bundle)).not.toMatch(/RAW_CLIENT_123456|RAW_SESSION_987654|RAW_FBP_123456|RAW_FBC_987654|test@example.com/);
    evidence.bundle.page.valid = true;
    evidence.bundle.product.executed = true;
    evidence.bundle.product.discovery_executed = true;
    evidence.bundle.product.pdp_url = 'https://example.com/products/widget';
    evidence.bundle.product.navigation_succeeded = true;
    expect(replayEvidence(evidence.bundle).product_payload_status).toBe('pass');
  });

  it('normalizes legacy raw values into replay-local tokens without mutating source', () => {
    const source = collector().bundle;
    const base = { vendor: 'ga4' as const, kind: 'collection' as const, collector: 'third_party' as const, host: 'analytics.google.com', path: '/g/collect', method: 'GET', phase: 'product_pdp_load', timestamp: 1, event: 'view_item', measurement_id: 'G-TEST', page_url: 'https://example.com/products/widget?private=1', client_id: 'RAW_CLIENT', session_id: 'RAW_SESSION', has_product: true, product_id: 'SKU' };
    source.network.relevant_requests = [base, { ...base, collector: 'first_party', host: 'data.example.com', timestamp: 2 }, { ...base, vendor: 'meta', pixel_id: '123456', measurement_id: undefined, fbp: 'RAW_FBP', fbc: 'RAW_FBC' }] as TrackingRequestEvidence[];
    source.product.ga4_view_item_hits = [source.network.relevant_requests[0]];
    const normalized = normalizeReplayEvidence(source);
    expect(JSON.stringify(normalized)).not.toMatch(/RAW_CLIENT|RAW_SESSION|RAW_FBP|RAW_FBC|private=1/);
    expect(normalized.network.relevant_requests[0].correlation?.ga4_client).toBe(normalized.network.relevant_requests[1].correlation?.ga4_client);
    expect(normalized.product.ga4_view_item_hits[0].correlation?.ga4_client).toBe(normalized.network.relevant_requests[0].correlation?.ga4_client);
    expect(normalized.network.relevant_requests[2].correlation?.meta_browser).toBeTruthy();
    expect(findStrictDuplicates(normalized.network.relevant_requests)).toHaveLength(1);
    expect(JSON.stringify(source)).toContain('RAW_CLIENT');
    expect(normalizeReplayEvidence(source).network.relevant_requests[0].correlation?.ga4_client).not.toBe(normalized.network.relevant_requests[0].correlation?.ga4_client);
    source.page.valid = true;
    source.access.valid_storefront = true;
    source.product.executed = true;
    source.product.discovery_executed = true;
    source.product.pdp_url = 'https://example.com/products/widget';
    source.product.navigation_succeeded = true;
    const replayed = replayEvidence(source);
    expect(replayed.product_payload_status).toBe('pass');
    expect(JSON.stringify(replayed.evidence_bundle)).not.toMatch(/RAW_CLIENT|RAW_SESSION|RAW_FBP|RAW_FBC|private=1/);
  });

  it('marks retained evidence incomplete when a batch exceeds the request cap', () => {
    const evidence = collector();
    for (let index = 0; index < 199; index += 1) evidence.captureRequest({ url: 'https://www.google-analytics.com/g/collect?tid=G-TEST&en=page_view', phase: 'product_pdp_load' });
    const body = readFileSync(path.join(process.cwd(), 'tests/fixtures/ln03-ga4-batch.txt'), 'utf8');
    evidence.captureRequests({ url: 'https://www.google-analytics.com/g/collect', body, method: 'POST', phase: 'product_pdp_load' });
    expect(evidence.bundle.network.total_requests).toBe(200);
    expect(evidence.bundle.network.relevant_requests).toHaveLength(200);
    expect(evidence.bundle.network.relevant_requests_truncated).toBe(true);
    expect(evidence.bundle.product.ga4_view_item_hits).toHaveLength(0);
  });

  it('scrubs raw identifier fields at the final EvidenceBundle boundary', () => {
    const evidence = collector();
    const request = evidence.captureRequest({ url: `${endpoint}pr1=idSKU`, phase: 'product_pdp_load' })!;
    (request as TrackingRequestEvidence & { client_id: string }).client_id = 'RAW_INJECTED_CLIENT';
    evidence.complete(Date.now());
    expect(JSON.stringify(evidence.bundle)).not.toContain('RAW_INJECTED_CLIENT');
    expect(evidence.bundle.network.relevant_requests[0].correlation?.ga4_client).toBeTruthy();
  });
});
