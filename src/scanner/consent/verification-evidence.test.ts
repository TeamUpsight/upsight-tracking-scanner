import { describe, expect, it } from 'vitest';
import type { ConsentState } from './domain-types';
import type { ConsentFrameworkObservations } from './framework-observers';
import { collectRejectVerificationSignals } from './verification-evidence';

const frameworks: ConsentFrameworkObservations = {
  tcf: { present: false, lifecycle: 'absent', ping: null, latest_event: null, event_count: 0, reason_codes: [] },
  gpp: { present: false, lifecycle: 'absent', ping: null, structure: null, event_count: 0, reason_codes: [] },
  usp: { present: false, mode: 'absent', reason_codes: [] }
};
const rejected: ConsentState = {
  decision: 'rejected',
  categories: ['preferences', 'analytics', 'marketing'].map((category) => ({ category: category as 'preferences' | 'analytics' | 'marketing', decision: 'rejected', evidence: ['cookiebot_runtime'] })),
  evidence: [], reason_codes: []
};

function collect(providerEvent?: 'CookiebotOnDecline' | 'CookiebotOnAccept' | 'CookiebotOnDialogDisplay', timestamp = 1_001) {
  return collectRejectVerificationSignals({
    timestamp, interactionExecuted: true, navigationInterrupted: false, providerState: rejected,
    providerStateIndependenceGroup: 'cookiebot_runtime', providerEventObserved: false,
    providerEventRelation: providerEvent === 'CookiebotOnDecline' ? 'matches_requested' : providerEvent === 'CookiebotOnAccept' ? 'contradicts_requested' : undefined,
    providerActionCompleted: false, frameworks
  });
}

describe('verification evidence provenance and Cookiebot event semantics', () => {
  it('groups runtime decision and normalized categories as one Cookiebot source', () => {
    expect(collect()).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'provider_state', independence_group: 'cookiebot_runtime' }),
      expect.objectContaining({ family: 'provider_category_state', independence_group: 'cookiebot_runtime' })
    ]));
  });

  it('normalizes decline as matching, accept as contradictory, and dialog display as neutral', () => {
    expect(collect('CookiebotOnDecline')).toContainEqual(expect.objectContaining({ family: 'provider_event', relation: 'matches_requested' }));
    expect(collect('CookiebotOnAccept')).toContainEqual(expect.objectContaining({ family: 'provider_event', relation: 'contradicts_requested' }));
    expect(collect('CookiebotOnDialogDisplay')).not.toContainEqual(expect.objectContaining({ family: 'provider_event' }));
  });

  it('retains action timestamp as the event chronology boundary', () => {
    expect(collect('CookiebotOnDecline', 999).find((signal) => signal.family === 'provider_event')?.observed_at).toBe(999);
  });
});
