import type { TrackingRequestEvidence } from '../../types';

const GA4_HOSTS = new Set([
  'analytics.google.com',
  'www.google-analytics.com',
  'google-analytics.com',
  'region1.google-analytics.com',
  'stats.g.doubleclick.net'
]);

const MEASUREMENT_ID = /^G-[A-Z0-9]+$/i;

export interface ParsedGA4Request {
  vendor: 'ga4';
  kind: 'script' | 'collection';
  endpoint_type: 'google' | 'first_party';
  measurement_id: string;
  event: string;
  page_url: string;
  page_title: string;
  client_id: string;
  session_id: string;
  has_product: boolean;
  payload_source: string | null;
  product_id?: string;
  product_name?: string;
  brand?: string;
  category?: string;
  value?: number;
}

export interface ParsedGA4DataLayerEvent {
  vendor: 'ga4';
  kind: 'data_layer';
  event: 'view_item';
  measurement_id: string;
  has_product: boolean;
  payload_source: 'data_layer_items';
  product_id?: string;
  product_name?: string;
  brand?: string;
  category?: string;
  value?: number;
}

function parseBody(body: string): URLSearchParams[] {
  if (!body) return [new URLSearchParams()];
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.length ? lines : [body]).map((line) => new URLSearchParams(line.replace(/^\?/, '')));
}

function valueFrom(urlParams: URLSearchParams, bodyParams: URLSearchParams, key: string): string {
  return bodyParams.get(key) || urlParams.get(key) || '';
}

function parseNumber(raw: string): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseCompactProduct(raw: string) {
  const result: Pick<ParsedGA4Request, 'product_id' | 'product_name' | 'brand' | 'category' | 'value'> = {};
  for (const part of raw.split('~')) {
    const prefix = part.slice(0, 2);
    const value = part.slice(2);
    if (!value) continue;
    if (prefix === 'id') result.product_id = value;
    if (prefix === 'nm') result.product_name = value;
    if (prefix === 'br') result.brand = value;
    if (prefix === 'ca') result.category = value;
    if (prefix === 'pr') result.value = parseNumber(value);
  }
  return result;
}

function parseItemsJson(raw: string) {
  try {
    const parsed = JSON.parse(raw);
    const item = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!item || typeof item !== 'object') return {};
    return {
      product_id: item.item_id || item.id,
      product_name: item.item_name || item.name,
      brand: item.item_brand || item.brand,
      category: item.item_category || item.category,
      value: parseNumber(String(item.price ?? item.value ?? ''))
    };
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function dataLayerCommand(entry: unknown) {
  const value = objectValue(entry);
  if (!value) return null;
  const command = Array.isArray(entry) ? entry : [value['0'], value['1'], value['2']];
  if (String(command[0] || '').toLowerCase() === 'event') {
    return { event: String(command[1] || '').toLowerCase(), payload: objectValue(command[2]) };
  }
  const ecommerce = objectValue(value.ecommerce);
  return { event: String(value.event || '').toLowerCase(), payload: ecommerce || value };
}

function measurementIdFromSendTo(value: unknown) {
  const candidates = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return candidates.map((candidate) => String(candidate).trim()).find((candidate) => MEASUREMENT_ID.test(candidate)) || '';
}

/**
 * Parses both gtag Arguments-style entries (`{0:'event',1:'view_item',2:{...}}`)
 * and ordinary GTM object pushes. Only bounded product facts are returned; user
 * identifiers and unrelated dataLayer values never enter persisted evidence.
 */
export function parseGA4DataLayerEntry(entry: unknown): ParsedGA4DataLayerEvent | null {
  const command = dataLayerCommand(entry);
  if (!command || command.event !== 'view_item' || !command.payload) return null;
  const nestedEcommerce = objectValue(command.payload.ecommerce);
  const payload = nestedEcommerce || command.payload;
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) return null;
  const item = objectValue(items[0]);
  if (!item) return null;
  const productId = String(item.item_id ?? item.id ?? '').trim() || undefined;
  const productName = String(item.item_name ?? item.name ?? '').trim() || undefined;
  const brand = String(item.item_brand ?? item.brand ?? '').trim() || undefined;
  const category = String(item.item_category ?? item.category ?? '').trim() || undefined;
  const value = parseNumber(String(item.price ?? item.value ?? payload.value ?? ''));
  return {
    vendor: 'ga4',
    kind: 'data_layer',
    event: 'view_item',
    measurement_id: measurementIdFromSendTo(payload.send_to ?? command.payload.send_to),
    has_product: Boolean(productId || productName),
    payload_source: 'data_layer_items',
    product_id: productId,
    product_name: productName,
    brand,
    category,
    value
  };
}

function isGtagScript(parsed: URL): boolean {
  return parsed.hostname.toLowerCase().endsWith('googletagmanager.com') &&
    parsed.pathname.includes('/gtag/js') && MEASUREMENT_ID.test(parsed.searchParams.get('id') || '');
}

