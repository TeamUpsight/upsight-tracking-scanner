import type { CollectionType, ServerSideStatus, TrackingRequestEvidence } from '../../types';
import { STRICT_DUPLICATE_WINDOW_MS } from '../version';

export interface ServerSideClassification {
  collection_type: CollectionType;
  status: ServerSideStatus;
  first_party_collection_count: number;
  same_origin_collection_count: number;
  third_party_collection_count: number;
  strict_duplicate_count: number;
  duplicate_pairs: Array<{ vendor: string; event: string; id: string; delta_ms: number }>;
  reason_code: string;
}

function normalizedPage(value?: string) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return value.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

function eventId(event: TrackingRequestEvidence) {
  return event.vendor === 'ga4' ? event.measurement_id || '' : event.pixel_id || '';
}

function strictMatch(a: TrackingRequestEvidence, b: TrackingRequestEvidence) {
  if (a.kind !== 'collection' || b.kind !== 'collection') return false;
  if (a.vendor !== b.vendor || !a.event || a.event !== b.event) return false;
  const aId = eventId(a);
  const bId = eventId(b);
  if (!aId || aId !== bId) return false;
  if ((a.collector === 'third_party') === (b.collector === 'third_party')) return false;
  if (Math.abs(a.timestamp - b.timestamp) > STRICT_DUPLICATE_WINDOW_MS) return false;
  const aPage = normalizedPage(a.page_url);
  const bPage = normalizedPage(b.page_url);
  if (!aPage || !bPage || aPage !== bPage) return false;
  if (a.client_id && b.client_id && a.client_id !== b.client_id) return false;
  if (a.session_id && b.session_id && a.session_id !== b.session_id) return false;
  if (a.fbp && b.fbp && a.fbp !== b.fbp) return false;
  if (a.fbc && b.fbc && a.fbc !== b.fbc) return false;
  return true;
}

export function findStrictDuplicates(events: TrackingRequestEvidence[]) {
  const collection = events.filter((event) => event.kind === 'collection');
  const pairs: ServerSideClassification['duplicate_pairs'] = [];
  const seen = new Set<string>();
  for (let i = 0; i < collection.length; i += 1) {
    for (let j = i + 1; j < collection.length; j += 1) {
      const a = collection[i];
      const b = collection[j];
      if (!strictMatch(a, b)) continue;
      const key = [a.vendor, a.event, eventId(a), normalizedPage(a.page_url), Math.min(a.timestamp, b.timestamp)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ vendor: a.vendor, event: a.event || '', id: eventId(a), delta_ms: Math.abs(a.timestamp - b.timestamp) });
    }
  }
  return pairs;
}

export function classifyCollection(input: {
  executed: boolean;
  page_valid: boolean | null;
  requests: TrackingRequestEvidence[];
  collector_cookie_detected?: boolean;
  collector_cookie_persisted?: boolean;
}): ServerSideClassification {
  if (!input.executed) {
    return {
      collection_type: 'not_tested', status: 'not_tested',
      first_party_collection_count: 0, same_origin_collection_count: 0, third_party_collection_count: 0,
      strict_duplicate_count: 0, duplicate_pairs: [], reason_code: 'SERVER_NOT_TESTED'
    };
  }
  if (input.page_valid !== true) {
    return {
      collection_type: 'inconclusive', status: 'inconclusive',
      first_party_collection_count: 0, same_origin_collection_count: 0, third_party_collection_count: 0,
      strict_duplicate_count: 0, duplicate_pairs: [], reason_code: 'ACCESS_BLOCKED'
    };
  }

  const collection = input.requests.filter((request) => request.kind === 'collection' && (request.vendor === 'ga4' || request.vendor === 'meta'));
  const firstParty = collection.filter((request) => request.collector === 'first_party');
  const sameOrigin = collection.filter((request) => request.collector === 'same_origin');
  const thirdParty = collection.filter((request) => request.collector === 'third_party');
  const firstPartyTotal = firstParty.length + sameOrigin.length;
  const duplicatePairs = firstPartyTotal > 0 ? findStrictDuplicates(collection) : [];

  if (firstPartyTotal === 0) {
    return {
      collection_type: thirdParty.length > 0 ? 'third_party' : 'not_detected',
      status: 'not_detected',
      first_party_collection_count: 0,
      same_origin_collection_count: 0,
      third_party_collection_count: thirdParty.length,
      strict_duplicate_count: 0,
      duplicate_pairs: [],
      reason_code: thirdParty.length > 0 ? 'SERVER_THIRD_PARTY_ONLY' : 'SERVER_NOT_DETECTED'
    };
  }

  const collectionType: CollectionType = thirdParty.length > 0
    ? 'mixed'
    : sameOrigin.length > 0 && firstParty.length === 0 ? 'same_origin' : 'first_party';
  let status: ServerSideStatus = 'first_party_collection_detected';
  let reasonCode = collectionType === 'mixed' ? 'SERVER_MIXED_NO_DUPLICATE' : 'SERVER_FP_COLLECTOR';
  if (duplicatePairs.length > 0) {
    status = 'partial_or_misconfigured';
    reasonCode = 'SERVER_STRICT_DUPLICATE';
  } else if (input.collector_cookie_persisted) {
    status = 'strong_server_side_evidence';
    reasonCode = 'SERVER_FP_COOKIE_PERSISTED';
  } else if (input.collector_cookie_detected || firstPartyTotal >= 2) {
    status = 'likely_server_side';
    reasonCode = 'SERVER_FP_COLLECTOR';
  }

  return {
    collection_type: collectionType,
    status,
    first_party_collection_count: firstParty.length,
    same_origin_collection_count: sameOrigin.length,
    third_party_collection_count: thirdParty.length,
    strict_duplicate_count: duplicatePairs.length,
    duplicate_pairs: duplicatePairs,
    reason_code: reasonCode
  };
}
