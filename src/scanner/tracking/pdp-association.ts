import type { EvidenceBundle, TrackingRequestEvidence } from '../../types';
import { safeObservedPageUrl } from './page-provenance';

export type PdpObservation = Pick<NonNullable<EvidenceBundle['product']['candidate_outcomes']>[number],
  'url' | 'final_url' | 'observed_page_id' | 'navigation_epoch' | 'observed_page_url'>;

function matchesFinalUrl(raw: string, candidate: PdpObservation): boolean {
  const expected = safeObservedPageUrl(candidate.final_url || candidate.url);
  const actual = safeObservedPageUrl(raw);
  if (!expected || !actual) return false;
  const a = new URL(actual);
  const b = new URL(expected);
  return a.hostname.toLowerCase().replace(/^www\./, '') === b.hostname.toLowerCase().replace(/^www\./, '') &&
    a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
}

/** Browser page/epoch is primary; explicit vendor URL is the safe identity fallback. */
export function isRequestForPdp(request: TrackingRequestEvidence, candidate: PdpObservation): boolean {
  const hasRequestIdentity = /^page_\d{1,9}$/.test(request.observed_page_id || '') &&
    Number.isSafeInteger(request.navigation_epoch) && request.navigation_epoch! > 0;
  const hasCandidateIdentity = /^page_\d{1,9}$/.test(candidate.observed_page_id || '') &&
    Number.isSafeInteger(candidate.navigation_epoch) && candidate.navigation_epoch! > 0;
  if (request.page_url && !matchesFinalUrl(request.page_url, candidate)) return false;
  if (request.observed_page_url && !matchesFinalUrl(request.observed_page_url, candidate)) return false;
  if (hasRequestIdentity && hasCandidateIdentity) {
    return request.observed_page_id === candidate.observed_page_id &&
      request.navigation_epoch === candidate.navigation_epoch;
  }
  if (request.observed_page_id || request.navigation_epoch !== undefined) return false;
  return Boolean(request.page_url && matchesFinalUrl(request.page_url, candidate));
}
