import type { ServerMeasurementCandidate } from '../../types';
import type { CollectorRelationship } from './collector-relationship';

type Group = 'event' | 'identity' | 'page' | 'commerce' | 'schema';

const FIELDS: Record<Group, readonly string[]> = {
  event: ['event', 'eventname', 'action', 'eventtype'],
  identity: ['clientid', 'sessionid', 'anonymousid', 'deviceid', 'visitorid'],
  page: ['pageurl', 'pagelocation', 'referrer', 'pagereferrer', 'pagetitle', 'pagecontext'],
  commerce: ['currency', 'items', 'products', 'productid', 'itemid', 'transactionid', 'orderid', 'revenue', 'campaign', 'source', 'medium', 'value'],
  schema: ['events', 'properties', 'traits', 'context', 'protocolversion', 'measurementversion']
};
const FIELD_GROUP = new Map<string, Group>(Object.entries(FIELDS).flatMap(([group, names]) => names.map((name) => [name, group as Group])));
const FUNCTIONAL_PATH = /(?:^|\/)(?:cart|checkout|inventory|products?|catalog|search|autocomplete|login|auth|token|accounts?|profiles?|shipping|tax|stores?|locator|recommendations?|reviews?|wishlist|graphql)(?:\/|$)/i;
const TECHNICAL_PATH = /(?:^|\/)(?:sentry|envelope|traces?|spans?|logs?|errors?|exceptions?|health(?:y)?|readiness|ready|heartbeat|ping|metrics)(?:\/|$)/i;
const TECHNICAL_HOST = /(?:^|\.)(?:sentry\.io|datadoghq\.(?:com|eu)|newrelic\.com|nr-data\.net|honeycomb\.io)$|(?:^|\.)browser-intake-datadoghq\.com$/i;
const TECHNICAL_FIELDS = new Set(['exception', 'stack', 'stacktrace', 'traceid', 'spanid', 'loglevel', 'logger', 'errormessage', 'heartbeat']);
const FUNCTIONAL_FIELDS = new Set(['operationname', 'variables', 'quantity', 'variantid', 'shippingmethod', 'addressid', 'password', 'accesstoken']);
const normalizeKey = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

function safePath(path: string): string {
  return (path || '/').split('/').slice(0, 12).map((part) =>
    /%|@|^[a-f0-9-]{16,}$/i.test(part) || part.length > 32 ||
      ((/\d|_/.test(part)) && !/^v\d{1,2}$/i.test(part)) ? ':id' : part.replace(/[^a-z0-9._~-]/gi, '')
  ).join('/').slice(0, 160) || '/';
}

/** Reads bounded structure only. Neither raw values nor arbitrary field names leave this function. */
export function detectGenericMeasurementCandidate(input: {
  url: string;
  body?: string;
  method?: string;
  relationship: CollectorRelationship;
  phase: string;
  timestamp: number;
  observed_page_id?: string;
  navigation_epoch?: number;
}): ServerMeasurementCandidate | null {
  let url: URL;
  try { url = new URL(input.url); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const path = safePath(url.pathname);
  if (FUNCTIONAL_PATH.test(path) || TECHNICAL_PATH.test(path) || TECHNICAL_HOST.test(url.hostname)) return null;
  const keys = new Set<string>();
  const add = (key: string) => { if (keys.size < 64) keys.add(normalizeKey(key)); };
  let consumed = 0;
  for (const [key] of new URLSearchParams(url.search.slice(0, 16_384))) { add(key); if (++consumed >= 64) break; }
  const body = (input.body || '').slice(0, 16_384);
  if (body.trimStart().startsWith('{') || body.trimStart().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(body);
      const visit = (value: unknown, depth: number) => {
        if (depth > 3 || keys.size >= 64 || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          for (const item of value.slice(0, 3)) visit(item, depth + 1);
        } else {
          for (const [key, item] of Object.entries(value).slice(0, 64)) {
            add(key);
            visit(item, depth + 1);
          }
        }
      };
      visit(parsed, 0);
    } catch { return null; }
  } else if (body) {
    consumed = 0;
    for (const [key] of new URLSearchParams(body)) { add(key); if (++consumed >= 64) break; }
  }
  if ([...keys].some((key) => TECHNICAL_FIELDS.has(key))) return null;
  if ([...keys].some((key) => FUNCTIONAL_FIELDS.has(key))) return null;
  // Generic `type` and `name` are intentionally excluded without an explicit event key.
  const matched = [...keys].filter((key) => FIELD_GROUP.has(key));
  const groups = [...new Set(matched.map((key) => FIELD_GROUP.get(key)!))];
  if (!groups.includes('event')) return null;
  const strength = matched.length >= 4 && groups.length >= 3 ? 'strong'
    : matched.length >= 3 && groups.length >= 2 ? 'medium' : null;
  if (!strength) return null;
  return {
    host: url.hostname.toLowerCase(), path, origin: url.origin,
    method: (input.method || 'GET').toUpperCase().slice(0, 8), relationship: input.relationship,
    strength, provider_hint: 'unknown', semantic_groups: groups.sort(),
    evidence_codes: groups.map((group) => `MEASUREMENT_${group.toUpperCase()}`).sort(),
    phase: input.phase.slice(0, 64), timestamp: input.timestamp,
    observed_page_id: /^page_\d{1,9}$/.test(input.observed_page_id || '') ? input.observed_page_id : undefined,
    navigation_epoch: Number.isSafeInteger(input.navigation_epoch) && input.navigation_epoch! >= 1 ? input.navigation_epoch : undefined
  };
}
