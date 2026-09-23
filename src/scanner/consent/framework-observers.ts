import { ConsentAuditCodes, type ConsentAuditCode, type ConsentDecision, type FrameworkState, type MechanismResult } from './domain-types';

/**
 * Provider-neutral observations of the IAB framework APIs. These records are
 * intentionally limited to framework state and aggregate consent counts: they
 * never retain TC, GPP, or USP strings, consent identifiers, or CMP attribution.
 */

export type FrameworkLifecycle = 'absent' | 'stub_present' | 'loading' | 'ready' | 'error';

export type TcfEventStatus = 'cmpuishown' | 'tcloaded' | 'useractioncomplete' | 'unknown';

export interface ConsentBooleanSummary {
  known: boolean;
  total_count: number;
  granted_count: number;
  denied_count: number;
}

export interface TcfPingSummary {
  cmp_loaded: boolean | null;
  api_version: string | null;
  gdpr_applies: boolean | null;
}

export interface TcfSemanticSummary {
  event_status: TcfEventStatus | null;
  gdpr_applies: boolean | null;
  purpose_consents: ConsentBooleanSummary;
  vendor_consents: ConsentBooleanSummary;
}

export interface TcfFrameworkObservation {
  present: boolean;
  lifecycle: FrameworkLifecycle;
  ping: TcfPingSummary | null;
  latest_event: TcfSemanticSummary | null;
  event_count: number;
  reason_codes: ConsentAuditCode[];
}

export type GppDisplayStatus = 'visible' | 'hidden' | 'disabled' | 'unknown';
export type GppSignalStatus = 'ready' | 'not_ready' | 'unknown';

export interface GppPingSummary {
  gpp_version: string | null;
  cmp_status: 'stub' | 'loading' | 'loaded' | 'error' | 'unknown';
  cmp_display_status: GppDisplayStatus;
  signal_status: GppSignalStatus;
  supported_apis: string[];
  supported_section_ids: number[];
  section_list: number[];
  applicable_sections: number[];
  parsed_sections_available: boolean;
  parsed_section_prefixes: string[];
  supported_apis_valid: boolean;
  section_list_valid: boolean;
  applicable_sections_valid: boolean;
}

export type GppSectionFamily = 'tcf_eu' | 'tcf_canada' | 'legacy_usp' | 'gpp_infrastructure' | 'us_national' | 'us_state';
export type GppStructureConsistency = 'not_observed' | 'consistent' | 'inconsistent' | 'inconclusive';
export type GppSectionState = 'not_declared_applicable' | 'incomplete' | 'unavailable' | 'parsed_uninterpreted';

export interface GppSectionStructuralObservation {
  section_id: number;
  api_prefix: string | null;
  known: boolean;
  family: GppSectionFamily | null;
  technical_label: string | null;
  supported: boolean;
  present: boolean;
  cmp_declared_applicable: boolean;
  parsed_available: boolean;
  state: GppSectionState;
}

export interface GppStructureObservation {
  supported_sections: number[];
  present_sections: number[];
  cmp_declared_applicable_sections: number[];
  parsed_sections_available: boolean;
  parsed_section_prefixes: string[];
  sections: GppSectionStructuralObservation[];
  structural_consistency: GppStructureConsistency;
  reason_codes: string[];
}

export interface GppFrameworkObservation {
  present: boolean;
  lifecycle: FrameworkLifecycle;
  ping: GppPingSummary | null;
  structure: GppStructureObservation | null;
  event_count: number;
  reason_codes: ConsentAuditCode[];
}

export interface UspFrameworkObservation {
  present: boolean;
  mode: 'legacy_read_only' | 'absent';
  reason_codes: ConsentAuditCode[];
}

export interface ConsentFrameworkObservations {
  tcf: TcfFrameworkObservation;
  gpp: GppFrameworkObservation;
  usp: UspFrameworkObservation;
}

/**
 * Merges phase snapshots without interpreting a framework as a CMP.  Browser
 * bridges may be sampled at baseline, after an action, and after a reload; the
 * observer remains the single owner of which semantic state survives.
 */
