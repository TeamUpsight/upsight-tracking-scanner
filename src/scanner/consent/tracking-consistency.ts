import type { TrackingRequestEvidence } from '../../types';
import type { VerificationResult } from './domain-types';
import { parseGA4Request } from '../tracking/ga4';
import { googleMeasurementFacts, type GoogleConsentModeResult } from './google-consent-mode-observer';

export type TrackingConsistencyStatus = 'consistent' | 'contradiction' | 'insufficient_evidence' | 'not_applicable';
export type TrackingConsistencyVendor = 'google_analytics' | 'google_ads' | 'meta' | 'tiktok' | 'snapchat' | 'pinterest' | 'x' | 'floodlight';
export type TrackingSignalKind = 'script_load' | 'event_hit' | 'conversion_hit';
export type TrackingSignalTiming = 'pre_choice' | 'post_verified_reject' | 'post_action_unverified' | 'unknown';

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
  phase?: string;
  consent_measurement?: TrackingRequestEvidence['consent_measurement'];
}

export interface TrackingConsistencyInput {
  /** Kept separate from the resulting tracking-consistency status. */
  rejection_verification: VerificationResult;
  /** The first user consent choice; absent during observation-only sessions. */
  user_choice_at: number | null;
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
  if (request.vendor === 'ga4' && request.kind === 'script' && path.includes('/gtag/js')) return true;
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
  if (!event && vendor !== 'floodlight' && request.vendor !== 'ga4') return null;
  return CONVERSION_EVENTS.has(event) || vendor === 'floodlight' ? 'conversion_hit' : 'event_hit';
}

function timingFor(request: TrackingRequestEvidence, input: TrackingConsistencyInput): TrackingSignalTiming {
  if (!Number.isFinite(request.timestamp)) return 'unknown';
  if (input.user_choice_at === null || !Number.isFinite(input.user_choice_at) || request.timestamp < input.user_choice_at) return 'pre_choice';
  return input.rejection_verification.status === 'verified' ? 'post_verified_reject' : 'post_action_unverified';
}

