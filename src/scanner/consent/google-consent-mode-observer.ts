import { ConsentAuditCodes, type ConsentAuditCode, type MechanismResult } from './domain-types';

export const GOOGLE_CONSENT_FIELDS = [
  'ad_storage',
  'analytics_storage',
  'ad_user_data',
  'ad_personalization',
  'functionality_storage',
  'personalization_storage',
  'security_storage'
] as const;

export const GOOGLE_CONSENT_NETWORK_PARAMETERS = [
  'gcs',
  'gcd',
  'dma',
  'dma_cps',
  'gcu',
  'gcut',
  'npa'
] as const;

export type GoogleConsentField = typeof GOOGLE_CONSENT_FIELDS[number];
export type GoogleConsentValue = 'granted' | 'denied' | 'unset' | 'unknown';
export type GoogleConsentCommandType = 'default' | 'update';
export type GoogleConsentCommandSource = 'gtag' | 'data_layer';
export type GoogleConsentModeClassification =
  | 'advanced_candidate'
  | 'basic_candidate'
  | 'manual_gating_candidate'
  | 'not_configured'
  | 'ambiguous';

export interface NormalizedGoogleConsentState {
  ad_storage: GoogleConsentValue;
  analytics_storage: GoogleConsentValue;
  ad_user_data: GoogleConsentValue;
  ad_personalization: GoogleConsentValue;
  functionality_storage: GoogleConsentValue;
  personalization_storage: GoogleConsentValue;
  security_storage: GoogleConsentValue;
  wait_for_update_present: boolean;
  wait_for_update_ms: number | null;
}

export interface GoogleConsentCommandObservation {
  sequence: number;
  timestamp: number;
  source: GoogleConsentCommandSource;
  command: GoogleConsentCommandType;
  state: NormalizedGoogleConsentState;
}

export interface GoogleConsentNetworkParameterDescriptor {
  present: boolean;
  value_length: number;
  encoding: 'empty' | 'numeric' | 'opaque';
}

export interface GoogleConsentNetworkObservation {
  sequence: number;
  timestamp: number;
  parameters: Partial<Record<typeof GOOGLE_CONSENT_NETWORK_PARAMETERS[number], GoogleConsentNetworkParameterDescriptor>>;
}

export interface GoogleConsentModeResult {
  classification: GoogleConsentModeClassification;
  lifecycle: 'not_observed' | 'default_observed' | 'default_and_update' | 'update_only';
  commands: GoogleConsentCommandObservation[];
  network: GoogleConsentNetworkObservation[];
  user_choice_timestamp: number | null;
  tracking_gated: boolean;
  pre_choice_measurement_window_observed: boolean;
  default_issued_late: boolean;
  reason_codes: ConsentAuditCode[];
}

export interface GoogleConsentModeObserverOptions {
  max_commands?: number;
  max_network_observations?: number;
}

/** Produces the additive Consent V2 mechanism owned by the GCM observer. */
export function googleConsentModeMechanism(result: GoogleConsentModeResult): MechanismResult[] {
  if (result.lifecycle === 'not_observed' && result.network.length === 0) return [];
  const lifecycleObserved = result.lifecycle !== 'not_observed';
  return [{
    mechanism: 'consent_mode',
    detection: {
      status: lifecycleObserved ? 'verified' : 'inconclusive',
      evidence: [`gcm:${result.classification}`, `gcm_lifecycle:${result.lifecycle}`],
      reason_codes: result.reason_codes
    },
    provider: null,
    adapter_maturity: 'documentation_supported'
  }];
}

type PlainRecord = Record<string, unknown>;

const EMPTY_STATE: NormalizedGoogleConsentState = Object.freeze({
  ad_storage: 'unset',
  analytics_storage: 'unset',
  ad_user_data: 'unset',
  ad_personalization: 'unset',
  functionality_storage: 'unset',
  personalization_storage: 'unset',
  security_storage: 'unset',
  wait_for_update_present: false,
  wait_for_update_ms: null
});

function recordOf(value: unknown): PlainRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as PlainRecord : null;
}

function timestampOrNow(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? Math.floor(value) : Date.now();
}

function boundedLimit(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(500, Math.floor(value!)));
}

function normalizeConsentValue(value: unknown): GoogleConsentValue {
  if (value === undefined) return 'unset';
  return value === 'granted' || value === 'denied' ? value : 'unknown';
}

function normalizeWaitForUpdate(value: unknown) {
  const valid = typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 60_000;
  return {
    wait_for_update_present: value !== undefined,
    wait_for_update_ms: valid ? value : null
  };
}