export function mergeConsentFrameworkObservations(
  earlier: ConsentFrameworkObservations,
  later: ConsentFrameworkObservations
): ConsentFrameworkObservations {
  const mergeCodes = (left: ConsentAuditCode[], right: ConsentAuditCode[]) => [...new Set([...left, ...right])];
  const preserveCompletedGpp = earlier.gpp.ping?.signal_status === 'ready' && later.gpp.ping?.signal_status !== 'ready';
  return {
    tcf: {
      present: earlier.tcf.present || later.tcf.present,
      lifecycle: later.tcf.lifecycle === 'absent' ? earlier.tcf.lifecycle : later.tcf.lifecycle,
      ping: later.tcf.ping || earlier.tcf.ping,
      latest_event: later.tcf.latest_event || earlier.tcf.latest_event,
      event_count: earlier.tcf.event_count + later.tcf.event_count,
      reason_codes: mergeCodes(earlier.tcf.reason_codes, later.tcf.reason_codes)
    },
    gpp: {
      present: earlier.gpp.present || later.gpp.present,
      lifecycle: later.gpp.lifecycle === 'absent' ? earlier.gpp.lifecycle : later.gpp.lifecycle,
      ping: preserveCompletedGpp ? earlier.gpp.ping : later.gpp.ping || earlier.gpp.ping,
      structure: preserveCompletedGpp ? earlier.gpp.structure : later.gpp.structure || earlier.gpp.structure,
      event_count: Math.max(earlier.gpp.event_count, later.gpp.event_count),
      reason_codes: mergeCodes(earlier.gpp.reason_codes, later.gpp.reason_codes)
    },
    usp: {
      present: earlier.usp.present || later.usp.present,
      mode: later.usp.present ? later.usp.mode : earlier.usp.mode,
      reason_codes: mergeCodes(earlier.usp.reason_codes, later.usp.reason_codes)
    }
  };
}

/** Converts normalized framework observations into the public V2 summary. */
export function frameworkStateFromObservations(value: ConsentFrameworkObservations): FrameworkState {
  const presence = (lifecycle: FrameworkLifecycle) => lifecycle === 'absent' ? 'not_present' as const : lifecycle === 'stub_present' ? 'stub_present' as const : 'present' as const;
  const gpp = value.gpp.ping;
  return {
    tcf: presence(value.tcf.lifecycle),
    gpp: presence(value.gpp.lifecycle),
    usp: value.usp.present ? 'present' : 'not_present',
    evidence: [
      `tcf:${value.tcf.lifecycle}`,
      `gpp:${value.gpp.lifecycle}`,
      ...(gpp ? [`gpp_cmp_status:${gpp.cmp_status}`, `gpp_cmp_display_status:${gpp.cmp_display_status}`, `gpp_signal_status:${gpp.signal_status}`, `gpp_applicable_sections:${gpp.applicable_sections.join(',')}`] : []),
      ...(value.usp.present ? ['usp:legacy_read_only'] : [])
    ],
    reason_codes: [...new Set([...value.tcf.reason_codes, ...value.gpp.reason_codes, ...value.usp.reason_codes])]
  };
}

/** Framework presence is one additive mechanism, never provider attribution. */
export function frameworkMechanisms(value: FrameworkState): MechanismResult[] {
  return value.tcf === 'not_present' && value.gpp === 'not_present' && value.usp === 'not_present'
    ? []
    : [{ mechanism: 'framework', detection: { status: 'verified', evidence: value.evidence, reason_codes: value.reason_codes }, provider: null, adapter_maturity: 'documentation_supported' }];
}

/**
 * Turns the already-sanitized aggregate TCF observation into a decision for
 * consumers such as Sourcepoint.  This deliberately never reads a TC string
 * or individual purpose/vendor identifiers.
 */
export function tcfAggregateDecision(summary: ConsentBooleanSummary): ConsentDecision {
  if (!summary.known || summary.total_count === 0) return 'ambiguous';
  if (summary.denied_count === summary.total_count) return 'rejected';
  if (summary.granted_count === summary.total_count) return 'accepted';
  return 'partial';
}

