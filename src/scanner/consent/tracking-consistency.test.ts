import { describe, expect, it } from 'vitest';
import type { TrackingRequestEvidence } from '../../types';
import type { VerificationResult } from './domain-types';
import { captureConsentTrackingRequest, checkTrackingConsistency, TrackingConsistencyCodes } from './tracking-consistency';

const rejected = { status: 'verified' as const, evidence: ['semantic:provider:persisted'], reason_codes: ['ACTION_VERIFIED' as const] };
const unverified = { status: 'inconclusive' as const, evidence: [], reason_codes: ['ACTION_INCONCLUSIVE' as const] };
const rejectTimestamp = 1_000;

function request(overrides: Partial<TrackingRequestEvidence> = {}): TrackingRequestEvidence {
  return {
    vendor: 'meta', kind: 'collection', collector: 'third_party', host: 'www.facebook.com', path: '/tr', method: 'GET',
    phase: 'post_action', timestamp: rejectTimestamp + 1, event: 'ViewContent', ...overrides
  };
}

function check(requests: TrackingRequestEvidence[], verification: VerificationResult = rejected, complete = true) {
  return checkTrackingConsistency({ rejection_verification: verification, user_choice_at: rejectTimestamp, post_reject_observation_completed: complete, requests });
}

describe('consent versus tracking consistency', () => {
  it('keeps a script load after verified Reject consistent', () => {
    const result = check([request({ kind: 'script', host: 'connect.facebook.net', path: '/en_US/fbevents.js', event: undefined })]);
    expect(result).toMatchObject({ status: 'consistent', signals: [{ kind: 'script_load', timing: 'post_verified_reject' }] });
  });

  it('reports an event hit after verified Reject as a contradiction', () => {
    const result = check([request()]);
    expect(result).toMatchObject({ status: 'contradiction', reason_codes: [TrackingConsistencyCodes.POST_REJECT_EVENT_HIT], signals: [{ kind: 'event_hit' }] });
  });

  it('reports a conversion after verified Reject as a contradiction', () => {
    const result = check([request({ event: 'Purchase' })]);
    expect(result).toMatchObject({ status: 'contradiction', signals: [{ kind: 'conversion_hit' }] });
  });

  it('keeps a Floodlight conversion distinct from generic Google Ads collection', () => {
    const result = check([request({ vendor: 'unknown', host: 'ad.doubleclick.net', path: '/ddm/activity', event: undefined })]);
    expect(result).toMatchObject({ status: 'contradiction', signals: [{ vendor: 'floodlight', kind: 'conversion_hit' }] });
  });

  it('classifies Floodlight before broader DoubleClick Google Ads collection', () => {
    expect(captureConsentTrackingRequest({ url: 'https://ad.doubleclick.net/ddm/activity', resource_type: 'image', method: 'GET', timestamp: 10 }))
      .toMatchObject({ vendor: 'floodlight', kind: 'collection' });
    expect(captureConsentTrackingRequest({ url: 'https://www.googleadservices.com/pagead/conversion/123', resource_type: 'image', method: 'GET', timestamp: 10 }))
      .toMatchObject({ vendor: 'google_ads', kind: 'collection' });
  });

  it('BUFFER-01 through BUFFER-03 ignores unrelated requests, retains later vendor events, and remains bounded', () => {
    const requests: TrackingRequestEvidence[] = [];
    for (let index = 0; index < 150; index += 1) {
      const unknown = captureConsentTrackingRequest({ url: `https://storefront.example/api/resource-${index}?private=value`, resource_type: 'fetch', method: 'GET', timestamp: index });
      if (unknown && requests.length < 100) requests.push(unknown);
    }
    for (const input of [
      { url: 'https://www.google-analytics.com/g/collect?en=page_view&secret=value', post_data: undefined },
      { url: 'https://www.facebook.com/tr/?event_name=Purchase&secret=value', post_data: undefined },
      { url: 'https://analytics.tiktok.com/api/v1/pixel/track', post_data: 'event=CompletePayment&email=secret@example.com' }
    ]) {
      const captured = captureConsentTrackingRequest({ ...input, resource_type: 'fetch', method: input.post_data ? 'POST' : 'GET', timestamp: 200 });
      if (captured && requests.length < 100) requests.push(captured);
    }
    const result = checkTrackingConsistency({ rejection_verification: unverified, user_choice_at: null, post_reject_observation_completed: false, requests });
    expect(requests).toHaveLength(3);
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ vendor: 'google_analytics', timing: 'pre_choice' }),
      expect.objectContaining({ vendor: 'meta', kind: 'conversion_hit', timing: 'pre_choice' }),
      expect.objectContaining({ vendor: 'tiktok', kind: 'conversion_hit', timing: 'pre_choice' })
    ]));
    expect(JSON.stringify(requests)).not.toContain('secret=value');
    expect(JSON.stringify(requests)).not.toContain('secret@example.com');
  });

  it('is consistent when a completed post-Reject observation has no activity', () => {
    expect(check([])).toMatchObject({ status: 'consistent', reason_codes: [TrackingConsistencyCodes.NO_POST_REJECT_EVENT_HIT] });
  });

  it('does not treat activity before Reject as leakage after Reject', () => {
    const result = check([request({ timestamp: rejectTimestamp - 1 })]);
    expect(result).toMatchObject({ status: 'consistent', signals: [{ timing: 'pre_choice' }] });
  });

  it('keeps verified Reject intact while separately reporting a contradiction', () => {
    const verification = Object.freeze({ ...rejected });
    const result = check([request({ event: 'Purchase' })], verification);
    expect(result.status).toBe('contradiction');
    expect(verification.status).toBe('verified');
  });

  it('does not call an unverified Reject plus vendor hit a tracking contradiction', () => {
    const result = check([request({ event: 'Purchase' })], unverified);
    expect(result).toMatchObject({ status: 'not_applicable', reason_codes: [TrackingConsistencyCodes.REJECT_NOT_VERIFIED], signals: [{ timing: 'post_action_unverified' }] });
  });

  it('classifies observation-only requests as pre-choice without a Reject timestamp', () => {
    const result = checkTrackingConsistency({ rejection_verification: unverified, user_choice_at: null, post_reject_observation_completed: false, requests: [request()] });
    expect(result).toMatchObject({ status: 'not_applicable', signals: [{ timing: 'pre_choice' }] });
  });

  it.each([
    ['GA4', 'https://www.google-analytics.com/g/collect', 'en=purchase', 'ga4'],
    ['Meta', 'https://www.facebook.com/tr/', 'event_name=Purchase', 'meta'],
    ['TikTok', 'https://analytics.tiktok.com/api/v1/pixel/track', 'event=CompletePayment', 'tiktok'],
    ['Snapchat', 'https://tr.snapchat.com/p', 'event_type=PURCHASE', 'snapchat'],
    ['Pinterest', 'https://ct.pinterest.com/v3/event', 'event_name=checkout', 'pinterest'],
    ['X', 'https://analytics.twitter.com/i/adsct', 'event=registration', 'x']
  ] as const)('extracts only a normalized %s POST event', (_name, url, postData, vendor) => {
    const captured = captureConsentTrackingRequest({ url, resource_type: 'fetch', method: 'POST', post_data: postData, timestamp: 10 });
    expect(captured).toMatchObject({ vendor, event: expect.any(String), method: 'POST' });
    expect(JSON.stringify(captured)).not.toContain(postData);
  });

  it('ignores oversized, malformed, and nested POST bodies', () => {
    expect(captureConsentTrackingRequest({ url: 'https://www.google-analytics.com/g/collect', resource_type: 'fetch', method: 'POST', post_data: `en=${'x'.repeat(5_000)}` })?.event).toBeUndefined();
    expect(captureConsentTrackingRequest({ url: 'https://analytics.tiktok.com/api/v1/pixel/track', resource_type: 'fetch', method: 'POST', post_data: '{bad' })?.event).toBeUndefined();
    expect(captureConsentTrackingRequest({ url: 'https://analytics.tiktok.com/api/v1/pixel/track', resource_type: 'fetch', method: 'POST', post_data: '{"data":{"event":"Purchase"}}' })?.event).toBeUndefined();
  });
});
