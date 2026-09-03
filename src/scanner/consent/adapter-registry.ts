import type {
  AdapterMaturity,
  AvailableAction,
  BannerState,
  ConsentState,
  InteractionAttempt,
  PersistenceResult,
  VerificationResult
} from './domain-types';
import { ConsentAuditCodes, type ConsentAuditCode } from './domain-types';

export const CMP_ADAPTER_PROVIDER_IDS = [
  'onetrust',
  'cookiebot',
  'usercentrics',
  'didomi',
  'cookieyes',
  'sourcepoint'
] as const;

export const PLATFORM_RUNTIME_IDS = ['shopify_customer_privacy'] as const;

export type CmpAdapterProviderId = typeof CMP_ADAPTER_PROVIDER_IDS[number];
export type PlatformRuntimeId = typeof PLATFORM_RUNTIME_IDS[number];
export type ConsentAdapterCapability = typeof CONSENT_ADAPTER_CAPABILITIES[number];
export type ProviderEvidenceFamily =
  | 'typed_provider_api'
  | 'provider_asset'
  | 'provider_root'
  | 'provider_state'
  | 'provider_persistence'
  | 'provider_network'
  | 'framework'
  | 'consent_mode';
export type ProviderEvidenceKind =
  | 'typed_documented_provider_api'
  | 'unique_provider_script_or_config'
  | 'stable_provider_root'
  | 'provider_state_or_event'
  | 'provider_persistence_key'
  | 'provider_specific_network'
  | 'framework_signal'
  | 'consent_mode_signal';

export const CONSENT_ADAPTER_CAPABILITIES = [
  'detection',
  'state_read',
  'banner_state',
  'available_actions',
  'accept',
  'reject',
  'open_preferences',
  'save_preferences',
  'verify_action',
  'persistence_evidence'
] as const;

export interface ConsentAdapterMetadata<Id extends string> {
  provider_id: Id;
  adapter_version: string;
  supported_runtime_variants: string[];
  supported_template_variants: string[];
  regions: string[] | null;
  tcf_capable: boolean;
  gpp_capable: boolean;
  iframe_support: boolean;
  shadow_root_support: boolean;
  requires_trusted_user_gesture: boolean;
  public_api_interaction_support: boolean;
  stable_dom_interaction_support: boolean;
  preferences_flow_support: boolean;
  capability_maturity: Record<ConsentAdapterCapability, AdapterMaturity>;
}

export interface AdapterDetectionInput {
  evidence: readonly ProviderEvidenceSignal[];
}

