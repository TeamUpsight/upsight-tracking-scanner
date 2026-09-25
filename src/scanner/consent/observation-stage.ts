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

const failureMarker = Symbol('consentObservationFailure');
type MarkedError = Error & { [failureMarker]?: { observation_stage: ConsentObservationStage; operation: ConsentObservationOperation } };

export function consentObservationFailure(error: unknown): { observation_stage: ConsentObservationStage; operation: ConsentObservationOperation } | null {
  return error instanceof Error ? (error as MarkedError)[failureMarker] || null : null;
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
