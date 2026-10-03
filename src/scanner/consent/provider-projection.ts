import type { CmpProvider, EvidenceBundle } from '../../types';
import { ConsentAuditCodes } from './domain-types';

type ProviderConclusion = Pick<EvidenceBundle['consent'],
  'resolved_provider' | 'resolved_provider_confidence' | 'resolved_provider_evidence'>;

/** Projects identity without treating a missing identity as a new absence decision. */
export function resolveProjectedConsentProvider(
  current: ProviderConclusion,
  projection: { provider: Exclude<CmpProvider, 'Not Found'> | null; provider_conflict: boolean }
): ProviderConclusion {
  const codes = current.resolved_provider_evidence || [];
  const withoutAbsence = codes.filter((code) => code !== ConsentAuditCodes.NO_CMP_DETECTED);
  if (projection.provider_conflict) {
    return {
      resolved_provider: null,
      resolved_provider_confidence: 'low',
      resolved_provider_evidence: [...new Set([...withoutAbsence, ConsentAuditCodes.PROVIDER_CONFLICT])]
    };
  }
  if (projection.provider) {
    return {
      resolved_provider: projection.provider,
      resolved_provider_confidence: projection.provider === 'Unknown' ? 'medium' : 'high',
      resolved_provider_evidence: [...new Set([
        ...withoutAbsence,
        ...(projection.provider === 'Unknown' ? [ConsentAuditCodes.CMP_PROVIDER_UNKNOWN] : [])
      ])]
    };
  }
  // Only the authoritative compatibility result can earn absence. A later
  // providerless (even incomplete) identity projection preserves that fact and
  // its existing confidence; it cannot manufacture or strengthen absence.
  if (current.resolved_provider === 'Not Found' && codes.includes(ConsentAuditCodes.NO_CMP_DETECTED)) {
    return { ...current, resolved_provider_evidence: [...codes] };
  }
  return { resolved_provider: null, resolved_provider_confidence: 'low', resolved_provider_evidence: withoutAbsence };
}
