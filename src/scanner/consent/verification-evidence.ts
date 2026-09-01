import type { ConsentDecision, ConsentState, VerificationResult } from './domain-types';
import type { ConsentFrameworkObservations } from './framework-observers';
import { tcfAggregateDecision } from './framework-observers';
import type { RejectVerificationSignal } from './reject-verification-engine';

function relationForDecision(decision: ConsentDecision): 'matches_requested' | 'contradicts_requested' | 'unknown' {
  if (decision === 'rejected') return 'matches_requested';
  if (decision === 'accepted') return 'contradicts_requested';
  return 'unknown';
}

/**
 * Combines normalized output from owning adapters and framework observers.
 * It intentionally contains no provider-specific category, API, or selector
 * semantics; those stay behind the adapter/browser bridge boundary.
 */
export function collectRejectVerificationSignals(input: {
  timestamp: number;
  interactionExecuted: boolean;
  navigationInterrupted: boolean;
  providerState: ConsentState;
  adapterVerification: VerificationResult | null;
  frameworks: ConsentFrameworkObservations;
}): RejectVerificationSignal[] {
  const signals: RejectVerificationSignal[] = [{
    family: 'interaction', rank: 'weak', relation: input.interactionExecuted ? 'matches_requested' : 'unknown', observed_at: input.timestamp
  }];
  const providerRelation = relationForDecision(input.providerState.decision);
  if (providerRelation !== 'unknown') signals.push({
    family: 'provider_state', rank: 'strong', relation: providerRelation, authoritative: true, observed_at: input.timestamp
  });

  const tcf = input.frameworks.tcf.latest_event;
  if (tcf?.event_status === 'useractioncomplete') {
    const purpose = tcfAggregateDecision(tcf.purpose_consents);
    const vendor = tcfAggregateDecision(tcf.vendor_consents);
    if (purpose === 'rejected' && vendor === 'rejected') signals.push({
      family: 'framework_tcf', rank: 'strong', relation: 'matches_requested', authoritative: true, observed_at: input.timestamp
    });
    else signals.push({ family: 'framework_tcf', rank: 'supporting', relation: 'unknown', observed_at: input.timestamp });
  }
  if (input.frameworks.gpp.lifecycle === 'ready') signals.push({ family: 'framework_gpp', rank: 'supporting', relation: 'unknown', observed_at: input.timestamp });
  if (input.adapterVerification?.evidence.length) signals.push({ family: 'provider_event', rank: 'supporting', relation: 'matches_requested', observed_at: input.timestamp });
  return signals;
}