/** Framework-owned conversion for persistence orchestration; no caller reads purpose aggregates itself. */
export function tcfObservationDecision(value: TcfFrameworkObservation): ConsentDecision | 'unavailable' {
  return value.latest_event ? tcfAggregateDecision(value.latest_event.purpose_consents) : 'unavailable';
}

export interface FrameworkObserver<T> {
  readonly state: T;
  stop(): void;
}

export interface FrameworkApiWindow {
  __tcfapi?: unknown;
  __gpp?: unknown;
  __uspapi?: unknown;
}

type TcfApi = (command: string, version: number, callback: FrameworkCallback, parameter?: unknown) => void;
type GppApi = (command: string, callback: FrameworkCallback, parameter?: unknown, version?: string) => void;
type FrameworkCallback = (payload: unknown, success?: boolean) => void;

const EMPTY_CONSENT_SUMMARY: ConsentBooleanSummary = Object.freeze({
  known: false,
  total_count: 0,
  granted_count: 0,
  denied_count: 0
});

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
}

function safeVersion(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,2}$/.test(value) ? value : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function consentSummary(value: unknown): ConsentBooleanSummary {
  const values = recordOf(value);
  if (!values) return EMPTY_CONSENT_SUMMARY;
  // Persistent browser bridges provide this already-sanitized aggregate. The
  // observer remains responsible for validating its shape before use.
  const total = boundedInteger(values.total_count);
  const grantedAggregate = boundedInteger(values.granted_count);
  const deniedAggregate = boundedInteger(values.denied_count);
  if (total !== null && grantedAggregate !== null && deniedAggregate !== null && total === grantedAggregate + deniedAggregate) {
    return { known: true, total_count: total, granted_count: grantedAggregate, denied_count: deniedAggregate };
  }
  let granted = 0;
  let denied = 0;
  for (const decision of Object.values(values)) {
    if (decision === true) granted += 1;
    if (decision === false) denied += 1;
  }
  return {
    known: true,
    total_count: granted + denied,
    granted_count: granted,
    denied_count: denied
  };
}

function tcfEventStatus(value: unknown): TcfEventStatus | null {
  if (value === 'cmpuishown' || value === 'tcloaded' || value === 'useractioncomplete') return value;
  return typeof value === 'string' ? 'unknown' : null;
}

function tcfPingSummary(payload: unknown): TcfPingSummary | null {
  const source = recordOf(payload);
  if (!source) return null;
  return {
    cmp_loaded: readBoolean(source.cmpLoaded),
    api_version: safeVersion(source.apiVersion),
    gdpr_applies: readBoolean(source.gdprApplies)
  };
}

function tcfSemanticSummary(payload: unknown): TcfSemanticSummary | null {
  const source = recordOf(payload);
  if (!source) return null;
  const purpose = recordOf(source.purpose);
  const vendor = recordOf(source.vendor);
  return {
    event_status: tcfEventStatus(source.eventStatus),
    gdpr_applies: readBoolean(source.gdprApplies),
    purpose_consents: consentSummary(purpose?.consents),
    vendor_consents: consentSummary(vendor?.consents)
  };
}

function safeSupportedApiList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && /^(?:\d{1,7}:)?[a-z][a-z0-9]{0,15}$/i.test(item)) result.add(item.toLowerCase());
    if (result.size >= 50) break;
  }
  return [...result].sort();
}

function safeSectionList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<number>();
  for (const item of value) {
    const section = boundedInteger(item);
    if (section !== null) result.add(section);
    if (result.size >= 50) break;
  }
  return [...result].sort((left, right) => left - right);
}

function safeApplicableSectionList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<number>(value.includes(-1) ? [-1] : []);
  for (const item of value) {
    if (item !== -1 && boundedInteger(item) !== null) result.add(item as number);
    if (result.size >= 50) break;
  }
  return [...result].sort((left, right) => left - right);
}