export interface AdapterDetectionResult {
  status: 'detected' | 'not_detected' | 'inconclusive';
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

export interface AdapterOperationInput {
  timestamp?: number;
  /** Provider adapters may define a runtime bridge without widening persisted contracts. */
  context?: unknown;
}

export interface AdapterOperationResult<T> {
  status: 'completed' | 'unsupported' | 'inconclusive';
  value: T | null;
  reason_codes: ConsentAuditCode[];
}

type MaybePromise<T> = T | Promise<T>;

export interface ConsentProviderAdapter<Id extends string> {
  metadata: ConsentAdapterMetadata<Id>;
  detect(input: AdapterDetectionInput): MaybePromise<AdapterDetectionResult>;
  /** Converts a transient browser context into provider-owned evidence. */
  getProviderEvidence?: (context: unknown) => readonly ProviderEvidenceSignal[];
  getState?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<ConsentState>>;
  getBannerState?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<BannerState>>;
  getAvailableActions?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<AvailableAction[]>>;
  accept?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<InteractionAttempt>>;
  reject?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<InteractionAttempt>>;
  openPreferences?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<InteractionAttempt>>;
  savePreferences?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<InteractionAttempt>>;
  verifyAction?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<VerificationResult>>;
  getPersistenceEvidence?: (input: AdapterOperationInput) => MaybePromise<AdapterOperationResult<PersistenceResult>>;
}

export interface ProviderEvidenceSignal {
  provider_id: string | null;
  family: ProviderEvidenceFamily;
  kind: ProviderEvidenceKind;
  specificity: 'provider_specific' | 'framework_specific' | 'generic';
  polarity?: 'supporting' | 'conflicting';
}

export interface ProviderEvidenceScoringConfig {
  weights: Record<Exclude<ProviderEvidenceKind, 'framework_signal' | 'consent_mode_signal'>, number>;
  high_confidence_threshold: number;
  minimum_independent_families: number;
  minimum_conflict_margin: number;
  strong_conflict_threshold: number;
}

export interface ScoredProviderCandidate {
  provider_id: string;
  score: number;
  conflict_score: number;
  independent_families: ProviderEvidenceFamily[];
  strong_conflict: boolean;
  high_confidence: boolean;
  /** Registry-owned selection eligibility; callers must not recreate thresholds. */
  plausible_candidate: boolean;
  attribution: 'identified' | 'unknown_candidate' | 'inconclusive';
}

export const DEFAULT_PROVIDER_EVIDENCE_SCORING: ProviderEvidenceScoringConfig = {
  weights: {
    typed_documented_provider_api: 40,
    unique_provider_script_or_config: 30,
    stable_provider_root: 25,
    provider_state_or_event: 25,
    provider_persistence_key: 20,
    provider_specific_network: 10
  },
  high_confidence_threshold: 85,
  minimum_independent_families: 2,
  minimum_conflict_margin: 15,
  strong_conflict_threshold: 30
};

const EXPECTED_FAMILY: Record<ProviderEvidenceKind, ProviderEvidenceFamily> = {
  typed_documented_provider_api: 'typed_provider_api',
  unique_provider_script_or_config: 'provider_asset',
  stable_provider_root: 'provider_root',
  provider_state_or_event: 'provider_state',
  provider_persistence_key: 'provider_persistence',
  provider_specific_network: 'provider_network',
  framework_signal: 'framework',
  consent_mode_signal: 'consent_mode'
};

const OPERATION_METHODS = {
  state_read: 'getState',
  banner_state: 'getBannerState',
  available_actions: 'getAvailableActions',
  accept: 'accept',
  reject: 'reject',
  open_preferences: 'openPreferences',
  save_preferences: 'savePreferences',
  verify_action: 'verifyAction',
  persistence_evidence: 'getPersistenceEvidence'
} as const;

export type InvocableConsentAdapterCapability = keyof typeof OPERATION_METHODS;

function explicitUnsupported<T>(maturity: AdapterMaturity): AdapterOperationResult<T> {
  return {
    status: 'unsupported',
    value: null,
    reason_codes: [maturity === 'unsupported' ? ConsentAuditCodes.ACTION_NOT_EXPOSED : ConsentAuditCodes.ADAPTER_NOT_READY]
  };
}

export class ConsentAdapterRegistry<Id extends string> {
  private readonly adapters = new Map<Id, ConsentProviderAdapter<Id>>();
  private readonly allowedIds: Set<Id>;

  constructor(ids: readonly Id[]) {
    this.allowedIds = new Set(ids);
  }

  knownIds() {
    return [...this.allowedIds];
  }

  register(adapter: ConsentProviderAdapter<Id>) {
    const id = adapter.metadata.provider_id;
    if (!this.allowedIds.has(id)) throw new Error(`Unregistered Consent V2 provider id: ${id}`);
    if (this.adapters.has(id)) throw new Error(`Consent V2 adapter already registered: ${id}`);
    this.adapters.set(id, adapter);
    return adapter;
  }

  get(id: Id) {
    return this.adapters.get(id) || null;
  }

  getCapability(id: Id, capability: ConsentAdapterCapability): {
    supported: boolean;
    maturity: AdapterMaturity;
    reason_codes: ConsentAuditCode[];
  } {
    const adapter = this.get(id);
    if (!adapter) {
      return { supported: false, maturity: 'unvalidated', reason_codes: [ConsentAuditCodes.ADAPTER_NOT_READY] };
    }
    const maturity = adapter.metadata.capability_maturity[capability];
    if (capability === 'detection') {
      return { supported: maturity !== 'unsupported', maturity, reason_codes: maturity === 'unsupported' ? [ConsentAuditCodes.ADAPTER_NOT_READY] : [] };
    }
    const methodName = OPERATION_METHODS[capability as InvocableConsentAdapterCapability];
    const supported = maturity !== 'unsupported' && typeof adapter[methodName] === 'function';
    return {
      supported,
      maturity,
      reason_codes: supported ? [] : [maturity === 'unsupported' ? ConsentAuditCodes.ACTION_NOT_EXPOSED : ConsentAuditCodes.ADAPTER_NOT_READY]
    };
  }

