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
  cmp_id: number | null;
  cmp_version: number | null;
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
  cmp_id: number | null;
  supported_apis: string[];
  section_list: number[];
  applicable_sections: number[];
}

export interface GppFrameworkObservation {
  present: boolean;
  lifecycle: FrameworkLifecycle;
  ping: GppPingSummary | null;
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
      ping: later.gpp.ping || earlier.gpp.ping,
      event_count: earlier.gpp.event_count + later.gpp.event_count,
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
    cmp_id: boundedInteger(source.cmpId),
    cmp_version: boundedInteger(source.cmpVersion),
    event_status: tcfEventStatus(source.eventStatus),
    gdpr_applies: readBoolean(source.gdprApplies),
    purpose_consents: consentSummary(purpose?.consents),
    vendor_consents: consentSummary(vendor?.consents)
  };
}

function safeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && /^[a-z][a-z0-9_.:-]{0,127}$/i.test(item)) result.add(item);
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

function gppPingSummary(payload: unknown): GppPingSummary | null {
  const source = recordOf(payload);
  if (!source) return null;
  const cmpStatus = source.cmpStatus;
  const displayStatus = source.cmpDisplayStatus;
  const signalStatus = source.signalStatus;
  return {
    gpp_version: safeVersion(source.gppVersion),
    cmp_status: cmpStatus === 'stub' || cmpStatus === 'loading' || cmpStatus === 'loaded' || cmpStatus === 'error'
      ? cmpStatus
      : 'unknown',
    cmp_display_status: displayStatus === 'visible' || displayStatus === 'hidden' || displayStatus === 'disabled'
      ? displayStatus
      : 'unknown',
    signal_status: signalStatus === 'ready' ? 'ready' : signalStatus === 'not ready' ? 'not_ready' : 'unknown',
    cmp_id: boundedInteger(source.cmpId),
    supported_apis: safeStringList(source.supportedAPIs),
    section_list: safeSectionList(source.sectionList),
    applicable_sections: safeSectionList(source.applicableSections)
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
    event_count: 0,
    reason_codes: [ConsentAuditCodes.GPP_PRESENT]
  };
  const applyPing = (payload: unknown, eventCount = 0) => {
    const ping = gppPingSummary(payload);
    state = {
      ...state,
      lifecycle: gppLifecycle(ping),
      ping,
      event_count: state.event_count + eventCount,
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
      applyPing(event?.pingData, 1);
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