const GPP_SECTION_REGISTRY: Readonly<Record<number, { api_prefix: string | null; family: GppSectionFamily; technical_label: string }>> = Object.freeze({
  1: { api_prefix: 'tcfeuv1', family: 'tcf_eu', technical_label: 'EU TCF v1 (deprecated)' },
  2: { api_prefix: 'tcfeuv2', family: 'tcf_eu', technical_label: 'EU TCF v2' },
  3: { api_prefix: null, family: 'gpp_infrastructure', technical_label: 'GPP header' },
  4: { api_prefix: null, family: 'gpp_infrastructure', technical_label: 'GPP signal integrity' },
  5: { api_prefix: 'tcfcav1', family: 'tcf_canada', technical_label: 'Canada TCF v1' },
  6: { api_prefix: 'uspv1', family: 'legacy_usp', technical_label: 'US Privacy v1' },
  7: { api_prefix: 'usnat', family: 'us_national', technical_label: 'US National' },
  8: { api_prefix: 'usca', family: 'us_state', technical_label: 'US California' },
  9: { api_prefix: 'usva', family: 'us_state', technical_label: 'US Virginia' },
  10: { api_prefix: 'usco', family: 'us_state', technical_label: 'US Colorado' },
  11: { api_prefix: 'usut', family: 'us_state', technical_label: 'US Utah' },
  12: { api_prefix: 'usct', family: 'us_state', technical_label: 'US Connecticut' },
  13: { api_prefix: 'usfl', family: 'us_state', technical_label: 'US Florida' },
  14: { api_prefix: 'usmt', family: 'us_state', technical_label: 'US Montana' },
  15: { api_prefix: 'usor', family: 'us_state', technical_label: 'US Oregon' },
  16: { api_prefix: 'ustx', family: 'us_state', technical_label: 'US Texas' },
  17: { api_prefix: 'usde', family: 'us_state', technical_label: 'US Delaware' },
  18: { api_prefix: 'usia', family: 'us_state', technical_label: 'US Iowa' },
  19: { api_prefix: 'usne', family: 'us_state', technical_label: 'US Nebraska' },
  20: { api_prefix: 'usnh', family: 'us_state', technical_label: 'US New Hampshire' },
  21: { api_prefix: 'usnj', family: 'us_state', technical_label: 'US New Jersey' },
  22: { api_prefix: 'ustn', family: 'us_state', technical_label: 'US Tennessee' },
  23: { api_prefix: 'usmn', family: 'us_state', technical_label: 'US Minnesota' },
  24: { api_prefix: 'usmd', family: 'us_state', technical_label: 'US Maryland' },
  25: { api_prefix: 'usin', family: 'us_state', technical_label: 'US Indiana' },
  26: { api_prefix: 'usky', family: 'us_state', technical_label: 'US Kentucky' },
  27: { api_prefix: 'usri', family: 'us_state', technical_label: 'US Rhode Island' }
});

function safeParsedSectionPrefixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && /^[a-z][a-z0-9]{0,15}$/i.test(item)) result.add(item.toLowerCase());
    if (result.size >= 50) break;
  }
  return [...result].sort();
}

function sectionApiMappings(apis: string[]) {
  const byId = new Map<number, string>();
  const idByPrefix = new Map<string, number>();
  for (const [idText, entry] of Object.entries(GPP_SECTION_REGISTRY)) {
    if (entry.api_prefix) idByPrefix.set(entry.api_prefix, Number(idText));
  }
  for (const api of apis) {
    const identified = /^(\d{1,7}):([a-z][a-z0-9]{0,15})$/i.exec(api);
    if (identified) {
      const id = Number(identified[1]);
      if (Number.isSafeInteger(id) && !byId.has(id)) byId.set(id, identified[2].toLowerCase());
      continue;
    }
    const id = idByPrefix.get(api.toLowerCase());
    if (id !== undefined) byId.set(id, api.toLowerCase());
  }
  return byId;
}

