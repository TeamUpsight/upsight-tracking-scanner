import { parseGA4Request } from './scanner/tracking/ga4';

export {
  activeScansRegistry,
  isNonStorefrontUrl,
  isSafeCanonicalRedirect,
  normalizeAuditDomain,
  normalizeDomain,
  runStorefrontAudit
} from './scanner/audit-runner';

export {
  buildBrowserlessCdpUrl,
  buildRotatingFallbackProxy,
  getExternalProxyForGeo,
  hydrateProxyHealth,
  getProxyMetricsReport,
  getProxyPortsForGeo,
  isValidProxy,
  parseProxyUrl,
  proxyMetrics,
  reserveProxyPortOffset,
  rotateDecodoSessionUsername,
  setProxyPort,
  summarizeCdpUrlForTrace,
  validateProxyConfiguration
} from './scanner/proxy/decodo';

export interface GA4ParsedHit {
  measurement_id: string;
  event: string;
  page_url: string;
  has_product: boolean;
  payload_source: string | null;
  product_id?: string;
  product_name?: string;
  brand?: string;
  category?: string;
  value?: number;
}

/** Backward-compatible public name backed by the single V2 GA4 parser. */
export function parseGA4EcommerceHit(url: string, body = ''): GA4ParsedHit | null {
  const parsed = parseGA4Request(url, body);
  if (!parsed || parsed.kind !== 'collection') return null;
  return {
    measurement_id: parsed.measurement_id,
    event: parsed.event,
    page_url: parsed.page_url,
    has_product: parsed.has_product,
    payload_source: parsed.payload_source,
    product_id: parsed.product_id,
    product_name: parsed.product_name,
    brand: parsed.brand,
    category: parsed.category,
    value: parsed.value
  };
}
