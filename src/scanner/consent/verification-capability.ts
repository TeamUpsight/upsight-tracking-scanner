import { ConsentAuditCodes, type ConsentAuditCode, type ConsentState } from './domain-types';
import type { ConsentFrameworkObservations } from './framework-observers';
import type { VerificationEvidenceFamily } from './reject-verification-engine';

export type VerificationCapabilityStatus = 'available' | 'unavailable' | 'inconclusive';

export interface VerificationCapability {
  status: VerificationCapabilityStatus;
  strong_families: VerificationEvidenceFamily[];
  reason_codes: ConsentAuditCode[];
}

function providerStateIsSemantic(state: ConsentState) {
  return state.decision === 'accepted' || state.decision === 'rejected';
}

function providerCategoriesAreSemantic(state: ConsentState) {
  if (!providerCategoryChannelIsAvailable(state)) return false;
  const decisions = state.categories.map((category) => category.decision);
  return decisions.length > 0 && (decisions.every((decision) => decision === 'rejected') || decisions.every((decision) => decision === 'accepted'));
}

function providerCategoryChannelIsAvailable(state: ConsentState) {
  // A normalized category inventory can be unresolved before the user acts
  // and still be a viable verifier if the same adapter can read its decision
  // values afterward. Empty inventories (the OneTrust non-TCF case) do not
  // qualify. Raw group identifiers never reach this boundary.
  return state.categories.length > 0 && state.categories.every((category) =>
    ['preferences', 'analytics', 'marketing', 'personalization'].includes(category.category)
  );
}

function tcfChannelIsAvailable(input: ConsentFrameworkObservations['tcf']) {
  const event = input.latest_event;
  const recognizedEvent = event?.event_status === 'cmpuishown' || event?.event_status === 'tcloaded' || event?.event_status === 'useractioncomplete';
  const hasAggregate = Boolean(event && (
    (event.purpose_consents.known && event.purpose_consents.total_count > 0) ||
    (event.vendor_consents.known && event.vendor_consents.total_count > 0)
  ));
  const hasOperationalListener = input.listener_registered === true && input.listener_event_observed === true && input.listener_registration_failed !== true;
  const errored = input.lifecycle === 'error' || input.ping?.cmp_status === 'error' || event?.cmp_status === 'error' || input.listener_registration_failed === true;
  // `cmpLoaded:false` explicitly means the stub is still serving. A valid
  // event cannot overrule that contradictory ping state for action preflight.
  const stubContradiction = input.ping?.cmp_loaded === false;
  return { available: input.present && !errored && !stubContradiction && hasOperationalListener && recognizedEvent && hasAggregate, errored, stubContradiction };
}

/**
 * Checks for a semantic verifier before interaction. Events, clicks, banner
 * visibility, persistence keys, and storage metadata intentionally do not
 * establish capability because none describes the resulting choice.
 */
export function assessRejectVerificationCapability(input: {
  providerState: ConsentState;
  frameworks: ConsentFrameworkObservations;
}): VerificationCapability {
  const strongFamilies: VerificationEvidenceFamily[] = [];
  const tcf = input.frameworks.tcf;
  const tcfCapability = tcfChannelIsAvailable(tcf);
  if (tcfCapability.available) strongFamilies.push('framework_tcf');
  if (providerStateIsSemantic(input.providerState)) strongFamilies.push('provider_state');
  if (providerCategoriesAreSemantic(input.providerState)) strongFamilies.push('provider_category_state');
  else if (providerCategoryChannelIsAvailable(input.providerState)) strongFamilies.push('provider_category_state');

  if (strongFamilies.length) return { status: 'available', strong_families: strongFamilies, reason_codes: [] };
  if (tcfCapability.errored) return { status: 'unavailable', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_UNAVAILABLE] };
  if (tcfCapability.stubContradiction || tcf.present && !tcfCapability.available && (tcf.lifecycle === 'stub_present' || tcf.lifecycle === 'loading')) {
    return { status: 'inconclusive', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_PENDING] };
  }
  return { status: 'unavailable', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_UNAVAILABLE] };
}