function gppPingSummary(payload: unknown): GppPingSummary | null {
  const source = recordOf(payload);
  if (!source) return null;
  const cmpStatus = source.cmpStatus;
  const displayStatus = source.cmpDisplayStatus;
  const signalStatus = source.signalStatus;
  const supportedApisValid = Array.isArray(source.supportedAPIs);
  const sectionListValid = Array.isArray(source.sectionList);
  // The standard uses [-1] for the explicit no-applicable-section state;
  // an empty array cannot distinguish that state from incomplete ping data.
  const applicableSectionsValid = Array.isArray(source.applicableSections) && source.applicableSections.length > 0;
  const parsedSections = recordOf(source.parsedSections);
  const bridgeParsedPrefixes = safeParsedSectionPrefixes(source.parsedSectionPrefixes);
  const parsedPrefixes = bridgeParsedPrefixes.length ? bridgeParsedPrefixes : safeParsedSectionPrefixes(
    parsedSections ? Object.keys(parsedSections).filter((key) => {
      const segments = parsedSections[key];
      return /^[a-z][a-z0-9]{0,15}$/i.test(key) && Array.isArray(segments) && segments.length > 0 && Boolean(recordOf(segments[0]));
    }) : []
  );
  const supportedApis = safeSupportedApiList(source.supportedAPIs);
  const apiMappings = sectionApiMappings(supportedApis);
  return {
    gpp_version: safeVersion(source.gppVersion),
    cmp_status: cmpStatus === 'stub' || cmpStatus === 'loading' || cmpStatus === 'loaded' || cmpStatus === 'error'
      ? cmpStatus
      : 'unknown',
    cmp_display_status: displayStatus === 'visible' || displayStatus === 'hidden' || displayStatus === 'disabled'
      ? displayStatus
      : 'unknown',
    signal_status: signalStatus === 'ready' ? 'ready' : signalStatus === 'not ready' ? 'not_ready' : 'unknown',
    supported_apis: supportedApis,
    supported_section_ids: [...new Set([...safeSectionList(source.supported_section_ids), ...apiMappings.keys()])].slice(0, 50).sort((a, b) => a - b),
    section_list: safeSectionList(source.sectionList),
    applicable_sections: safeApplicableSectionList(source.applicableSections),
    parsed_sections_available: source.parsedSectionsAvailable === true || parsedPrefixes.length > 0,
    parsed_section_prefixes: parsedPrefixes,
    supported_apis_valid: supportedApisValid,
    section_list_valid: sectionListValid,
    applicable_sections_valid: applicableSectionsValid
  };
}

function gppStructureSummary(ping: GppPingSummary | null): GppStructureObservation | null {
  if (!ping) return null;
  const apiMappings = sectionApiMappings(ping.supported_apis);
  const prefixToId = new Map([...apiMappings].map(([id, prefix]) => [prefix, id]));
  const registryPrefixToId = new Map(Object.entries(GPP_SECTION_REGISTRY)
    .filter(([, entry]) => entry.api_prefix)
    .map(([id, entry]) => [entry.api_prefix!, Number(id)]));
  const parsedIds = ping.parsed_section_prefixes.map((prefix) => prefixToId.get(prefix) ?? registryPrefixToId.get(prefix)).filter((id): id is number => id !== undefined);
  const applicableIds = ping.applicable_sections.filter((id) => id >= 0);
  const allIds = [...new Set([
    ...ping.supported_section_ids,
    ...ping.section_list,
    ...applicableIds,
    ...parsedIds
  ])].sort((a, b) => a - b).slice(0, 50);
  const sections = allIds.map((sectionId): GppSectionStructuralObservation => {
    const known = GPP_SECTION_REGISTRY[sectionId];
    const apiPrefix = known?.api_prefix || apiMappings.get(sectionId) || null;
    const applicable = applicableIds.includes(sectionId);
    const present = ping.section_list.includes(sectionId);
    const parsedAvailable = Boolean(apiPrefix && ping.parsed_section_prefixes.includes(apiPrefix));
    const state: GppSectionState = !applicable ? 'not_declared_applicable'
      : ping.signal_status !== 'ready' ? 'incomplete'
        : !present || !parsedAvailable ? 'unavailable'
          : 'parsed_uninterpreted';
    return {
      section_id: sectionId,
      api_prefix: apiPrefix,
      known: Boolean(known),
      family: known?.family || null,
      technical_label: known?.technical_label || null,
      supported: ping.supported_section_ids.includes(sectionId),
      present,
      cmp_declared_applicable: applicable,
      parsed_available: parsedAvailable,
      state
    };
  });
  const reasons = new Set<string>();
  const applicableMissing = applicableIds.filter((id) => !ping.section_list.includes(id));
  if (applicableMissing.length) reasons.add('GPP_APPLICABLE_SECTION_MISSING_FROM_PAYLOAD');
  const applicableWithoutParsed = applicableIds.filter((id) => !sections.find((item) => item.section_id === id)?.parsed_available);
  if (applicableWithoutParsed.length) reasons.add('GPP_APPLICABLE_PARSED_SECTION_UNAVAILABLE');
  if (ping.signal_status !== 'ready') reasons.add('GPP_SIGNAL_NOT_READY');
  if (!ping.supported_apis_valid || !ping.section_list_valid || !ping.applicable_sections_valid) reasons.add('GPP_STRUCTURE_METADATA_UNAVAILABLE');
  const metadataValid = ping.supported_apis_valid && ping.section_list_valid && ping.applicable_sections_valid;
  const structuralConsistency: GppStructureConsistency = !metadataValid || ping.signal_status !== 'ready' ? 'inconclusive'
    : applicableMissing.length ? 'inconsistent'
      : applicableWithoutParsed.length ? 'inconclusive'
        : 'consistent';
  return {
    supported_sections: ping.supported_section_ids,
    present_sections: ping.section_list,
    cmp_declared_applicable_sections: ping.applicable_sections,
    parsed_sections_available: ping.parsed_sections_available,
    parsed_section_prefixes: ping.parsed_section_prefixes,
    sections,
    structural_consistency: structuralConsistency,
    reason_codes: [...reasons]
  };
}