  async invoke<T>(id: Id, capability: InvocableConsentAdapterCapability, input: AdapterOperationInput): Promise<AdapterOperationResult<T>> {
    const adapter = this.get(id);
    const capabilityResult = this.getCapability(id, capability);
    if (!adapter || !capabilityResult.supported) return explicitUnsupported<T>(capabilityResult.maturity);
    const methodName = OPERATION_METHODS[capability];
    const operation = adapter[methodName] as ((value: AdapterOperationInput) => MaybePromise<AdapterOperationResult<T>>) | undefined;
    return operation ? operation(input) : explicitUnsupported<T>(capabilityResult.maturity);
  }

  collectProviderEvidence(contexts: ReadonlyMap<Id, unknown>): ProviderEvidenceSignal[] {
    return this.knownIds().flatMap((id) => {
      const adapter = this.get(id);
      const context = contexts.get(id);
      return adapter?.getProviderEvidence && context ? [...adapter.getProviderEvidence(context)] : [];
    });
  }
}

/**
 * Framework and Consent Mode observations are deliberately ignored here: they
 * establish implementation facts, never the identity of a CMP provider.
 */
export function scoreProviderCandidates(
  evidence: readonly ProviderEvidenceSignal[],
  config: ProviderEvidenceScoringConfig = DEFAULT_PROVIDER_EVIDENCE_SCORING
): ScoredProviderCandidate[] {
  const candidateFamilies = new Map<string, Map<ProviderEvidenceFamily, number>>();
  const candidateConflicts = new Map<string, Map<ProviderEvidenceFamily, number>>();
  for (const signal of evidence) {
    if (!signal.provider_id || signal.specificity !== 'provider_specific') continue;
    if (signal.family === 'framework' || signal.family === 'consent_mode') continue;
    if (EXPECTED_FAMILY[signal.kind] !== signal.family) continue;
    const weight = config.weights[signal.kind as keyof ProviderEvidenceScoringConfig['weights']];
    if (!weight) continue;
    const target = signal.polarity === 'conflicting' ? candidateConflicts : candidateFamilies;
    const familyScores = target.get(signal.provider_id) || new Map<ProviderEvidenceFamily, number>();
    familyScores.set(signal.family, Math.max(familyScores.get(signal.family) || 0, weight));
    target.set(signal.provider_id, familyScores);
  }

  const providers = new Set([...candidateFamilies.keys(), ...candidateConflicts.keys()]);
  const preliminary = [...providers].map((providerId) => {
    const supporting = candidateFamilies.get(providerId) || new Map();
    const conflicts = candidateConflicts.get(providerId) || new Map();
    return {
      provider_id: providerId,
      score: [...supporting.values()].reduce((total, value) => total + value, 0),
      conflict_score: [...conflicts.values()].reduce((total, value) => total + value, 0),
      independent_families: [...supporting.keys()].sort() as ProviderEvidenceFamily[]
    };
  }).sort((left, right) => right.score - left.score || left.provider_id.localeCompare(right.provider_id));

  return preliminary.map((candidate) => {
    const strongestOtherCandidate = preliminary
      .filter((other) => other.provider_id !== candidate.provider_id)
      .reduce((highest, other) => Math.max(highest, other.score), 0);
    const strongConflict = candidate.conflict_score >= config.strong_conflict_threshold;
    const highConfidence =
      candidate.score >= config.high_confidence_threshold &&
      candidate.independent_families.length >= config.minimum_independent_families &&
      candidate.score - strongestOtherCandidate >= config.minimum_conflict_margin &&
      !strongConflict;
    return {
      ...candidate,
      strong_conflict: strongConflict,
      high_confidence: highConfidence,
      // A near-tie is not an identification, but each strongly evidenced
      // provider still needs to reach session-level active-surface resolution.
      // Otherwise two live CMPs are incorrectly reported as no CMP at all.
      plausible_candidate: candidate.score >= config.high_confidence_threshold &&
        candidate.independent_families.length >= config.minimum_independent_families &&
        !strongConflict,
      attribution: strongConflict ? 'inconclusive' : highConfidence ? 'identified' : 'unknown_candidate'
    };
  });
}

/** Reserved provider IDs; adapters are registered only in their own work packages. */
export const cmpAdapterRegistry = new ConsentAdapterRegistry<CmpAdapterProviderId>(CMP_ADAPTER_PROVIDER_IDS);

/** Separate platform/runtime namespace so a commerce privacy runtime is not a CMP adapter by default. */
export const platformRuntimeRegistry = new ConsentAdapterRegistry<PlatformRuntimeId>(PLATFORM_RUNTIME_IDS);
