import {
  platformRuntimeRegistry,
  type AdapterDetectionInput,
  type AdapterDetectionResult,
  type AdapterOperationInput,
  type AdapterOperationResult,
  type ConsentProviderAdapter
} from './adapter-registry';
import {
  ConsentAuditCodes,
  type AvailableAction,
  type BannerState,
  type ConsentAuditCode,
  type ConsentDecision,
  type ConsentState,
  type MechanismResult,
  type PersistenceResult,
  type VerificationResult
} from './domain-types';

export const SHOPIFY_CUSTOMER_PRIVACY_READ_METHODS = [
  'currentVisitorConsent',
  'analyticsProcessingAllowed',
  'marketingAllowed',
  'preferencesProcessingAllowed',
  'saleOfDataAllowed',
  'shouldShowBanner',
  'getRegion'
] as const;

export type ShopifyCustomerPrivacyReadMethod = typeof SHOPIFY_CUSTOMER_PRIVACY_READ_METHODS[number];
export type ShopifyConsentValue = 'yes' | 'no' | '';
export type ShopifySemanticAction = 'accept_all' | 'reject_all' | 'open_preferences';

export interface ShopifyVisitorConsent {
  analytics: ShopifyConsentValue;
  marketing: ShopifyConsentValue;
  preferences: ShopifyConsentValue;
  sale_of_data: ShopifyConsentValue;
}

export interface ShopifyProcessingAllowed {
  analytics: boolean | null;
  marketing: boolean | null;
  preferences: boolean | null;
  sale_of_data: boolean | null;
}

/**
 * A semantic surface is supplied only after runtime-linked discovery. It does
 * not contain speculative selectors or raw text.
 */
export interface ShopifyNativeSurface {
  visible: boolean;
  confirmed_by_runtime: boolean;
  semantic_actions?: readonly ShopifySemanticAction[];
}

/** Runtime observations only; Shopify internal cookie values are never read or modified. */
export interface ShopifyCustomerPrivacyContext {
  shopify_object_present?: boolean;
  customer_privacy_object_present?: boolean;
  runtime_methods?: readonly string[];
  visitor_consent?: ShopifyVisitorConsent | null;
  processing_allowed?: ShopifyProcessingAllowed | null;
  should_show_banner?: boolean | null;
  region_available?: boolean | null;
  native_surface?: ShopifyNativeSurface | null;
  observed_events?: readonly string[];
  /** Legacy-only supporting evidence; it cannot establish the current runtime. */
  legacy_tracking_consent_present?: boolean;
}

export interface ShopifyRuntimeDetection {
  status: 'detected' | 'not_detected' | 'inconclusive';
  evidence: string[];
  reason_codes: ConsentAuditCode[];
}

const PROCESSING_METHODS = [
  'analyticsProcessingAllowed',
  'marketingAllowed',
  'preferencesProcessingAllowed',
  'saleOfDataAllowed'
] as const;

function hasMethod(context: ShopifyCustomerPrivacyContext, method: ShopifyCustomerPrivacyReadMethod) {
  return context.runtime_methods?.some((value) => value === method) || false;
}

function hasExpectedCurrentRuntime(context: ShopifyCustomerPrivacyContext) {
  const processingMethods = PROCESSING_METHODS.filter((method) => hasMethod(context, method));
  return Boolean(
    context.shopify_object_present &&
    context.customer_privacy_object_present &&
    hasMethod(context, 'currentVisitorConsent') &&
    hasMethod(context, 'shouldShowBanner') &&
    processingMethods.length >= 2
  );
}

function contextFrom(input: AdapterOperationInput) {
  const context = input.context;
  return context && typeof context === 'object' ? context as ShopifyCustomerPrivacyContext : null;
}

function completed<T>(value: T): AdapterOperationResult<T> {
  return { status: 'completed', value, reason_codes: [] };
}

function inconclusive<T>(value: T, reasonCodes: ConsentAuditCode[] = [ConsentAuditCodes.DETECTION_INCONCLUSIVE]) {
  return { status: 'inconclusive' as const, value, reason_codes: reasonCodes };
}

/** Current Customer Privacy requires expected read methods; a same-named object alone is not enough. */
export function detectShopifyCustomerPrivacy(context: ShopifyCustomerPrivacyContext): ShopifyRuntimeDetection {
  if (hasExpectedCurrentRuntime(context)) {
    return {
      status: 'detected',
      evidence: ['shopify_customer_privacy_object', 'shopify_customer_privacy_read_methods'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED]
    };
  }
  if (context.customer_privacy_object_present || context.legacy_tracking_consent_present) {
    return {
      status: 'inconclusive',
      evidence: [
        ...(context.customer_privacy_object_present ? ['shopify_customer_privacy_object'] : []),
        ...(context.legacy_tracking_consent_present ? ['shopify_tracking_consent_legacy'] : [])
      ],
      reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE]
    };
  }
  return { status: 'not_detected', evidence: [], reason_codes: [] };
}