function gppLifecycle(ping: GppPingSummary | null): FrameworkLifecycle {
  if (!ping) return 'loading';
  if (ping.cmp_status === 'stub') return 'stub_present';
  if (ping.cmp_status === 'loading') return 'loading';
  if (ping.cmp_status === 'loaded') return 'ready';
  if (ping.cmp_status === 'error') return 'error';
  return 'loading';
}

function gppReasonCodes(ping: GppPingSummary | null): ConsentAuditCode[] {
  const codes: ConsentAuditCode[] = [ConsentAuditCodes.GPP_PRESENT];
  if (ping?.cmp_status === 'stub') codes.push(ConsentAuditCodes.GPP_STUB_PRESENT);
  if (ping?.cmp_status === 'error') codes.push(ConsentAuditCodes.DETECTION_INCONCLUSIVE);
  return codes;
}

function tcfLifecycleFromPing(ping: TcfPingSummary | null): FrameworkLifecycle {
  if (!ping) return 'stub_present';
  return ping.cmp_loaded === true ? 'ready' : 'loading';
}

function eventListenerId(payload: unknown): number | string | null {
  const source = recordOf(payload);
  const id = source?.listenerId;
  return typeof id === 'number' || typeof id === 'string' ? id : null;
}

/**
 * Starts a TCF v2 observer. It uses ping for readiness and addEventListener as
 * the primary source of state transitions; it intentionally never calls
 * getTCData or exposes tcString.
 */
