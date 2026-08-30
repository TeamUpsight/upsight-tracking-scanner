import type { TrackingRequestEvidence } from '../../types';

const META_COLLECTION_HOSTS = new Set(['facebook.com', 'www.facebook.com']);

export interface ParsedMetaRequest {
  vendor: 'meta';
  kind: 'script' | 'collection';
  endpoint_type: 'meta' | 'first_party';
  event: string;
  pixel_id: string;
  page_url: string;
  fbp: string;
  fbc: string;
}

function mergedParams(url: URL, body: string) {
  const result = new URLSearchParams(url.searchParams);
  if (body) {
    const bodyParams = new URLSearchParams(body);
    for (const [key, value] of bodyParams) result.set(key, value);
  }
  return result;
}

export function parseMetaPixelIdsFromText(text: string) {
  const ids = new Set<string>();
  const normalized = text
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/\\"/g, '"');
  const patterns = [
    /\bfbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,25})['"]/gi,
    /connect\.facebook\.net\/signals\/config\/(\d{6,25})/gi,
    /facebook\.com\/tr\/?[^'"\s>]*[?&]id=(\d{6,25})/gi,
    /"pixel_id"\s*:\s*"(\d{6,25})"[^{}]{0,300}"pixel_type"\s*:\s*"facebook_pixel"/gi,
    /"pixel_type"\s*:\s*"facebook_pixel"[^{}]{0,300}"pixel_id"\s*:\s*"(\d{6,25})"/gi
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      ids.add(match[1]);
      if (ids.size >= 20) return [...ids];
    }
  }
  return [...ids];
}

export function hasMetaBootstrapInText(text: string) {
  return /connect\.facebook\.net\/[a-z_-]+\/fbevents\.js/i.test(text) ||
    /\bfbq\s*\(\s*['"](?:init|track|trackcustom)['"]/i.test(text) ||
    /facebook\.com\/tr\/?[^'"\s>]*[?&]id=\d{6,25}/i.test(text) ||
    parseMetaPixelIdsFromText(text).length > 0;
}

export function parseMetaRequest(url: string, body = ''): ParsedMetaRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (host === 'connect.facebook.net' || host.endsWith('.connect.facebook.net')) {
    const configMatch = path.match(/^\/signals\/config\/(\d+)(?:\/|$)/);
    if (!path.endsWith('.js') && !configMatch) return null;
    return {
      vendor: 'meta', kind: 'script', endpoint_type: 'meta', event: '',
      pixel_id: configMatch?.[1] || '', page_url: '', fbp: '', fbc: ''
    };
  }

  const params = mergedParams(parsed, body);
  const event = params.get('ev') || params.get('event') || '';
  const pixelId = params.get('id') || '';
  const knownHost = META_COLLECTION_HOSTS.has(host) || host.endsWith('.facebook.com');
  const strictPath = path === '/tr' || path.startsWith('/tr/');
  if (!(strictPath && event && pixelId)) return null;

  return {
    vendor: 'meta',
    kind: 'collection',
    endpoint_type: knownHost ? 'meta' : 'first_party',
    event,
    pixel_id: pixelId,
    page_url: params.get('dl') || '',
    fbp: params.get('fbp') || '',
    fbc: params.get('fbc') || ''
  };
}

export function toMetaEvidence(parsed: ParsedMetaRequest, input: {
  host: string;
  path: string;
  method: string;
  phase: string;
  timestamp: number;
  collector: TrackingRequestEvidence['collector'];
}): TrackingRequestEvidence {
  return {
    vendor: 'meta',
    kind: parsed.kind,
    collector: input.collector,
    host: input.host,
    path: input.path,
    method: input.method,
    phase: input.phase,
    timestamp: input.timestamp,
    event: parsed.event || undefined,
    pixel_id: parsed.pixel_id || undefined,
    page_url: parsed.page_url || undefined,
    fbp: parsed.fbp || undefined,
    fbc: parsed.fbc || undefined
  };
}
