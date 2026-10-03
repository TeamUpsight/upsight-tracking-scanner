import { describe, expect, it } from 'vitest';
import type { Confidence, EvidenceBundle } from '../../types';
import { resolveProjectedConsentProvider } from './provider-projection';

type ProviderConclusion = Pick<EvidenceBundle['consent'], 'resolved_provider' | 'resolved_provider_confidence' | 'resolved_provider_evidence'>;
const earned = (confidence: Confidence = 'medium'): ProviderConclusion => ({
  resolved_provider: 'Not Found', resolved_provider_confidence: confidence,
  resolved_provider_evidence: ['NO_CMP_DETECTED', 'PERSISTENCE_NOT_APPLICABLE']
});
const providerless = { provider: null, provider_conflict: false } as const;

describe('earned CMP absence projection', () => {
  it.each(['low', 'medium', 'high'] as const)('preserves earned absence and existing %s confidence through repeated providerless finalization', (confidence) => {
    const before = earned(confidence);
    const projected = resolveProjectedConsentProvider(before, providerless);
    expect(projected).toEqual(before);
    expect(resolveProjectedConsentProvider(projected, providerless)).toEqual(before);
  });

  it('does not assign confidence when the authoritative absence has none', () => {
    const before = { resolved_provider: 'Not Found' as const, resolved_provider_evidence: ['NO_CMP_DETECTED'] };
    expect(resolveProjectedConsentProvider(before, providerless)).toEqual(before);
  });

  it.each(['OneTrust', 'Cookiebot'] as const)('%s replaces absence and removes only stale absence evidence', (provider) => {
    expect(resolveProjectedConsentProvider(earned(), { provider, provider_conflict: false })).toEqual({
      resolved_provider: provider, resolved_provider_confidence: 'high', resolved_provider_evidence: ['PERSISTENCE_NOT_APPLICABLE']
    });
  });

  it('generic/custom Unknown replaces absence at medium confidence', () => {
    expect(resolveProjectedConsentProvider(earned(), { provider: 'Unknown', provider_conflict: false })).toEqual({
      resolved_provider: 'Unknown', resolved_provider_confidence: 'medium',
      resolved_provider_evidence: ['PERSISTENCE_NOT_APPLICABLE', 'CMP_PROVIDER_UNKNOWN']
    });
  });

  it('a provider conflict clears absence and retains the conservative conflict code', () => {
    expect(resolveProjectedConsentProvider(earned('high'), { provider: null, provider_conflict: true })).toEqual({
      resolved_provider: null, resolved_provider_confidence: 'low', resolved_provider_evidence: ['PERSISTENCE_NOT_APPLICABLE', 'PROVIDER_CONFLICT']
    });
  });

  it('does not protect Not Found without NO_CMP_DETECTED', () => {
    expect(resolveProjectedConsentProvider({ ...earned(), resolved_provider_evidence: [] }, providerless)).toEqual({
      resolved_provider: null, resolved_provider_confidence: 'low', resolved_provider_evidence: []
    });
  });

  it.each([{ codes: [] }, { codes: ['NO_CMP_DETECTED'] }])('does not manufacture absence from null, even with codes $codes', ({ codes }) => {
    expect(resolveProjectedConsentProvider({ resolved_provider: null, resolved_provider_evidence: codes }, providerless)).toEqual({
      resolved_provider: null, resolved_provider_confidence: 'low', resolved_provider_evidence: []
    });
  });
});