export function normalizeGoogleConsentState(value: unknown): NormalizedGoogleConsentState {
  const source = recordOf(value);
  if (!source) return EMPTY_STATE;
  const wait = normalizeWaitForUpdate(source.wait_for_update);
  return {
    ad_storage: normalizeConsentValue(source.ad_storage),
    analytics_storage: normalizeConsentValue(source.analytics_storage),
    ad_user_data: normalizeConsentValue(source.ad_user_data),
    ad_personalization: normalizeConsentValue(source.ad_personalization),
    functionality_storage: normalizeConsentValue(source.functionality_storage),
    personalization_storage: normalizeConsentValue(source.personalization_storage),
    security_storage: normalizeConsentValue(source.security_storage),
    ...wait
  };
}

function commandFromDataLayerEntry(entry: unknown): { command: GoogleConsentCommandType; state: unknown } | null {
  const arrayEntry = Array.isArray(entry) ? entry : null;
  const recordEntry = recordOf(entry);
  const first = arrayEntry?.[0] ?? recordEntry?.['0'];
  const second = arrayEntry?.[1] ?? recordEntry?.['1'];
  const third = arrayEntry?.[2] ?? recordEntry?.['2'];
  if (first !== 'consent' || (second !== 'default' && second !== 'update')) return null;
  return { command: second, state: third };
}

function isGoogleMeasurementUrl(parsed: URL) {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
  const googleHost = host === 'analytics.google.com' || host.endsWith('.google-analytics.com') ||
    host === 'www.google.com' || host.endsWith('.doubleclick.net');
  return googleHost && (path.endsWith('/g/collect') || path.endsWith('/collect') || path === '/ccm/collect');
}

function descriptor(value: string): GoogleConsentNetworkParameterDescriptor {
  return {
    present: true,
    value_length: Math.min(value.length, 1_024),
    encoding: value.length === 0 ? 'empty' : /^\d+$/.test(value) ? 'numeric' : 'opaque'
  };
}

function safeNetworkParameters(url: string, body: string | undefined) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isGoogleMeasurementUrl(parsed)) return null;
  const parameterSources = [parsed.searchParams];
  if (body) parameterSources.push(new URLSearchParams(body.replace(/^\?/, '')));
  const parameters: GoogleConsentNetworkObservation['parameters'] = {};
  for (const parameter of GOOGLE_CONSENT_NETWORK_PARAMETERS) {
    const value = parameterSources.map((source) => source.get(parameter)).find((item) => item !== null);
    if (value !== undefined && value !== null) parameters[parameter] = descriptor(value);
  }
  return Object.keys(parameters).length ? parameters : null;
}

function hasDeniedState(command: GoogleConsentCommandObservation) {
  return GOOGLE_CONSENT_FIELDS.some((field) => command.state[field] === 'denied');
}

function hasGrantedState(command: GoogleConsentCommandObservation) {
  return GOOGLE_CONSENT_FIELDS.some((field) => command.state[field] === 'granted');
}

function hasGcsParameter(observation: GoogleConsentNetworkObservation) {
  return Boolean(observation.parameters.gcs);
}

function reasonCodes(input: {
  hasLifecycle: boolean;
  hasNetworkEvidence: boolean;
  classification: GoogleConsentModeClassification;
}): ConsentAuditCode[] {
  const codes: ConsentAuditCode[] = [];
  if (input.hasLifecycle || input.hasNetworkEvidence) codes.push(ConsentAuditCodes.CONSENT_MODE_PRESENT);
  if (input.classification === 'ambiguous') codes.push(ConsentAuditCodes.CONSENT_MODE_AMBIGUOUS);
  return codes;
}

/**
 * A bounded, provider-independent Consent Mode fact collector. Callers may
 * feed direct gtag calls, dataLayer entries, and relevant Google measurement
 * requests as they are observed. It never stores raw command objects or query
 * parameter values, and it does not decode gcs/gcd/dma encodings.
 */
export class GoogleConsentModeObserver {
  private readonly commands: GoogleConsentCommandObservation[] = [];
  private readonly network: GoogleConsentNetworkObservation[] = [];
  private readonly maxCommands: number;
  private readonly maxNetworkObservations: number;
  private nextSequence = 1;
  private userChoiceTimestamp: number | null = null;
  private trackingGated = false;
  private preChoiceMeasurementWindowObserved = false;

  constructor(options: GoogleConsentModeObserverOptions = {}) {
    this.maxCommands = boundedLimit(options.max_commands, 100);
    this.maxNetworkObservations = boundedLimit(options.max_network_observations, 200);
  }

  observeGtagCall(command: unknown, action: unknown, state: unknown, timestamp?: number) {
    if (command !== 'consent' || (action !== 'default' && action !== 'update')) return null;
    return this.appendCommand('gtag', action, state, timestamp);
  }