/**
 * This internal representation deliberately remains a commerce privacy
 * runtime. It never populates, competes with, or changes a CMP provider.
 */
export function shopifyCustomerPrivacyMechanism(context: ShopifyCustomerPrivacyContext): MechanismResult {
  const detection = detectShopifyCustomerPrivacy(context);
  const identified = detection.status === 'detected';
  return {
    mechanism: 'commerce_privacy_runtime',
    detection: {
      status: identified ? 'verified' : 'inconclusive', evidence: detection.evidence, reason_codes: detection.reason_codes
    },
    provider: {
      attribution: identified ? 'identified' : 'inconclusive',
      confidence: identified ? 'high' : 'low',
      candidates: [{
        provider_name: 'shopify', attribution: identified ? 'identified' : 'inconclusive', confidence: identified ? 'high' : 'low',
        evidence: detection.evidence, reason_codes: detection.reason_codes
      }],
      reason_codes: detection.reason_codes
    },
    adapter_maturity: 'documentation_supported'
  };
}

function normalizedDecision(value: ShopifyConsentValue): ConsentDecision {
  return value === 'yes' ? 'accepted' : value === 'no' ? 'rejected' : 'unanswered';
}

function overallDecision(consent: ShopifyVisitorConsent): ConsentDecision {
  const values = [consent.analytics, consent.marketing, consent.preferences, consent.sale_of_data].map(normalizedDecision);
  if (values.every((value) => value === 'unanswered')) return 'unanswered';
  if (values.every((value) => value === 'accepted')) return 'accepted';
  if (values.every((value) => value === 'rejected')) return 'rejected';
  return 'partial';
}

/** Processing-allowed flags are contextual runtime facts and do not overwrite visitor consent decisions. */
export function shopifyCustomerPrivacyState(context: ShopifyCustomerPrivacyContext): ConsentState {
  const consent = context.visitor_consent;
  const evidence: string[] = [];
  if (hasMethod(context, 'currentVisitorConsent')) evidence.push('shopify_current_visitor_consent_api_available');
  if (consent) evidence.push('shopify_current_visitor_consent_read');
  if (context.processing_allowed?.analytics !== null && context.processing_allowed?.analytics !== undefined) evidence.push('shopify_analytics_processing_allowed_read');
  if (context.processing_allowed?.marketing !== null && context.processing_allowed?.marketing !== undefined) evidence.push('shopify_marketing_allowed_read');
  if (context.processing_allowed?.preferences !== null && context.processing_allowed?.preferences !== undefined) evidence.push('shopify_preferences_processing_allowed_read');
  if (context.processing_allowed?.sale_of_data !== null && context.processing_allowed?.sale_of_data !== undefined) evidence.push('shopify_sale_of_data_allowed_read');
  if (context.observed_events?.includes('visitorConsentCollected')) evidence.push('shopify_visitor_consent_collected_event');
  if (!consent) {
    return { decision: 'ambiguous', categories: [], evidence, reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] };
  }
  return {
    decision: overallDecision(consent),
    categories: [
      { category: 'analytics', decision: normalizedDecision(consent.analytics), evidence: ['shopify_current_visitor_consent'] },
      { category: 'marketing', decision: normalizedDecision(consent.marketing), evidence: ['shopify_current_visitor_consent'] },
      { category: 'preferences', decision: normalizedDecision(consent.preferences), evidence: ['shopify_current_visitor_consent'] },
      { category: 'sale_or_share', decision: normalizedDecision(consent.sale_of_data), evidence: ['shopify_current_visitor_consent'] }
    ],
    evidence,
    reason_codes: []
  };
}

/** shouldShowBanner indicates native-banner applicability, not CMP presence or another banner's visibility. */
export function shopifyCustomerPrivacyBannerState(context: ShopifyCustomerPrivacyContext): BannerState {
  const native = context.native_surface;
  if (native?.confirmed_by_runtime && native.visible) {
    return { surface: 'banner', visibility: 'visible', evidence: ['shopify_native_surface_runtime_confirmed'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] };
  }
  if (context.should_show_banner === false) {
    return { surface: 'none', visibility: 'not_visible', evidence: ['shopify_should_show_banner_false'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] };
  }
  if (context.should_show_banner === true) {
    return { surface: 'unknown', visibility: 'unknown', evidence: ['shopify_should_show_banner_true'], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
  }
  return { surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] };
}

