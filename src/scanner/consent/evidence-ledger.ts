import { sanitizeValue } from '../quality/sanitize';

export type ConsentEvidencePhase =
  | 'baseline'
  | 'detected'
  | 'pre_action'
  | 'post_action'
  | 'post_reload';

export type ConsentEvidenceFamily =
  | 'dom'
  | 'a11y'
  | 'asset'
  | 'storage'
  | 'global'
  | 'framework'
  | 'network'
  | 'semantic'
  | 'consent_mode';

export type ConsentEvidenceSource =
  | 'page'
  | 'frame'
  | 'browser_context'
  | 'network'
  | 'provider_adapter'
  | 'semantic_probe'
  | 'runtime';

export type ConsentEvidenceKind =
  | 'presence'
  | 'visibility'
  | 'attribute'
  | 'storage_key'
  | 'global_name'
  | 'framework_api'
  | 'network_endpoint'
  | 'semantic_control'
  | 'consent_mode_state'
  | 'state_change'
  | 'other';

export type EvidenceSpecificity = 'provider_specific' | 'framework_specific' | 'generic';

export type EvidenceStability = 'stable' | 'tenant_variant' | 'unknown';

export type EvidenceProvenance =
  | 'browser_api'
  | 'dom_snapshot'
  | 'network_metadata'
  | 'allowlisted_shape'
  | 'adapter';

export interface CookieAttributeDescriptor {
  domain: string | null;
  secure: boolean | null;
  http_only: boolean | null;
  same_site: 'lax' | 'strict' | 'none' | 'unknown' | null;
  partitioned: boolean | null;
}

export interface PrivacySafeDescriptor {
  exists?: boolean;
  value_length?: number;
  key_name?: string;
  hostname?: string;
  path_pattern?: string;
  parameter_presence?: string[];
  cookie_attributes?: CookieAttributeDescriptor;
  parsed_shape?: Record<string, 'boolean' | 'number' | 'string' | 'array' | 'object' | 'null'>;
}

export interface ConsentEvidenceInput {
  phase: ConsentEvidencePhase;
  source: ConsentEvidenceSource;
  family: ConsentEvidenceFamily;
  kind: ConsentEvidenceKind;
  specificity: EvidenceSpecificity;
  stability: EvidenceStability;
  provenance: EvidenceProvenance;
  timestamp?: number;
  frame_path?: readonly unknown[];
  provider_candidate?: string | null;
  /**
   * May include raw browser observations. append() retains only the explicitly
   * allowed descriptor fields defined by PrivacySafeDescriptor.
   */
  descriptor?: unknown;
}

export interface ConsentEvidenceObservation {
  sequence: number;
  timestamp: number;
  phase: ConsentEvidencePhase;
  source: ConsentEvidenceSource;
  frame_path: string[];
  family: ConsentEvidenceFamily;
  kind: ConsentEvidenceKind;
  specificity: EvidenceSpecificity;
  stability: EvidenceStability;
  provenance: EvidenceProvenance;
  provider_candidate: string | null;
  descriptor: PrivacySafeDescriptor;
}

const ALLOWED_SHAPE_KEYS = new Set([
  'version', 'purposes', 'vendors', 'categories', 'consents', 'legitimate_interests',
  'ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'
]);

const SAFE_PATH_SEGMENTS = new Set([
  'api', 'assets', 'banner', 'cmp', 'collect', 'consent', 'css', 'js', 'privacy', 'script', 'scripts', 'sdk', 'v1', 'v2'
]);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedLength(value: string) {
  return Math.min(value.length, 10_000);
}

function safeLabel(value: unknown, fallback: string | null = null) {
  if (typeof value !== 'string') return fallback;
  const sanitized = sanitizeValue(value);
  if (typeof sanitized !== 'string') return fallback;
  const normalized = sanitized.trim();
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(normalized)) return fallback;
  return normalized;
}

function normalizeHostname(value: unknown) {
  if (typeof value !== 'string') return null;
  const domain = value.trim().replace(/^\.+/, '').toLowerCase();
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) return domain;
  try {
    return new URL(value).hostname.toLowerCase() || null;
  } catch {
    return safeLabel(value);
  }
}

function normalizePathPattern(pathname: string) {
  const segments = pathname.split('/').filter(Boolean).map((segment) => {
    const normalized = segment.toLowerCase();
    return SAFE_PATH_SEGMENTS.has(normalized) ? normalized : ':segment';
  });
  return segments.length ? `/${segments.join('/')}` : '/';
}

function valueShape(value: unknown): PrivacySafeDescriptor['parsed_shape'][string] | null {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'object') return 'object';
  return null;
}

function normalizeParsedShape(value: unknown) {
  const source = recordOf(value);
  if (!source) return undefined;
  const shape: NonNullable<PrivacySafeDescriptor['parsed_shape']> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!ALLOWED_SHAPE_KEYS.has(key)) continue;
    const itemShape = valueShape(item);
    if (itemShape) shape[key] = itemShape;
  }
  return Object.keys(shape).length ? shape : undefined;
}