  observeDataLayerEntry(entry: unknown, timestamp?: number) {
    const command = commandFromDataLayerEntry(entry);
    return command ? this.appendCommand('data_layer', command.command, command.state, timestamp) : null;
  }

  observeDataLayer(entries: readonly unknown[], timestamp?: number) {
    return entries.map((entry) => this.observeDataLayerEntry(entry, timestamp)).filter(Boolean) as GoogleConsentCommandObservation[];
  }

  observeMeasurementRequest(input: { url: string; body?: string; timestamp?: number }) {
    if (this.network.length >= this.maxNetworkObservations) return null;
    const parameters = safeNetworkParameters(input.url, input.body);
    if (!parameters) return null;
    const observation: GoogleConsentNetworkObservation = {
      sequence: this.nextSequence++,
      timestamp: timestampOrNow(input.timestamp),
      parameters: Object.freeze(Object.fromEntries(
        Object.entries(parameters).map(([key, value]) => [key, Object.freeze(value)])
      ))
    };
    this.network.push(Object.freeze(observation));
    return observation;
  }

  markUserChoice(timestamp?: number) {
    this.userChoiceTimestamp = timestampOrNow(timestamp);
  }

  markTrackingGated() {
    this.trackingGated = true;
  }

  /**
   * Records that the caller observed the complete pre-choice measurement
   * window. Basic-mode candidates require this explicit absence boundary.
   */
  markPreChoiceMeasurementWindowObserved() {
    this.preChoiceMeasurementWindowObserved = true;
  }

  result(): GoogleConsentModeResult {
    const commands = this.commands.slice();
    const network = this.network.slice();
    const defaults = commands.filter((command) => command.command === 'default');
    const updates = commands.filter((command) => command.command === 'update');
    const firstDefault = defaults[0];
    const choiceTimestamp = this.userChoiceTimestamp;
    const preChoiceNetwork = choiceTimestamp === null ? [] : network.filter((item) => item.timestamp < choiceTimestamp);
    const postChoiceNetwork = choiceTimestamp === null ? [] : network.filter((item) => item.timestamp >= choiceTimestamp);
    const defaultIssuedLate = Boolean(firstDefault && network.some((item) => item.timestamp < firstDefault.timestamp));
    const defaultDenied = defaults.some(hasDeniedState);
    const positiveUpdate = updates.some((command) => hasGrantedState(command) && (choiceTimestamp === null || command.timestamp >= choiceTimestamp));
    const lifecycle = defaults.length && updates.length ? 'default_and_update'
      : defaults.length ? 'default_observed'
        : updates.length ? 'update_only'
          : 'not_observed';
    const hasLifecycle = commands.length > 0;
    const hasNetworkEvidence = network.length > 0;
    let classification: GoogleConsentModeClassification;

    if (this.trackingGated && !hasLifecycle) {
      classification = 'manual_gating_candidate';
    } else if (!hasLifecycle && !hasNetworkEvidence) {
      classification = 'not_configured';
    } else if (
      choiceTimestamp !== null &&
      !defaultIssuedLate &&
      defaultDenied &&
      preChoiceNetwork.some(hasGcsParameter)
    ) {
      // gcs is retained only as opaque presence evidence. The observed denied
      // default supplies the consent state; no network encoding is decoded.
      classification = 'advanced_candidate';
    } else if (
      choiceTimestamp !== null &&
      !defaultIssuedLate &&
      this.trackingGated &&
      this.preChoiceMeasurementWindowObserved &&
      preChoiceNetwork.length === 0 &&
      postChoiceNetwork.length > 0 &&
      positiveUpdate
    ) {
      classification = 'basic_candidate';
    } else {
      classification = 'ambiguous';
    }

    return {
      classification,
      lifecycle,
      commands,
      network,
      user_choice_timestamp: choiceTimestamp,
      tracking_gated: this.trackingGated,
      pre_choice_measurement_window_observed: this.preChoiceMeasurementWindowObserved,
      default_issued_late: defaultIssuedLate,
      reason_codes: reasonCodes({ hasLifecycle, hasNetworkEvidence, classification })
    };
  }

  private appendCommand(source: GoogleConsentCommandSource, command: GoogleConsentCommandType, state: unknown, timestamp?: number) {
    if (this.commands.length >= this.maxCommands) return null;
    const observation: GoogleConsentCommandObservation = {
      sequence: this.nextSequence++,
      timestamp: timestampOrNow(timestamp),
      source,
      command,
      state: Object.freeze(normalizeGoogleConsentState(state))
    };
    this.commands.push(Object.freeze(observation));
    return observation;
  }
}