function isCollectionEndpoint(parsed: URL, params: URLSearchParams): boolean {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  const tid = params.get('tid') || parsed.searchParams.get('tid') || '';
  const event = params.get('en') || parsed.searchParams.get('en') || '';
  const version = params.get('v') || parsed.searchParams.get('v') || '';
  const knownHost = GA4_HOSTS.has(host) || host.endsWith('.google-analytics.com');

  if (knownHost && path.endsWith('/g/collect')) return Boolean(event || MEASUREMENT_ID.test(tid));
  if (knownHost && path.endsWith('/collect')) return version === '2' && MEASUREMENT_ID.test(tid) && Boolean(event);
  return path.endsWith('/g/collect') && MEASUREMENT_ID.test(tid) && Boolean(event);
}

export function parseGA4Request(url: string, body = ''): ParsedGA4Request | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (isGtagScript(parsed)) {
    return {
      vendor: 'ga4',
      kind: 'script',
      endpoint_type: 'google',
      measurement_id: parsed.searchParams.get('id') || '',
      event: '',
      page_url: '',
      page_title: '',
      client_id: '',
      session_id: '',
      has_product: false,
      payload_source: null
    };
  }

  const urlParams = parsed.searchParams;
  const bodies = parseBody(body);
  const bodyParams = bodies.find((candidate) => isCollectionEndpoint(parsed, candidate)) || bodies[0];
  if (!isCollectionEndpoint(parsed, bodyParams)) return null;

  const measurementId = valueFrom(urlParams, bodyParams, 'tid');
  const event = valueFrom(urlParams, bodyParams, 'en') || valueFrom(urlParams, bodyParams, 'event_name');
  let payloadSource: string | null = null;
  let product: ReturnType<typeof parseCompactProduct> = {};

  for (const [key, raw] of [...urlParams.entries(), ...bodyParams.entries()]) {
    if (/^pr\d+$/i.test(key) && raw) {
      product = parseCompactProduct(raw);
      payloadSource = `ga4_query_params_${key.toLowerCase()}`;
      break;
    }
  }

  const productId = valueFrom(urlParams, bodyParams, 'ep.ecomm_prodid') || valueFrom(urlParams, bodyParams, 'ecomm_prodid');
  const pageType = (valueFrom(urlParams, bodyParams, 'ep.ecomm_pagetype') || valueFrom(urlParams, bodyParams, 'ecomm_pagetype')).toLowerCase();
  const totalValue = valueFrom(urlParams, bodyParams, 'epn.ecomm_totalvalue') ||
    valueFrom(urlParams, bodyParams, 'ep.ecomm_totalvalue') || valueFrom(urlParams, bodyParams, 'ecomm_totalvalue');
  if (productId || pageType === 'product') {
    product.product_id ||= productId || undefined;
    product.value ??= parseNumber(totalValue);
    payloadSource ||= 'ga4_query_params_ecomm';
  }

  const items = valueFrom(urlParams, bodyParams, 'ep.items') || valueFrom(urlParams, bodyParams, 'items');
  if (items) {
    product = { ...parseItemsJson(items), ...product };
    payloadSource ||= 'ga4_query_params_items';
  }

  const hasProduct = Boolean(payloadSource && (product.product_id || product.product_name || pageType === 'product' || items));
  return {
    vendor: 'ga4',
    kind: 'collection',
    endpoint_type: GA4_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase().endsWith('.google-analytics.com') ? 'google' : 'first_party',
    measurement_id: measurementId,
    event,
    page_url: valueFrom(urlParams, bodyParams, 'dl'),
    page_title: valueFrom(urlParams, bodyParams, 'dt'),
    client_id: valueFrom(urlParams, bodyParams, 'cid'),
    session_id: valueFrom(urlParams, bodyParams, 'sid'),
    has_product: hasProduct,
    payload_source: payloadSource,
    ...product
  };
}

export function toGA4Evidence(parsed: ParsedGA4Request, input: {
  host: string;
  path: string;
  method: string;
  phase: string;
  timestamp: number;
  collector: TrackingRequestEvidence['collector'];
}): TrackingRequestEvidence {
  return {
    vendor: 'ga4',
    kind: parsed.kind,
    collector: input.collector,
    host: input.host,
    path: input.path,
    method: input.method,
    phase: input.phase,
    timestamp: input.timestamp,
    event: parsed.event || undefined,
    measurement_id: parsed.measurement_id || undefined,
    page_url: parsed.page_url || undefined,
    client_id: parsed.client_id || undefined,
    session_id: parsed.session_id || undefined,
    has_product: parsed.has_product,
    product_id: parsed.product_id,
    product_name: parsed.product_name,
    brand: parsed.brand,
    category: parsed.category,
    value: parsed.value
  };
}

export function isGA4MeasurementId(value: string): boolean {
  return MEASUREMENT_ID.test(value);
}
