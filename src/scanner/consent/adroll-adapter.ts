import {
  cmpAdapterRegistry,
  scoreProviderCandidates,
  type AdapterDetectionInput,
  type AdapterDetectionResult,
  type AdapterOperationInput,
  type AdapterOperationResult,
  type ConsentProviderAdapter,
  type ProviderEvidenceSignal
} from './adapter-registry';
import { ConsentAuditCodes, type BannerState } from './domain-types';

export const ADROLL_STANDARD_ROOT = '#adroll_consent_banner';

export interface AdRollAdapterContext {
  window_globals?: readonly string[];
  asset_urls?: readonly string[];
  surface?: { selector: string; present: boolean; visible: boolean };
  load_when_ready_available?: boolean;
  semantic_controls?: readonly {
    accessible_name: string;
    semantic_action: string | null;
    visible: boolean;
    enabled: boolean;
    actionable: boolean;
  }[];
  tcf_active?: boolean;
  gpp_active?: boolean;
}

function hasExact(values: readonly string[] | undefined, expected: string) {
  return values?.some((value) => value === expected) || false;
}

/** Exact host/path matching prevents generic AdRoll assets from identifying its CMP. */
export function hasAdRollConsentAsset(values: readonly string[] | undefined) {
  return values?.some((value) => {
    try {
      const url = new URL(value);
      return url.hostname.toLowerCase() === 's.adroll.com' && url.pathname === '/j/consent_tcfv2.js';
    } catch {
      return false;
    }
  }) || false;
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as AdRollAdapterContext : null;
}

function completed<T>(value: T): AdapterOperationResult<T> {
  return { status: 'completed', value, reason_codes: [] };
}

/** Framework presence is deliberately excluded: TCF/GPP never identify AdRoll. */
export function adRollProviderEvidence(context: AdRollAdapterContext): ProviderEvidenceSignal[] {
  const evidence: ProviderEvidenceSignal[] = [];
  if (hasAdRollConsentAsset(context.asset_urls)) {
    evidence.push({
      provider_id: 'adroll', family: 'provider_asset', kind: 'unique_provider_script_or_config',
      specificity: 'provider_specific', deterministic_provider_signature: true
    });
  }
  if (hasExact(context.window_globals, '__adroll_consent_banner')) {
    evidence.push({
      provider_id: 'adroll', family: 'typed_provider_api', kind: 'typed_documented_provider_api',
      specificity: 'provider_specific', deterministic_provider_signature: true
    });
  }
  if (context.surface?.selector === ADROLL_STANDARD_ROOT && context.surface.present) {
    evidence.push({
      provider_id: 'adroll', family: 'provider_root', kind: 'stable_provider_root',
      specificity: 'provider_specific', deterministic_provider_signature: true
    });
  }
  return evidence;
}

export function detectAdRoll(context: AdRollAdapterContext): AdapterDetectionResult {
  const candidate = scoreProviderCandidates(adRollProviderEvidence(context)).find((item) => item.provider_id === 'adroll');
  if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
  return candidate.high_confidence
    ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
    : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
}

/** Provider identity never implies visible UI. */
export function adRollBannerState(context: AdRollAdapterContext): BannerState {
  if (context.surface?.selector === ADROLL_STANDARD_ROOT && context.surface.present) {
    return context.surface.visible
      ? { surface: 'banner', visibility: 'visible', evidence: ['adroll_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] }
      : { surface: 'none', visibility: 'not_visible', evidence: ['adroll_standard_root'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  }
  return { surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
}

export const adRollAdapter: ConsentProviderAdapter<'adroll'> = {
  metadata: {
    provider_id: 'adroll',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['consent_tcfv2'],
    supported_template_variants: ['standard_banner'],
    regions: null,
    tcf_capable: true,
    gpp_capable: true,
    iframe_support: false,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: false,
    stable_dom_interaction_support: false,
    preferences_flow_support: false,
    capability_maturity: {
      detection: 'fixture_only',
      state_read: 'unsupported',
      banner_state: 'fixture_only',
      available_actions: 'unsupported',
      accept: 'unsupported',
      reject: 'unsupported',
      open_preferences: 'unsupported',
      save_preferences: 'unsupported',
      verify_action: 'unsupported',
      persistence_evidence: 'unsupported'
    }
  },
  getProviderEvidence(context) { return adRollProviderEvidence(context as AdRollAdapterContext); },
  detect(input: AdapterDetectionInput) {
    const candidate = scoreProviderCandidates(input.evidence).find((item) => item.provider_id === 'adroll');
    if (!candidate) return { status: 'not_detected', evidence: [], reason_codes: [] };
    return candidate.high_confidence
      ? { status: 'detected', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED] }
      : { status: 'inconclusive', evidence: candidate.independent_families, reason_codes: [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN, ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context
      ? completed(adRollBannerState(context))
      : { status: 'inconclusive', value: { surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] }, reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
  }
};

cmpAdapterRegistry.register(adRollAdapter);