/** Normalizes request facts for Consent V2 without retaining a raw URL or query string. */
export function captureConsentTrackingRequest(input: {
  url: string;
  resource_type: string;
  method: string;
  /** Read by the browser bridge only; never included in returned evidence. */
  post_data?: string | null;
  timestamp?: number;
}): TrackingRequestEvidence | null {
  let parsed: URL;
  try { parsed = new URL(input.url); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  const ga4 = parseGA4Request(input.url, input.post_data || '');
  // Keep the bounded Consent buffer for supported collection evidence only.
  // Unknown resources otherwise crowd out later vendor events on busy pages.
  const vendor = ga4 || host.endsWith('google-analytics.com') ? 'ga4'
    : (host === 'ad.doubleclick.net' || host.endsWith('.ad.doubleclick.net')) && /\/(?:ddm\/)?activity(?:\/|$)/.test(normalizedPath(parsed.pathname)) ? 'floodlight'
      : /googleadservices\.com|doubleclick\.net/i.test(host) ? 'google_ads'
        : /facebook\.com|connect\.facebook/i.test(host) ? 'meta'
          : /tiktok\.com/i.test(host) ? 'tiktok'
            : /snapchat\.com/i.test(host) ? 'snapchat'
              : /pinterest\.com/i.test(host) ? 'pinterest'
                : /twitter\.com|x\.com/i.test(host) ? 'x'
                  : null;
  if (!vendor) return null;
  const bodyFields = safePostFields(input.post_data);
  const event = safeEventName(
    parsed.searchParams.get('en') || parsed.searchParams.get('ev') || parsed.searchParams.get('event') || parsed.searchParams.get('event_name') ||
    bodyFields.en || bodyFields.ev || bodyFields.event || bodyFields.event_name || bodyFields.eventName || bodyFields.event_type || bodyFields.eventType
  );
  // An eventless Google ping belongs to GCM observations unless the shared GA4
  // parser independently recognizes a collection (for example, a valid tid).
  if (vendor === 'ga4' && !ga4 && !event && input.resource_type !== 'script') return null;
  return {
    vendor,
    kind: ga4?.kind || (input.resource_type === 'script' ? 'script' : 'collection'),
    collector: 'third_party', host, path: normalizedPath(parsed.pathname), method: input.method,
    phase: 'consent_v2', timestamp: input.timestamp ?? Date.now(), event,
    consent_measurement: ga4?.consent_measurement
  };
}

const POST_BODY_MAX_BYTES = 4_096;
const POST_FIELD_MAX_COUNT = 24;
const SAFE_POST_EVENT_FIELDS = new Set(['en', 'ev', 'event', 'event_name', 'eventName', 'event_type', 'eventType']);

/**
 * Accepts only a short, shallow allowlist from form or JSON POST payloads.
 * It intentionally returns no body and never traverses nested structures.
 */
function safePostFields(value: string | null | undefined): Record<string, string> {
  if (!value || value.length > POST_BODY_MAX_BYTES) return {};
  const result: Record<string, string> = {};
  const accept = (key: string, candidate: unknown) => {
    if (Object.keys(result).length >= POST_FIELD_MAX_COUNT || !SAFE_POST_EVENT_FIELDS.has(key) || typeof candidate !== 'string') return;
    if (/^[A-Za-z0-9 _:.\-/]{1,120}$/.test(candidate)) result[key] = candidate;
  };
  try {
    if (value.trimStart().startsWith('{')) {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
      for (const [key, candidate] of Object.entries(parsed as Record<string, unknown>)) accept(key, candidate);
      return result;
    }
    const params = new URLSearchParams(value.replace(/^\?/, ''));
    for (const [key, candidate] of params) accept(key, candidate);
  } catch { /* Malformed or unsupported payloads simply yield no evidence. */ }
  return result;
}

function safeEventName(value: string | null | undefined) {
  return typeof value === 'string' && /^[A-Za-z0-9 _:.\-/]{1,120}$/.test(value) ? value : undefined;
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
    timestamp: request.timestamp,
    phase: request.phase,
    consent_measurement: request.consent_measurement
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

export type PreChoiceMeasurement = false | 'full_measurement' | 'limited_measurement' | 'unknown';
export type MeasurementContext = 'shared' | 'fresh';
export const isSharedPreChoicePhase = (phase: string) => /^(?:consent_initial_load|product_discovery|product_pdp_load)$/.test(phase);

export interface ConsentMeasurementRecord {
  context: MeasurementContext;
  phase: string;
  timestamp: number;
  timing: TrackingSignalTiming;
  evidence_type: TrackingRequestEvidence['kind'];
  signal_kind: TrackingSignalKind | null;
  classification: PreChoiceMeasurement;
  facts: ReturnType<typeof googleMeasurementFacts>;
}

export interface ConsentMeasurementCounts {
  tracking_requests_observed: number;
  tracking_requests_retained: number;
  tracking_signals_classified: number;
  pre_choice_event_hits: number;
  pre_choice_conversion_hits: number;
  pre_choice_script_loads: number;
  limited_measurement_count: number;
  full_measurement_count: number;
  unknown_measurement_count: number;
  gcm_network_observations: number;
  gcm_commands: number;
}

export interface ConsentMeasurementSource extends ConsentMeasurementCounts {
  context: MeasurementContext;
  state: PreChoiceMeasurement;
  contradiction: boolean;
  truncated: boolean;
  records: ConsentMeasurementRecord[];
}

export interface ConsentMeasurementSummary extends ConsentMeasurementCounts {
  state: PreChoiceMeasurement;
  contradiction: boolean;
  truncated: boolean;
  sources: ConsentMeasurementSource[];
}

/** A bounded Consent-owned buffer; keep examples of both positive classes even
 * when a busy context fills the buffer. Counts distinguish capture from retained
 * classification. No dropped request is evidence of absence. */
export class ConsentRequestBuffer {
  readonly requests: TrackingRequestEvidence[] = [];
  observed = 0;
  truncated = false;
  append(request: TrackingRequestEvidence) {
    this.observed += 1;
    if (this.requests.length < 100) { this.requests.push(request); return; }
    this.truncated = true;
    const key = (item: TrackingRequestEvidence) => `${item.phase}:${item.kind}:${item.consent_measurement || 'unknown'}`;
    if (this.requests.some((item) => key(item) === key(request))) return;
    const replace = this.requests.findIndex((item, index) => this.requests.some((other, otherIndex) => otherIndex !== index && key(item) === key(other)));
    if (replace >= 0) this.requests[replace] = request;
  }
}

function stateFromFacts(full: boolean, limited: boolean, uncertain: boolean): PreChoiceMeasurement {
  return full && limited ? 'unknown' : full ? 'full_measurement' : limited ? 'limited_measurement' : uncertain ? 'unknown' : false;
}

/** Normalize retained request evidence once. Shared phases are an allowlist;
 * the fresh window is bounded by its own choice timestamp, never a shared one. */
export function normalizeConsentMeasurement(
  requests: readonly TrackingRequestEvidence[], context: MeasurementContext, userChoiceAt: number | null,
  gcm?: GoogleConsentModeResult, truncated = false, observed?: number
): ConsentMeasurementSource {
  const scoped = context === 'shared' ? requests.filter((request) => isSharedPreChoicePhase(request.phase)) : [...requests];
  const input: TrackingConsistencyInput = { requests: scoped, user_choice_at: userChoiceAt, rejection_verification: { status: 'inconclusive', evidence: [], reason_codes: [] }, post_reject_observation_completed: false };
  const records = scoped.map((request): ConsentMeasurementRecord => {
    const signal = classifyTrackingConsistencyRequest(request, input);
    const timing = timingFor(request, input);
    const facts = request.kind !== 'collection' ? [] : request.vendor === 'ga4'
      ? googleMeasurementFacts(request, context === 'fresh' ? gcm : undefined)
      : googleMeasurementFacts(request);
    const classification = request.kind !== 'collection' ? false : stateFromFacts(
      facts.some((fact) => fact.classification === 'full_measurement'),
      facts.some((fact) => fact.classification === 'limited_measurement'), true);
    return { context, phase: request.phase, timestamp: request.timestamp, timing, evidence_type: request.kind, signal_kind: signal?.kind || null, classification, facts };
  });
  const pre = records.filter((record) => record.timing === 'pre_choice');
  const full = pre.filter((record) => record.facts.some((fact) => fact.classification === 'full_measurement')).length;
  const limited = pre.filter((record) => record.facts.some((fact) => fact.classification === 'limited_measurement')).length;
  const unknown = pre.filter((record) => record.classification === 'unknown').length;
  return {
    context, state: stateFromFacts(full > 0, limited > 0, unknown > 0 || truncated || records.some((record) => record.timing === 'unknown')),
    contradiction: full > 0 && limited > 0, truncated, records,
    tracking_requests_observed: observed ?? scoped.length, tracking_requests_retained: scoped.length,
    tracking_signals_classified: records.filter((record) => record.signal_kind !== null).length,
    pre_choice_event_hits: pre.filter((record) => record.signal_kind === 'event_hit').length,
    pre_choice_conversion_hits: pre.filter((record) => record.signal_kind === 'conversion_hit').length,
    pre_choice_script_loads: pre.filter((record) => record.signal_kind === 'script_load').length,
    limited_measurement_count: limited, full_measurement_count: full, unknown_measurement_count: unknown,
    gcm_network_observations: gcm?.network.length || 0, gcm_commands: gcm?.commands.length || 0
  };
}

/** Positive facts are retained by source. Cross-context disagreement or an
 * unclassifiable collection window yields unknown, never a numeric promotion. */
export function reconcileConsentMeasurement(sources: ConsentMeasurementSource[]): ConsentMeasurementSummary {
  const counts: ConsentMeasurementCounts = {
    tracking_requests_observed: 0, tracking_requests_retained: 0, tracking_signals_classified: 0,
    pre_choice_event_hits: 0, pre_choice_conversion_hits: 0, pre_choice_script_loads: 0,
    limited_measurement_count: 0, full_measurement_count: 0, unknown_measurement_count: 0,
    gcm_network_observations: 0, gcm_commands: 0
  };
  for (const source of sources) for (const key of Object.keys(counts) as Array<keyof ConsentMeasurementCounts>) counts[key] += source[key];
  const states = new Set(sources.map((source) => source.state).filter((state) => state !== false));
  const contradiction = counts.full_measurement_count > 0 && counts.limited_measurement_count > 0;
  return { ...counts, state: states.size > 1 || contradiction ? 'unknown' : states.values().next().value || false,
    contradiction, truncated: sources.some((source) => source.truncated), sources };
}
