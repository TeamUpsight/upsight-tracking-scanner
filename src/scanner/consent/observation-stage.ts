/** Bounded context for a failed Consent observation; never carries page data. */
export type ConsentObservationStage =
  | 'browser_facts' | 'framework_observation' | 'provider_context_build'
  | 'provider_selection' | 'provider_operations' | 'semantic_discovery'
  | 'ui_readiness' | 'diagnostic_census' | 'framework_normalization'
  | 'generic_detection' | 'us_privacy_observation' | 'diagnostic_observation'
  | 'usercentrics_v2_state_read';

export type ConsentObservationOperation =
  | 'captureBrowserConsentFacts' | 'observeConsentFrameworksInPage'
  | 'buildProviderContexts' | 'selectProvider' | 'providerOperations'
  | 'discoverProviderSemanticControls' | 'discoverUsercentricsSemanticControls'
  | 'waitForConsentUiReadiness' | 'captureDiagnosticConsentControlCensus'
  | 'captureConsentUiReadySnapshot' | 'frameworkStateFromObservations'
  | 'detectGenericConsentMechanism' | 'usPrivacyObservation'
  | 'diagnosticObservation' | 'readUsercentricsV2State';

export type BrowserFactsSubstage =
  | 'browser_facts_core' | 'generic_main_dom' | 'cookiebot_dom' | 'shadow_dom'
  | 'generic_shadow_controls' | 'cookiebot_runtime' | 'cookieyes_runtime'
  | 'onetrust_runtime' | 'didomi_runtime' | 'shopify_runtime'
  | 'consent_commands' | 'browser_storage' | 'browser_privacy_signal'
  | 'provider_globals' | 'provider_events' | 'standard_dom_observations'
  | 'serialize_result' | 'usercentrics_dom_runtime' | 'usercentrics_lifecycle'
  | 'usercentrics_v2_state_read' | 'usercentrics_root' | 'usercentrics_shadow'
  | 'usercentrics_controls';

export type BrowserFactsErrorFamily =
  | 'type_error' | 'reference_error' | 'security_error' | 'dom_exception'
  | 'serialization_error' | 'execution_context_destroyed'
  | 'navigation_interrupted' | 'page_closed' | 'other';

/** A safe replacement for browser/Playwright exceptions that may contain page data. */
export class BrowserFactsCaptureError extends Error {
  constructor(readonly browser_facts_substage: BrowserFactsSubstage, readonly error_family: BrowserFactsErrorFamily) {
    super('BROWSER_FACTS_CAPTURE_FAILED');
    this.name = 'BrowserFactsCaptureError';
  }
}

/** Inspect Playwright error text transiently; only an allowlisted family escapes. */
export function browserFactsPlaywrightErrorFamily(error: unknown): BrowserFactsErrorFamily {
  const message = error instanceof Error ? error.message : '';
  if (/Execution context was destroyed|Cannot find context with specified id|context was destroyed/i.test(message)) return 'execution_context_destroyed';
  if (/Target page, context or browser has been closed|Target closed|Page closed/i.test(message)) return 'page_closed';
  if (/Navigation failed|navigation interrupted|net::ERR_ABORTED/i.test(message)) return 'navigation_interrupted';
  if (/serialization|could not be cloned|Object reference chain is too long/i.test(message)) return 'serialization_error';
  return 'other';
}

const failureMarker = Symbol('consentObservationFailure');
type MarkedError = Error & { [failureMarker]?: { observation_stage: ConsentObservationStage; operation: ConsentObservationOperation } };

export function consentObservationFailure(error: unknown): {
  observation_stage: ConsentObservationStage;
  operation: ConsentObservationOperation;
  browser_facts_substage?: BrowserFactsSubstage;
  error_family?: BrowserFactsErrorFamily;
} | null {
  if (!(error instanceof Error)) return null;
  const marked = (error as MarkedError)[failureMarker];
  if (!marked) return null;
  return error instanceof BrowserFactsCaptureError
    ? { ...marked, browser_facts_substage: error.browser_facts_substage, error_family: error.error_family }
    : marked;
}

export async function withConsentObservationStage<T>(
  observation_stage: ConsentObservationStage,
  operation: ConsentObservationOperation,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Preserve the original exception and its error-family classification.
    // An inner, more precise stage takes precedence over an enclosing stage.
    const marked = error instanceof Error ? error as MarkedError : new Error('CONSENT_OBSERVATION_NON_ERROR_THROW') as MarkedError;
    marked[failureMarker] ||= { observation_stage, operation };
    throw marked;
  }
}
