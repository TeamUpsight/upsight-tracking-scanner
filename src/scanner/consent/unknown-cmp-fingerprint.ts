import { createHash } from 'node:crypto';
import {
  isConsentAuditCode,
  type AvailableAction,
  type ConsentActionType,
  type ConsentAuditCode,
  type ProviderAttribution
} from './domain-types';
import type { ConsentEvidenceFamily } from './evidence-ledger';

export const UNKNOWN_CMP_FINGERPRINT_LIMITS = {
  stable_dom: 5,
  script_hosts: 10,
  network_hosts: 10,
  storage_keys: 20,
  candidate_globals: 20,
  action_semantics: 10
} as const;

export interface UnknownCmpTcfSummary {
  presence: 'absent' | 'present' | 'unknown';
  readiness: 'loading' | 'ready' | 'error' | 'unknown';
  event_status: 'cmpuishown' | 'tcloaded' | 'useractioncomplete' | 'unknown';
}

export interface UnknownCmpGppSummary {
  presence: 'absent' | 'stub_present' | 'loading' | 'ready' | 'error' | 'unknown';
  display: 'visible' | 'hidden' | 'disabled' | 'unknown';
  supported_api_count: number | null;
}

export interface UnknownCmpFingerprintInput {
  mechanism_score: number;
  provider_attribution: ProviderAttribution;
  geo: 'USA' | 'EU' | 'UK' | null;
  stable_dom_hints?: readonly string[];
  script_hosts?: readonly string[];
  consent_network_hosts?: readonly string[];
  storage_key_names?: readonly string[];
  candidate_global_names?: readonly string[];
  available_actions?: readonly AvailableAction[];
  tcf?: Partial<UnknownCmpTcfSummary>;
  gpp?: Partial<UnknownCmpGppSummary>;
  provider_candidate_evidence?: readonly ConsentEvidenceFamily[];
  failure_reason_codes?: readonly string[];
}

export interface UnknownCmpFingerprintTelemetry {
  fingerprint: string;
  provider_attribution: 'unknown_candidate';
  geo: 'USA' | 'EU' | 'UK' | null;
  provider_candidate_evidence: Partial<Record<ConsentEvidenceFamily, number>>;
  stable_dom: string[];
  script_hosts: string[];
  consent_network_hosts: string[];
  storage_key_names: string[];
  candidate_global_names: string[];
  action_semantics: Array<{ action: ConsentActionType; availability: AvailableAction['availability'] }>;
  tcf: UnknownCmpTcfSummary;
  gpp: UnknownCmpGppSummary;
  failure_reason_codes: ConsentAuditCode[];
}

export interface UnknownCmpFingerprintConfig {
  minimum_mechanism_score: number;
}

export const DEFAULT_UNKNOWN_CMP_FINGERPRINT_CONFIG: UnknownCmpFingerprintConfig = {
  minimum_mechanism_score: 70
};

const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SAFE_TOKEN = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,127}$/;
const VOLATILE_ID = /(?:[0-9a-f]{8,}|\d{6,}|[a-z0-9_-]{40,})/i;

function boundedUnique<T>(values: readonly T[] | undefined, limit: number, normalize: (value: T) => string | null) {
  return [...new Set((values || []).map(normalize).filter((value): value is string => value !== null))].sort().slice(0, limit);
}

function hostname(value: string) {
  try {
    const fromUrl = new URL(value).hostname.toLowerCase();
    return SAFE_HOST.test(fromUrl) ? fromUrl : null;
  } catch {
    const normalized = value.trim().replace(/^\.+/, '').toLowerCase();
    return SAFE_HOST.test(normalized) ? normalized : null;
  }
}