function normalizeCookieAttributes(value: unknown) {
  const source = recordOf(value);
  if (!source) return undefined;
  const sameSite = typeof source.same_site === 'string' ? source.same_site.toLowerCase() : null;
  return {
    domain: normalizeHostname(source.domain),
    secure: typeof source.secure === 'boolean' ? source.secure : null,
    http_only: typeof source.http_only === 'boolean' ? source.http_only : null,
    same_site: sameSite === 'lax' || sameSite === 'strict' || sameSite === 'none' ? sameSite : 'unknown',
    partitioned: typeof source.partitioned === 'boolean' ? source.partitioned : null
  } satisfies CookieAttributeDescriptor;
}

export function normalizePrivacySafeDescriptor(value: unknown): PrivacySafeDescriptor {
  const source = recordOf(value);
  if (!source) return {};
  const descriptor: PrivacySafeDescriptor = {};

  if (typeof source.exists === 'boolean') descriptor.exists = source.exists;
  if (typeof source.value === 'string') descriptor.value_length = boundedLength(source.value);
  if (typeof source.value_length === 'number' && Number.isFinite(source.value_length)) {
    descriptor.value_length = Math.min(Math.max(0, Math.floor(source.value_length)), 10_000);
  }

  const keyName = safeLabel(source.key_name);
  if (keyName) descriptor.key_name = keyName;

  if (typeof source.url === 'string') {
    try {
      const url = new URL(source.url);
      descriptor.hostname = url.hostname.toLowerCase();
      descriptor.path_pattern = normalizePathPattern(url.pathname);
      const parameters = [...new Set([...url.searchParams.keys()].map((key) => safeLabel(key)).filter(Boolean) as string[])];
      if (parameters.length) descriptor.parameter_presence = parameters.slice(0, 20).sort();
    } catch {
      // Invalid URLs add no URL-derived metadata.
    }
  }

  const cookieAttributes = normalizeCookieAttributes(source.cookie_attributes);
  if (cookieAttributes) descriptor.cookie_attributes = cookieAttributes;
  const parsedShape = normalizeParsedShape(source.parsed_shape);
  if (parsedShape) descriptor.parsed_shape = parsedShape;

  return descriptor;
}

function normalizeFramePath(path: readonly unknown[] | undefined) {
  const depth = Math.min(path?.length || 1, 10);
  return Array.from({ length: depth }, (_, index) => index === 0 ? 'top' : `child_${index}`);
}

function normalizeTimestamp(timestamp: number | undefined) {
  return timestamp !== undefined && Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now();
}

function freezeObservation(observation: ConsentEvidenceObservation) {
  const descriptor = observation.descriptor;
  if (descriptor.parameter_presence) Object.freeze(descriptor.parameter_presence);
  if (descriptor.cookie_attributes) Object.freeze(descriptor.cookie_attributes);
  if (descriptor.parsed_shape) Object.freeze(descriptor.parsed_shape);
  Object.freeze(descriptor);
  Object.freeze(observation.frame_path);
  return Object.freeze(observation);
}

export class ConsentEvidenceLedger {
  private readonly observations: ConsentEvidenceObservation[] = [];
  private nextSequence = 1;
  readonly max_observations: number;
  truncated = false;

  constructor(maxObservations = 500) {
    const requested = Number.isFinite(maxObservations) ? Math.floor(maxObservations) : 500;
    this.max_observations = Math.max(1, Math.min(requested, 2_000));
  }

  get size() {
    return this.observations.length;
  }

  append(input: ConsentEvidenceInput): ConsentEvidenceObservation | null {
    if (this.observations.length >= this.max_observations) {
      this.truncated = true;
      return null;
    }
    const observation: ConsentEvidenceObservation = {
      sequence: this.nextSequence++,
      timestamp: normalizeTimestamp(input.timestamp),
      phase: input.phase,
      source: input.source,
      frame_path: normalizeFramePath(input.frame_path),
      family: input.family,
      kind: input.kind,
      specificity: input.specificity,
      stability: input.stability,
      provenance: input.provenance,
      provider_candidate: safeLabel(input.provider_candidate),
      descriptor: normalizePrivacySafeDescriptor(input.descriptor)
    };
    const immutableObservation = freezeObservation(observation);
    this.observations.push(immutableObservation);
    return immutableObservation;
  }

  timeline() {
    return this.observations.slice();
  }

  byPhase(phase: ConsentEvidencePhase) {
    return this.observations.filter((observation) => observation.phase === phase);
  }

  byFamily(family: ConsentEvidenceFamily) {
    return this.observations.filter((observation) => observation.family === family);
  }

  byProviderCandidate(providerCandidate: string) {
    const normalized = safeLabel(providerCandidate);
    return normalized ? this.observations.filter((observation) => observation.provider_candidate === normalized) : [];
  }

  byTimeRange(start: number, end: number) {
    const earliest = Math.min(start, end);
    const latest = Math.max(start, end);
    return this.observations.filter((observation) => observation.timestamp >= earliest && observation.timestamp <= latest);
  }
}