/** Native semantic controls may be reported but interaction remains unvalidated and is not executed by this runtime adapter. */
export function shopifyCustomerPrivacyAvailableActions(context: ShopifyCustomerPrivacyContext): AvailableAction[] {
  const native = context.native_surface;
  const actionAvailable = (action: ShopifySemanticAction) => Boolean(native?.visible && native.confirmed_by_runtime && native.semantic_actions?.includes(action));
  const accept = actionAvailable('accept_all');
  const reject = actionAvailable('reject_all');
  const preferences = actionAvailable('open_preferences');
  return [
    { action: 'accept_all', availability: accept ? 'direct' : 'unknown', category: null, evidence: accept ? ['shopify_native_semantic_accept'] : [], reason_codes: accept ? [ConsentAuditCodes.ACCEPT_AVAILABLE] : [] },
    { action: 'reject_all', availability: reject ? 'direct' : preferences ? 'preferences_only' : 'unknown', category: null, evidence: reject ? ['shopify_native_semantic_reject'] : preferences ? ['shopify_native_semantic_preferences'] : [], reason_codes: reject ? [ConsentAuditCodes.REJECT_AVAILABLE] : preferences ? [ConsentAuditCodes.REJECT_PREFERENCES_ONLY] : [ConsentAuditCodes.REJECT_NOT_AVAILABLE] },
    { action: 'open_preferences', availability: preferences ? 'direct' : 'unknown', category: null, evidence: preferences ? ['shopify_native_semantic_preferences'] : [], reason_codes: preferences ? [ConsentAuditCodes.PREFERENCES_LINK_PRESENT] : [] }
  ];
}

/** No direct Shopify cookie access is used; persistence is intentionally outside this runtime adapter. */
export function shopifyCustomerPrivacyPersistenceEvidence(): PersistenceResult {
  return { status: 'not_applicable', evidence: [], reason_codes: [ConsentAuditCodes.PERSISTENCE_NOT_APPLICABLE] };
}

export function shopifyCustomerPrivacyVerificationContribution(context: ShopifyCustomerPrivacyContext): VerificationResult {
  const state = shopifyCustomerPrivacyState(context);
  return {
    status: 'inconclusive',
    evidence: [
      ...(state.decision !== 'ambiguous' ? ['shopify_customer_privacy_state_read'] : []),
      ...(context.observed_events?.includes('visitorConsentCollected') ? ['shopify_visitor_consent_collected_event'] : [])
    ],
    reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE]
  };
}

function runtimeDetect(input: AdapterDetectionInput): AdapterDetectionResult {
  const typed = input.evidence.some((evidence) => evidence.provider_id === 'shopify_customer_privacy' && evidence.family === 'typed_provider_api' && evidence.specificity === 'provider_specific');
  const state = input.evidence.some((evidence) => evidence.provider_id === 'shopify_customer_privacy' && evidence.family === 'provider_state' && evidence.specificity === 'provider_specific');
  if (typed && state) return { status: 'detected', evidence: ['typed_provider_api', 'provider_state'], reason_codes: [ConsentAuditCodes.CMP_DETECTED] };
  if (typed || state) return { status: 'inconclusive', evidence: typed ? ['typed_provider_api'] : ['provider_state'], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] };
  return { status: 'not_detected', evidence: [], reason_codes: [] };
}

/** This is registered only with platformRuntimeRegistry, never cmpAdapterRegistry. */
export const shopifyCustomerPrivacyRuntime: ConsentProviderAdapter<'shopify_customer_privacy'> = {
  metadata: {
    provider_id: 'shopify_customer_privacy',
    adapter_version: '1.0.0',
    supported_runtime_variants: ['customer_privacy_current'],
    supported_template_variants: ['runtime_linked_native_surface'],
    regions: null,
    tcf_capable: false,
    gpp_capable: false,
    iframe_support: false,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: false,
    stable_dom_interaction_support: false,
    preferences_flow_support: false,
    capability_maturity: {
      detection: 'documentation_supported',
      state_read: 'documentation_supported',
      banner_state: 'documentation_supported',
      available_actions: 'unvalidated',
      accept: 'unvalidated',
      reject: 'unvalidated',
      open_preferences: 'unvalidated',
      save_preferences: 'unsupported',
      verify_action: 'supporting_only',
      persistence_evidence: 'supporting_only'
    }
  },
  detect: runtimeDetect,
  getState(input) {
    const context = contextFrom(input);
    return context ? completed(shopifyCustomerPrivacyState(context)) : inconclusive<ConsentState>({ decision: 'ambiguous', categories: [], evidence: [], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE] });
  },
  getBannerState(input) {
    const context = contextFrom(input);
    return context ? completed(shopifyCustomerPrivacyBannerState(context)) : inconclusive<BannerState>({ surface: 'unknown', visibility: 'unknown', evidence: [], reason_codes: [ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  },
  getAvailableActions(input) {
    const context = contextFrom(input);
    return context ? completed(shopifyCustomerPrivacyAvailableActions(context)) : inconclusive<AvailableAction[]>([]);
  },
  verifyAction(input) {
    const context = contextFrom(input);
    return context ? completed(shopifyCustomerPrivacyVerificationContribution(context)) : inconclusive<VerificationResult>({ status: 'inconclusive', evidence: [], reason_codes: [ConsentAuditCodes.ACTION_INCONCLUSIVE] });
  },
  getPersistenceEvidence() {
    return completed(shopifyCustomerPrivacyPersistenceEvidence());
  }
};

platformRuntimeRegistry.register(shopifyCustomerPrivacyRuntime);