export function observeTcfFramework(runtime: FrameworkApiWindow): FrameworkObserver<TcfFrameworkObservation> {
  if (typeof runtime.__tcfapi !== 'function') {
    const absent: TcfFrameworkObservation = {
      present: false,
      lifecycle: 'absent',
      ping: null,
      latest_event: null,
      event_count: 0,
      reason_codes: []
    };
    return { state: absent, stop() {} };
  }

  const api = runtime.__tcfapi as TcfApi;
  let listenerId: number | string | null = null;
  let stopped = false;
  let state: TcfFrameworkObservation = {
    present: true,
    lifecycle: 'stub_present',
    ping: null,
    latest_event: null,
    event_count: 0,
    reason_codes: [ConsentAuditCodes.TCF_PRESENT]
  };
  const fail = () => {
    state = { ...state, lifecycle: 'error', reason_codes: [...state.reason_codes, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  };

  try {
    api('ping', 2, (payload, success) => {
      if (stopped || success === false) return fail();
      const ping = tcfPingSummary(payload);
      state = { ...state, ping, lifecycle: tcfLifecycleFromPing(ping) };
    });
    api('addEventListener', 2, (payload, success) => {
      if (stopped || success === false) return fail();
      listenerId = eventListenerId(payload) ?? listenerId;
      const event = tcfSemanticSummary(payload);
      if (!event) return;
      const ready = event.event_status === 'tcloaded' || event.event_status === 'useractioncomplete';
      state = {
        ...state,
        lifecycle: ready ? 'ready' : state.lifecycle,
        latest_event: event,
        event_count: state.event_count + 1
      };
    });
  } catch {
    fail();
  }

  return {
    get state() { return state; },
    stop() {
      stopped = true;
      if (listenerId === null) return;
      try { api('removeEventListener', 2, () => {}, listenerId); } catch { /* Best-effort listener cleanup. */ }
    }
  };
}

/**
 * Starts a GPP observer. The result preserves API lifecycle data but makes no
 * claims about CMP provider, jurisdiction, user choice, or banner visibility.
 */
export function observeGppFramework(runtime: FrameworkApiWindow): FrameworkObserver<GppFrameworkObservation> {
  if (typeof runtime.__gpp !== 'function') {
    const absent: GppFrameworkObservation = {
      present: false,
      lifecycle: 'absent',
      ping: null,
      structure: null,
      event_count: 0,
      reason_codes: []
    };
    return { state: absent, stop() {} };
  }

  const api = runtime.__gpp as GppApi;
  let listenerId: number | string | null = null;
  let stopped = false;
  let state: GppFrameworkObservation = {
    present: true,
    lifecycle: 'loading',
    ping: null,
    structure: null,
    event_count: 0,
    reason_codes: [ConsentAuditCodes.GPP_PRESENT]
  };
  const applyPing = (payload: unknown, eventCount = 0, bridgedEventCount: number | null = null) => {
    const ping = gppPingSummary(payload);
    const cumulativeEventCount = bridgedEventCount ?? boundedInteger(recordOf(payload)?.eventCount);
    state = {
      ...state,
      lifecycle: gppLifecycle(ping),
      ping,
      structure: gppStructureSummary(ping),
      event_count: cumulativeEventCount === null
        ? state.event_count + eventCount
        : Math.max(state.event_count, Math.min(100, cumulativeEventCount)),
      reason_codes: gppReasonCodes(ping)
    };
  };
  const fail = () => {
    state = { ...state, lifecycle: 'error', reason_codes: [...state.reason_codes, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  };

  try {
    api('ping', (payload, success) => {
      if (stopped || success === false) return fail();
      applyPing(payload);
    });
    api('addEventListener', (payload, success) => {
      if (stopped || success === false) return fail();
      listenerId = eventListenerId(payload) ?? listenerId;
      const event = recordOf(payload);
      applyPing(event?.pingData, 1, boundedInteger(event?.eventCount));
    });
  } catch {
    fail();
  }

  return {
    get state() { return state; },
    stop() {
      stopped = true;
      if (listenerId === null) return;
      try { api('removeEventListener', () => {}, listenerId); } catch { /* Best-effort listener cleanup. */ }
    }
  };
}

/** __uspapi is legacy, read-only framework evidence and is never promoted to GPP. */
export function observeUspFramework(runtime: FrameworkApiWindow): UspFrameworkObservation {
  const present = typeof runtime.__uspapi === 'function';
  return {
    present,
    mode: present ? 'legacy_read_only' : 'absent',
    reason_codes: present ? [ConsentAuditCodes.USP_PRESENT] : []
  };
}

export function observeConsentFrameworks(runtime: FrameworkApiWindow): {
  tcf: FrameworkObserver<TcfFrameworkObservation>;
  gpp: FrameworkObserver<GppFrameworkObservation>;
  usp: UspFrameworkObservation;
} {
  return {
    tcf: observeTcfFramework(runtime),
    gpp: observeGppFramework(runtime),
    usp: observeUspFramework(runtime)
  };
}
