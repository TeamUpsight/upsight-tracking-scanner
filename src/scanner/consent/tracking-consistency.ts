import type { TrackingRequestEvidence } from '../../types';
import type { VerificationResult } from './domain-types';

export type TrackingConsistencyStatus = 'consistent' | 'contradiction' | 'insufficient_evidence' | 'not_applicable';
export type TrackingConsistencyVendor = 'google_analytics' | 'google_ads' | 'meta' | 'tiktok' | 'snapchat' | 'pinterest' | 'x' | 'floodlight';
export type TrackingSignalKind = 'script_load' | 'event_hit' | 'conversion_hit';
export type TrackingSignalTiming = 'pre_action' | 'post_verified_reject' | 'post_action_unverified' | 'unknown';

export const TrackingConsistencyCodes = {
  REJECT_NOT_VERIFIED: 'REJECT_NOT_VERIFIED',
  POST_REJECT_EVENT_HIT: 'POST_REJECT_EVENT_HIT',
  POST_REJECT_OBSERVATION_INCOMPLETE: 'POST_REJECT_OBSERVATION_INCOMPLETE',
  NO_POST_REJECT_EVENT_HIT: 'NO_POST_REJECT_EVENT_HIT'
} as const;

export interface TrackingConsistencySignal {
  vendor: TrackingConsistencyVendor;
  kind: TrackingSignalKind;
  timing: TrackingSignalTiming;
  host: string;
  path: string;
  timestamp: number;
}

export interface TrackingConsistencyInput {
  /** Kept separate from the resulting tracking-consistency status. */
  rejection_verification: VerificationResult;
  reject_timestamp: number | null;
  post_reject_observation_completed: boolean;
  requests: readonly TrackingRequestEvidence[];
}

export interface TrackingConsistencyResult {
  status: TrackingConsistencyStatus;
  signals: TrackingConsistencySignal[];
  reason_codes: string[];
}

const CONVERSION_EVENTS = new Set([
  'purchase', 'lead', 'completepayment', 'checkout', 'subscribe', 'registration', 'complete_registration'
]);

function normalizedPath(value: string) {
  return value.toLowerCase().replace(/\/+$/, '') || '/';
}

function normalizedEvent(value: string | undefined) {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function vendorFor(request: TrackingRequestEvidence): TrackingConsistencyVendor | null {
  const host = request.host.toLowerCase();
  const path = normalizedPath(request.path);
  if (request.vendor === 'ga4' || host.endsWith('google-analytics.com')) return 'google_analytics';
  if ((host === 'ad.doubleclick.net' || host.endsWith('.ad.doubleclick.net')) && /\/(?:ddm\/)?activity(?:\/|$)/.test(path)) return 'floodlight';
  if (request.vendor === 'google_ads' || host.endsWith('googleadservices.com') || host.endsWith('doubleclick.net')) return 'google_ads';
  if (request.vendor === 'meta' || host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'connect.facebook.net') return 'meta';
  if (host === 'analytics.tiktok.com' || host.endsWith('.analytics.tiktok.com')) return 'tiktok';
  if (host === 'tr.snapchat.com' || host.endsWith('.tr.snapchat.com')) return 'snapchat';
  if (host === 'ct.pinterest.com' || host.endsWith('.ct.pinterest.com')) return 'pinterest';
  if (host === 'analytics.twitter.com' || host.endsWith('.analytics.twitter.com') || host === 'static.ads-twitter.com') return 'x';
  return null;
}

function isVendorEndpoint(vendor: TrackingConsistencyVendor, request: TrackingRequestEvidence) {
  const path = normalizedPath(request.path);
  if (request.kind === 'script') return /\.js$/.test(path) || vendor === 'meta';
  switch (vendor) {
    case 'google_analytics': return /\/(?:g\/)?collect$/.test(path);
    case 'google_ads': return /\/(?:pagead\/)?conversion(?:\/|$)|\/collect$/.test(path);
    case 'meta': return /^\/tr(?:\/|$)/.test(path);
    case 'tiktok': return /\/(?:api\/)?(?:v\d+\/)?pixel\/(?:track|event)|\/event(?:\/|$)/.test(path);
    case 'snapchat': return /\/(?:p|track)(?:\/|$)/.test(path);
    case 'pinterest': return /\/(?:v\d+\/)?(?:event|ct)(?:\/|$)/.test(path);
    case 'x': return /\/i\/adsct|\/track(?:\/|$)/.test(path);
    case 'floodlight': return /\/(?:ddm\/)?activity(?:\/|$)/.test(path);
  }
}

function signalKind(request: TrackingRequestEvidence): TrackingSignalKind | null {
  const vendor = vendorFor(request);
  if (!vendor || !isVendorEndpoint(vendor, request)) return null;
  if (request.kind === 'script') return 'script_load';
  const event = normalizedEvent(request.event);
  if (!event && vendor !== 'floodlight') return null;
  return CONVERSION_EVENTS.has(event) || vendor === 'floodlight' ? 'conversion_hit' : 'event_hit';
}

function timingFor(request: TrackingRequestEvidence, input: TrackingConsistencyInput): TrackingSignalTiming {
  if (!Number.isFinite(request.timestamp) || input.reject_timestamp === null || !Number.isFinite(input.reject_timestamp)) return 'unknown';
  if (request.timestamp < input.reject_timestamp) return 'pre_action';
  return input.rejection_verification.status === 'verified' ? 'post_verified_reject' : 'post_action_unverified';
}

/**
 * Converts existing, bounded tracking evidence into a minimal post-Reject
 * signal. Script loads remain distinct from event and conversion hits.
 */
export function classifyTrackingConsistencyRequest(
  request: TrackingRequestEvidence,
  input: TrackingConsistencyInput
): TrackingConsistencySignal | null {
  const vendor = vendorFor(request);
  const kind = signalKind(request);
  if (!vendor || !kind) return null;
  return {
    vendor,
    kind,
    timing: timingFor(request, input),
    host: request.host.toLowerCase(),
    path: normalizedPath(request.path),
    timestamp: request.timestamp
  };
}

/**
 * Evaluates tracking behavior only. It does not modify or reinterpret the
 * consent verification result passed to it.
 */
export function checkTrackingConsistency(input: TrackingConsistencyInput): TrackingConsistencyResult {
  const signals = input.requests
    .map((request) => classifyTrackingConsistencyRequest(request, input))
    .filter((signal): signal is TrackingConsistencySignal => signal !== null)
    .slice(0, 100);

  if (input.rejection_verification.status !== 'verified') {
    return { status: 'not_applicable', signals, reason_codes: [TrackingConsistencyCodes.REJECT_NOT_VERIFIED] };
  }

  const postRejectEvents = signals.filter((signal) =>
    signal.timing === 'post_verified_reject' && (signal.kind === 'event_hit' || signal.kind === 'conversion_hit')
  );
  if (postRejectEvents.length) {
    return { status: 'contradiction', signals, reason_codes: [TrackingConsistencyCodes.POST_REJECT_EVENT_HIT] };
  }
  if (!input.post_reject_observation_completed) {
    return { status: 'insufficient_evidence', signals, reason_codes: [TrackingConsistencyCodes.POST_REJECT_OBSERVATION_INCOMPLETE] };
  }
  return { status: 'consistent', signals, reason_codes: [TrackingConsistencyCodes.NO_POST_REJECT_EVENT_HIT] };
}
