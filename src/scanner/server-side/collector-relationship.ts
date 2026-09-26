import { getDomain } from 'tldts';

export type CollectorRelationship = 'same_origin' | 'first_party' | 'third_party' | 'unclassifiable';

/** The observed page URL and physical request URL are the only origin inputs. */
export function classifyCollectorRelationship(requestUrl: string, observedPageUrl?: string | null): CollectorRelationship {
  if (!observedPageUrl) return 'unclassifiable';
  try {
    const request = new URL(requestUrl);
    const page = new URL(observedPageUrl);
    if (!['http:', 'https:'].includes(request.protocol) || !['http:', 'https:'].includes(page.protocol)) return 'unclassifiable';
    // URL canonicalizes casing, IDNs, and default ports. Do not remove www.
    if (request.protocol === page.protocol && request.hostname === page.hostname && request.port === page.port) {
      return 'same_origin';
    }
    const requestDomain = getDomain(request.hostname, { allowPrivateDomains: true });
    const pageDomain = getDomain(page.hostname, { allowPrivateDomains: true });
    if (!requestDomain || !pageDomain) return 'unclassifiable';
    return requestDomain === pageDomain ? 'first_party' : 'third_party';
  } catch {
    return 'unclassifiable';
  }
}

export function isFirstPartyRelationship(value: CollectorRelationship): boolean {
  return value === 'same_origin' || value === 'first_party';
}
