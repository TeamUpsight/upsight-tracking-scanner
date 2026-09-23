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
  const tcfStateIsSemantic = tcf.lifecycle === 'ready' && tcf.latest_event !== null && (
    tcf.latest_event.purpose_consents.known || tcf.latest_event.vendor_consents.known
  );
  if (tcfStateIsSemantic) strongFamilies.push('framework_tcf');
  if (providerStateIsSemantic(input.providerState)) strongFamilies.push('provider_state');
  if (providerCategoriesAreSemantic(input.providerState)) strongFamilies.push('provider_category_state');
  else if (providerCategoryChannelIsAvailable(input.providerState)) strongFamilies.push('provider_category_state');

  if (strongFamilies.length) return { status: 'available', strong_families: strongFamilies, reason_codes: [] };
  if (tcf.lifecycle === 'stub_present' || tcf.lifecycle === 'loading') {
    return { status: 'inconclusive', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_PENDING] };
  }
  return { status: 'unavailable', strong_families: [], reason_codes: [ConsentAuditCodes.CMP_VERIFICATION_CAPABILITY_UNAVAILABLE] };
}
