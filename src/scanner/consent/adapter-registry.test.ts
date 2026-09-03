import { describe, expect, it } from 'vitest';
import {
  CMP_ADAPTER_PROVIDER_IDS,
  ConsentAdapterRegistry,
  platformRuntimeRegistry,
  scoreProviderCandidates,
  type ConsentProviderAdapter
} from './adapter-registry';
import { ConsentAuditCodes } from './domain-types';

const fixtureMaturity = {
  detection: 'verified',
  state_read: 'supporting_only',
  banner_state: 'fixture_only',
  available_actions: 'verified',
  accept: 'verified',
  reject: 'verified',
  open_preferences: 'verified',
  save_preferences: 'unsupported',
  verify_action: 'supporting_only',
  persistence_evidence: 'unvalidated'
} as const;

const fixtureAdapter: ConsentProviderAdapter<'fixture'> = {
  metadata: {
    provider_id: 'fixture',
    adapter_version: '0.1.0',
    supported_runtime_variants: ['fixture_runtime'],
    supported_template_variants: [],
    regions: null,
    tcf_capable: false,
    gpp_capable: false,
    iframe_support: false,
    shadow_root_support: false,
    requires_trusted_user_gesture: false,
    public_api_interaction_support: false,
    stable_dom_interaction_support: true,
    preferences_flow_support: false,
    capability_maturity: fixtureMaturity
  },
  detect: () => ({ status: 'not_detected', evidence: [], reason_codes: [] }),
  reject: () => ({ status: 'completed', value: { action: 'reject_all', origin: 'semantic_ui', outcome: 'executed', category: null, reason_codes: [] }, reason_codes: [] })
};

describe('Consent adapter registry', () => {
  it('reserves only the planned provider ids and keeps Shopify in a separate runtime registry', () => {
    expect(CMP_ADAPTER_PROVIDER_IDS).toEqual(['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'cookieyes', 'sourcepoint']);
    expect(platformRuntimeRegistry.knownIds()).toEqual(['shopify_customer_privacy']);
  });

  it('registers a test adapter and exposes maturity-aware capability checks', async () => {
    const registry = new ConsentAdapterRegistry<'fixture'>(['fixture']);
    registry.register(fixtureAdapter);

    expect(registry.getCapability('fixture', 'reject')).toEqual({ supported: true, maturity: 'verified', reason_codes: [] });
    expect(registry.getCapability('fixture', 'save_preferences')).toEqual({
      supported: false, maturity: 'unsupported', reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED]
    });
    expect(await registry.invoke('fixture', 'save_preferences', {})).toEqual({
      status: 'unsupported', value: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED]
    });
  });

  it('returns explicit unsupported results when an adapter has not been registered', async () => {
    const registry = new ConsentAdapterRegistry<'fixture'>(['fixture']);

    expect(await registry.invoke('fixture', 'reject', {})).toEqual({
      status: 'unsupported', value: null, reason_codes: [ConsentAuditCodes.ADAPTER_NOT_READY]
    });
  });

  it('requires independent provider-specific evidence families for high confidence', () => {
    const candidates = scoreProviderCandidates([
      { provider_id: 'onetrust', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' },
      { provider_id: 'cookiebot', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'cookiebot', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' }
    ]);

    expect(candidates[0]).toMatchObject({ provider_id: 'onetrust', score: 95, independent_families: ['provider_asset', 'provider_root', 'typed_provider_api'], high_confidence: true, attribution: 'identified' });
    expect(candidates[1]).toMatchObject({ provider_id: 'cookiebot', score: 70, high_confidence: false });
  });

  it('does not let duplicate signals, TCF, GPP, or Consent Mode identify a provider', () => {
    const candidates = scoreProviderCandidates([
      { provider_id: 'onetrust', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'framework', kind: 'framework_signal', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'consent_mode', kind: 'consent_mode_signal', specificity: 'provider_specific' },
      { provider_id: null, family: 'framework', kind: 'framework_signal', specificity: 'framework_specific' }
    ]);

    expect(candidates).toEqual([expect.objectContaining({ provider_id: 'onetrust', score: 40, independent_families: ['typed_provider_api'], high_confidence: false })]);
  });

  it('requires a configurable score margin and rejects strong conflicting evidence', () => {
    const nearTie = scoreProviderCandidates([
      { provider_id: 'onetrust', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' },
      { provider_id: 'cookiebot', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'cookiebot', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' },
      { provider_id: 'cookiebot', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' }
    ]);
    const conflicted = scoreProviderCandidates([
      { provider_id: 'onetrust', family: 'typed_provider_api', kind: 'typed_documented_provider_api', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_root', kind: 'stable_provider_root', specificity: 'provider_specific' },
      { provider_id: 'onetrust', family: 'provider_asset', kind: 'unique_provider_script_or_config', specificity: 'provider_specific', polarity: 'conflicting' }
    ]);

    expect(nearTie[0]).toMatchObject({ score: 95, high_confidence: false, plausible_candidate: true, attribution: 'unknown_candidate' });
    expect(conflicted[0]).toMatchObject({ score: 95, conflict_score: 30, strong_conflict: true, attribution: 'inconclusive' });
  });
});
