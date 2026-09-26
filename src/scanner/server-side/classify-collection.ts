import type { CollectionType, ServerMeasurementCandidate, ServerSideStatus, TrackingRequestEvidence } from '../../types';
import { STRICT_DUPLICATE_WINDOW_MS } from '../version';
import { isFirstPartyRelationship } from './collector-relationship';

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
  if (!(a.collector === 'third_party' && isFirstPartyRelationship(b.collector)) &&
      !(b.collector === 'third_party' && isFirstPartyRelationship(a.collector))) return false;
  if (Math.abs(a.timestamp - b.timestamp) > STRICT_DUPLICATE_WINDOW_MS) return false;
  const aPage = normalizedPage(a.page_url);
  const bPage = normalizedPage(b.page_url);
  if (!aPage || !bPage || aPage !== bPage) return false;
  if (a.correlation?.ga4_client && b.correlation?.ga4_client && a.correlation.ga4_client !== b.correlation.ga4_client) return false;
  if (a.correlation?.ga4_session && b.correlation?.ga4_session && a.correlation.ga4_session !== b.correlation.ga4_session) return false;
  if (a.correlation?.meta_browser && b.correlation?.meta_browser && a.correlation.meta_browser !== b.correlation.meta_browser) return false;
  if (a.correlation?.meta_click && b.correlation?.meta_click && a.correlation.meta_click !== b.correlation.meta_click) return false;
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
  measurement_candidates?: ServerMeasurementCandidate[];
  candidate_truncated?: boolean;
  collector_cookie_detected?: boolean;
  collector_cookie_persisted?: boolean;
  /** Absence requires an explicitly completed passive request observation. */
  observation_complete?: boolean;
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
  const knownFirstParty = collection.filter((request) => request.collector === 'first_party');
  const knownSameOrigin = collection.filter((request) => request.collector === 'same_origin');
  const knownThirdParty = collection.filter((request) => request.collector === 'third_party');
  const knownUnclassifiable = collection.filter((request) => request.collector === 'unclassifiable');
  // Repeated medium summaries corroborate only within one origin/path family,
  // with overlapping behavioral dimensions. One family is one collection hit.
  const candidates = input.measurement_candidates || [];
  const promoted = candidates.filter((candidate) => candidate.strength === 'strong');
  const mediumByEndpoint = new Map<string, ServerMeasurementCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.strength !== 'medium') continue;
    const key = `${candidate.origin}|${candidate.path}|${candidate.relationship}`;
    const family = mediumByEndpoint.get(key) || [];
    family.push(candidate);
    mediumByEndpoint.set(key, family);
  }
  let ambiguousMedium = false;
  for (const family of mediumByEndpoint.values()) {
    const first = family[0];
    const corroborated = family.length >= 2 && family.slice(1).some((next) =>
      first.semantic_groups.includes('event') && next.semantic_groups.includes('event') &&
      first.semantic_groups.filter((group) => next.semantic_groups.includes(group)).length >= 2);
    if (corroborated) promoted.push(first);
    else ambiguousMedium = true;
  }
  const firstParty = knownFirstParty.length + promoted.filter((candidate) => candidate.relationship === 'first_party').length;
  const sameOrigin = knownSameOrigin.length + promoted.filter((candidate) => candidate.relationship === 'same_origin').length;
  const thirdParty = knownThirdParty.length + promoted.filter((candidate) => candidate.relationship === 'third_party').length;
  const unclassifiable = knownUnclassifiable.length + promoted.filter((candidate) => candidate.relationship === 'unclassifiable').length;
  const firstPartyTotal = firstParty + sameOrigin;
  const knownFirstPartyTotal = knownFirstParty.length + knownSameOrigin.length;
  const duplicatePairs = knownFirstPartyTotal > 0 ? findStrictDuplicates(collection) : [];

  if (firstPartyTotal === 0 && input.observation_complete !== true) {
    return {
      collection_type: 'inconclusive', status: 'inconclusive',
      first_party_collection_count: 0, same_origin_collection_count: 0, third_party_collection_count: thirdParty,
      strict_duplicate_count: 0, duplicate_pairs: [], reason_code: 'SERVER_OBSERVATION_INCOMPLETE'
    };
  }

  if (firstPartyTotal === 0) {
    if (unclassifiable > 0 || ambiguousMedium || input.candidate_truncated) {
      return {
        collection_type: 'inconclusive', status: 'inconclusive',
        first_party_collection_count: 0, same_origin_collection_count: 0, third_party_collection_count: thirdParty,
        strict_duplicate_count: 0, duplicate_pairs: [],
        reason_code: unclassifiable > 0 ? 'SERVER_COLLECTOR_RELATIONSHIP_UNCLASSIFIABLE'
          : ambiguousMedium ? 'SERVER_MEASUREMENT_CANDIDATE_AMBIGUOUS' : 'SERVER_MEASUREMENT_CANDIDATES_TRUNCATED'
      };
    }
    return {
      collection_type: thirdParty > 0 ? 'third_party' : 'not_detected',
      status: 'not_detected',
      first_party_collection_count: 0,
      same_origin_collection_count: 0,
      third_party_collection_count: thirdParty,
      strict_duplicate_count: 0,
      duplicate_pairs: [],
      reason_code: thirdParty > 0 ? 'SERVER_THIRD_PARTY_ONLY' : 'SERVER_NOT_DETECTED'
    };
  }

  const collectionType: CollectionType = thirdParty > 0
    ? 'mixed'
    : sameOrigin > 0 && firstParty === 0 ? 'same_origin' : 'first_party';
  let status: ServerSideStatus = 'first_party_collection_detected';
  let reasonCode = collectionType === 'mixed' ? 'SERVER_MIXED_NO_DUPLICATE' : 'SERVER_FP_COLLECTOR';
  if (knownFirstPartyTotal === 0) {
    reasonCode = 'SERVER_GENERIC_MEASUREMENT_CANDIDATE';
  } else if (duplicatePairs.length > 0) {
    status = 'partial_or_misconfigured';
    reasonCode = 'SERVER_STRICT_DUPLICATE';
  } else if (input.collector_cookie_persisted) {
    status = 'strong_server_side_evidence';
    reasonCode = 'SERVER_FP_COOKIE_PERSISTED';
  } else if (input.collector_cookie_detected || knownFirstPartyTotal >= 2) {
    status = 'likely_server_side';
    reasonCode = 'SERVER_FP_COLLECTOR';
  }

  return {
    collection_type: collectionType,
    status,
    first_party_collection_count: firstParty,
    same_origin_collection_count: sameOrigin,
    third_party_collection_count: thirdParty,
    strict_duplicate_count: duplicatePairs.length,
    duplicate_pairs: duplicatePairs,
    reason_code: reasonCode
  };
}
