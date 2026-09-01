import {
  ConsentAuditCodes,
  type ConsentActionType,
  type ConsentAuditCode,
  type VerificationResult
} from './domain-types';

export type VerificationEvidenceRank = 'strong' | 'supporting' | 'weak';

/**
 * Families are intentionally semantic and provider-independent. A verification
 * result requires independent families, not duplicate observations from one
 * implementation path.
 */
export type VerificationEvidenceFamily =
  | 'provider_state'
  | 'provider_category_state'
  | 'framework_tcf'
  | 'framework_gpp'
  | 'commerce_privacy_runtime'
  | 'provider_persistence'
  | 'provider_event'
  | 'consent_mode'
  | 'storage'
  | 'preference_toggle'
  | 'consent_submission'
  | 'interaction'
  | 'banner_surface'
  | 'ui_feedback';

/** `unanswered` is explicitly distinct from either a matching or conflicting decision. */
export type RequestedActionRelation = 'matches_requested' | 'contradicts_requested' | 'unanswered' | 'unknown';

export interface RejectVerificationSignal {
  family: VerificationEvidenceFamily;
  rank: VerificationEvidenceRank;
  relation: RequestedActionRelation;
  /** Epoch milliseconds captured by the evidence layer; raw page state is never retained here. */
  observed_at: number;
  /** Only authoritative semantic state can turn a contradiction into NOT_VERIFIED. */
  authoritative?: boolean;
}

export interface RejectVerificationInput {
  requested_action: ConsentActionType;
  action_timestamp: number;
  signals: readonly RejectVerificationSignal[];
  /** A navigation can destroy the before/after state needed for a semantic conclusion. */
  navigation_interrupted?: boolean;
}

export interface RejectVerificationResult extends VerificationResult {
  strong_evidence: VerificationEvidenceFamily[];
  corroborating_evidence: VerificationEvidenceFamily[];
}

function isPostAction(signal: RejectVerificationSignal, actionTimestamp: number) {
  return Number.isFinite(signal.observed_at) && signal.observed_at >= actionTimestamp;
}

function uniqueFamilies(signals: readonly RejectVerificationSignal[]) {
  return [...new Set(signals.map((signal) => signal.family))].sort();
}

function evidenceLabels(signals: readonly RejectVerificationSignal[]) {
  return signals.map((signal) => `${signal.rank}:${signal.family}:${signal.relation}`);
}

function result(
  status: VerificationResult['status'],
  signals: readonly RejectVerificationSignal[],
  reasonCodes: ConsentAuditCode[],
  strongEvidence: readonly RejectVerificationSignal[] = [],
  corroboratingEvidence: readonly RejectVerificationSignal[] = []
): RejectVerificationResult {
  return {
    status,
    evidence: evidenceLabels(signals),
    reason_codes: reasonCodes,
    strong_evidence: uniqueFamilies(strongEvidence),
    corroborating_evidence: uniqueFamilies(corroboratingEvidence)
  };
}

/**
 * Resolves post-action facts only. It never interprets clicks, banner removal,
 * or missing consent as a rejected decision. Adapters/framework observers are
 * responsible for assigning semantic relation to a normalized observation.
 */
export function verifyRequestedConsentAction(input: RejectVerificationInput): RejectVerificationResult {
  const postActionSignals = input.signals.filter((signal) => isPostAction(signal, input.action_timestamp));

  if (input.navigation_interrupted) {
    return result(
      'inconclusive',
      postActionSignals,
      [ConsentAuditCodes.NAVIGATION_INTERRUPTED, ConsentAuditCodes.ACTION_INCONCLUSIVE]
    );
  }

  const authoritativeContradictions = postActionSignals.filter(
    (signal) => signal.rank === 'strong' && signal.authoritative === true && signal.relation === 'contradicts_requested'
  );
  if (authoritativeContradictions.length) {
    return result(
      'not_verified',
      postActionSignals,
      [ConsentAuditCodes.ACTION_NOT_VERIFIED, ConsentAuditCodes.STATE_CONTRADICTION],
      [],
      authoritativeContradictions
    );
  }

  const strongContradictions = postActionSignals.filter(
    (signal) => signal.rank === 'strong' && signal.relation === 'contradicts_requested'
  );
  if (strongContradictions.length) {
    return result(
      'inconclusive',
      postActionSignals,
      [ConsentAuditCodes.STATE_CONTRADICTION, ConsentAuditCodes.ACTION_INCONCLUSIVE],
      [],
      strongContradictions
    );
  }

  const matchingStrong = postActionSignals.filter(
    (signal) => signal.rank === 'strong' && signal.relation === 'matches_requested'
  );
  const matchingCorroboration = postActionSignals.filter(
    (signal) => (signal.rank === 'strong' || signal.rank === 'supporting') && signal.relation === 'matches_requested'
  );
  const strongFamilies = new Set(matchingStrong.map((signal) => signal.family));
  const independentlyCorroborated = matchingStrong.filter((signal) =>
    matchingCorroboration.some((other) => other !== signal && other.family !== signal.family)
  );

  if (strongFamilies.size >= 2 || independentlyCorroborated.length) {
    const corroboration = matchingCorroboration.filter((signal) =>
      matchingStrong.some((strong) => strong.family !== signal.family)
    );
    return result(
      'verified',
      postActionSignals,
      [ConsentAuditCodes.ACTION_VERIFIED],
      matchingStrong,
      corroboration
    );
  }

  return result(
    'inconclusive',
    postActionSignals,
    [ConsentAuditCodes.ACTION_INCONCLUSIVE],
    matchingStrong,
    matchingCorroboration.filter((signal) => signal.rank === 'supporting')
  );
}