/** Keeps element structure only: ids, attribute names, roles, and tags. Never values or text. */
export function normalizeStableDomHint(value: string) {
  const normalized = value.trim().toLowerCase();
  const attribute = normalized.match(/^\[\s*(data-[a-z0-9_-]{1,60}|aria-[a-z0-9_-]{1,60}|role)\b/i);
  if (attribute) return `attr:${attribute[1]}`;
  const role = normalized.match(/^role\s*[:=]\s*([a-z][a-z0-9_-]{0,60})$/i);
  if (role) return `role:${role[1]}`;
  const id = normalized.match(/^#([a-z][a-z0-9_-]{0,80})$/i);
  if (id && !VOLATILE_ID.test(id[1])) return `id:${id[1]}`;
  if (/^(?:dialog|aside|section|div|form)$/i.test(normalized)) return `tag:${normalized}`;
  return null;
}

/** Removes volatile identifiers from known key/global names rather than retaining a consent or session id. */
export function normalizeFingerprintName(value: string) {
  const normalized = value.trim().replace(/^window\./i, '').toLowerCase();
  if (!SAFE_TOKEN.test(normalized)) return null;
  if (VOLATILE_ID.test(normalized)) {
    const redacted = normalized.replace(/[0-9a-f]{8,}|\d{6,}|[a-z0-9_-]{40,}/ig, ':id');
    return SAFE_TOKEN.test(redacted) ? redacted : null;
  }
  return normalized;
}

function normalizeTcf(value: Partial<UnknownCmpTcfSummary> | undefined): UnknownCmpTcfSummary {
  const presence = value?.presence === 'present' || value?.presence === 'unknown' ? value.presence : 'absent';
  const readiness = value?.readiness === 'loading' || value?.readiness === 'ready' || value?.readiness === 'error' ? value.readiness : 'unknown';
  const eventStatus = value?.event_status === 'cmpuishown' || value?.event_status === 'tcloaded' || value?.event_status === 'useractioncomplete' ? value.event_status : 'unknown';
  return { presence, readiness, event_status: eventStatus };
}

function normalizeGpp(value: Partial<UnknownCmpGppSummary> | undefined): UnknownCmpGppSummary {
  const presence = ['stub_present', 'loading', 'ready', 'error', 'unknown'].includes(value?.presence || '') ? value?.presence as UnknownCmpGppSummary['presence'] : 'absent';
  const display = ['visible', 'hidden', 'disabled'].includes(value?.display || '') ? value?.display as UnknownCmpGppSummary['display'] : 'unknown';
  const count = typeof value?.supported_api_count === 'number' && Number.isFinite(value.supported_api_count)
    ? Math.max(0, Math.min(Math.floor(value.supported_api_count), 100)) : null;
  return { presence, display, supported_api_count: count };
}

function normalizeActions(actions: readonly AvailableAction[] | undefined) {
  const unique = new Map<ConsentActionType, AvailableAction['availability']>();
  for (const action of actions || []) {
    if (!unique.has(action.action)) unique.set(action.action, action.availability);
  }
  return [...unique.entries()]
    .map(([action, availability]) => ({ action, availability }))
    .sort((left, right) => left.action.localeCompare(right.action))
    .slice(0, UNKNOWN_CMP_FINGERPRINT_LIMITS.action_semantics);
}

function countEvidence(families: readonly ConsentEvidenceFamily[] | undefined) {
  const counts: Partial<Record<ConsentEvidenceFamily, number>> = {};
  for (const family of families || []) counts[family] = (counts[family] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) as Partial<Record<ConsentEvidenceFamily, number>>;
}

function fingerprintPayload(telemetry: Omit<UnknownCmpFingerprintTelemetry, 'fingerprint' | 'provider_attribution' | 'geo' | 'failure_reason_codes' | 'provider_candidate_evidence'>) {
  return JSON.stringify(telemetry);
}

export function isUnknownCmpFingerprintEligible(
  input: Pick<UnknownCmpFingerprintInput, 'mechanism_score' | 'provider_attribution'>,
  config: UnknownCmpFingerprintConfig = DEFAULT_UNKNOWN_CMP_FINGERPRINT_CONFIG
) {
  return Number.isFinite(input.mechanism_score) && input.mechanism_score >= config.minimum_mechanism_score &&
    input.provider_attribution === 'unknown_candidate';
}

/**
 * Produces aggregation-ready telemetry only for a high-confidence custom CMP
 * that remains unattributed. It has no provider-identification side effects.
 */
export function buildUnknownCmpFingerprint(
  input: UnknownCmpFingerprintInput,
  config: UnknownCmpFingerprintConfig = DEFAULT_UNKNOWN_CMP_FINGERPRINT_CONFIG
): UnknownCmpFingerprintTelemetry | null {
  if (!isUnknownCmpFingerprintEligible(input, config)) return null;
  const stable_dom = boundedUnique(input.stable_dom_hints, UNKNOWN_CMP_FINGERPRINT_LIMITS.stable_dom, normalizeStableDomHint);
  const script_hosts = boundedUnique(input.script_hosts, UNKNOWN_CMP_FINGERPRINT_LIMITS.script_hosts, hostname);
  const consent_network_hosts = boundedUnique(input.consent_network_hosts, UNKNOWN_CMP_FINGERPRINT_LIMITS.network_hosts, hostname);
  const storage_key_names = boundedUnique(input.storage_key_names, UNKNOWN_CMP_FINGERPRINT_LIMITS.storage_keys, normalizeFingerprintName);
  const candidate_global_names = boundedUnique(input.candidate_global_names, UNKNOWN_CMP_FINGERPRINT_LIMITS.candidate_globals, normalizeFingerprintName);
  const action_semantics = normalizeActions(input.available_actions);
  const tcf = normalizeTcf(input.tcf);
  const gpp = normalizeGpp(input.gpp);
  const payload = { stable_dom, script_hosts, consent_network_hosts, storage_key_names, candidate_global_names, action_semantics, tcf, gpp };
  const fingerprint = `ucmp:v1:${createHash('sha256').update(fingerprintPayload(payload)).digest('hex').slice(0, 24)}`;
  const failure_reason_codes = [...new Set((input.failure_reason_codes || []).filter(isConsentAuditCode))].sort();
  return {
    fingerprint,
    provider_attribution: 'unknown_candidate',
    geo: input.geo,
    provider_candidate_evidence: countEvidence(input.provider_candidate_evidence),
    ...payload,
    failure_reason_codes
  };
}
