import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  detectUsercentrics,
  usercentricsActionInventory,
  usercentricsAdapter,
  usercentricsBannerState,
  usercentricsConsentState,
  usercentricsPersistenceEvidence,
  usercentricsProviderEvidence,
  usercentricsStateContribution,
  usercentricsVerificationContribution
} from './usercentrics-adapter';
import { ConsentAuditCodes } from './domain-types';

describe('Usercentrics adapter fixtures', () => {
  it('UC-01 detects the current Usercentrics bundle from independent provider-specific families', () => {
    const context = {
      uc_ui_type: 'object' as const,
      asset_urls: ['https://web.cmp.usercentrics.eu/ui/loader.js'],
      surfaces: [{ selector: 'aside#usercentrics-cmp-ui', visible: true, shadow_mode: 'open' as const }]
    };

    expect(detectUsercentrics(context)).toEqual({
      status: 'detected',
      evidence: ['provider_asset', 'provider_root', 'typed_provider_api'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    });
    expect(cmpAdapterRegistry.get('usercentrics')).toBe(usercentricsAdapter);
  });

  it('UC-02 represents the verified open shadow-root UI without custom shadow traversal', () => {
    expect(usercentricsBannerState({
      surfaces: [{ selector: 'aside#usercentrics-cmp-ui', visible: true, shadow_mode: 'open' }]
    })).toEqual({
      surface: 'dialog', visibility: 'visible', evidence: ['usercentrics_standard_root', 'open_shadow_root'], reason_codes: [ConsentAuditCodes.BANNER_VISIBLE]
    });
  });

  it('UC-03 discovers and executes a direct semantic Reject only within the confirmed surface', async () => {
    const calls: string[] = [];
    const context = {
      controls: [{ id: 'semantic-reject', semantic_action: 'reject_all' as const, visible: true, enabled: true, actionable: true, within_confirmed_usercentrics_surface: true, role: 'button' as const }],
      invoke_control: async (id: string) => { calls.push(id); return true; }
    };

    expect(usercentricsActionInventory(context)).toMatchObject({ user_facing_reject_available: true, provider_api_reject_available: false });
    expect(await usercentricsAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { origin: 'semantic_ui', outcome: 'executed' } });
    expect(calls).toEqual(['semantic-reject']);
  });

  it('UC-04 relies on localized semantic action output rather than a localized label', () => {
    const inventory = usercentricsActionInventory({
      controls: [{ id: 'localized-preferences', semantic_action: 'open_preferences', visible: true, enabled: true, actionable: true, within_confirmed_usercentrics_surface: true, role: 'button', locale: 'de' }]
    });

    expect(inventory.actions.find((action) => action.action === 'open_preferences')).toMatchObject({ availability: 'direct' });
    expect(inventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'preferences_only' });
  });

  it('UC-05 retains ucData changes as privacy-safe supporting persistence evidence', () => {
    const context = { storage: [{ key_name: 'ucData' as const, before_exists: false, after_exists: true, changed: true }] };

    expect(usercentricsPersistenceEvidence(context)).toEqual({ status: 'inconclusive', evidence: ['usercentrics_uc_data_changed'], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
    expect(usercentricsVerificationContribution(context)).toEqual({ strong: [], supporting: ['usercentrics_uc_data_changed'] });
  });

  it('UC-06 retains ucString changes as privacy-safe supporting persistence evidence', () => {
    expect(usercentricsPersistenceEvidence({ storage: [{ key_name: 'ucString', changed: true }] })).toEqual({
      status: 'inconclusive', evidence: ['usercentrics_uc_string_changed'], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
    });
  });

  it('UC-07 confirms persistence only from metadata continuity across reload', () => {
    const persistence = usercentricsPersistenceEvidence({
      storage: [{ key_name: 'ucData', changed: true, post_reload_exists: true, post_reload_matches_after: true }]
    });

    expect(persistence).toEqual({
      status: 'confirmed', evidence: ['usercentrics_uc_data_changed', 'usercentrics_uc_data_present_after_reload'], reason_codes: [ConsentAuditCodes.PERSISTENCE_CONFIRMED]
    });
  });

  it('UC-08 keeps UC_UI API interaction disabled even when observed methods exist', async () => {
    const result = await usercentricsAdapter.reject?.({
      context: { uc_ui_type: 'object', observed_uc_ui_methods: ['acceptAllConsents', 'denyAllConsents'] }
    });

    expect(usercentricsAdapter.metadata.public_api_interaction_support).toBe(false);
    expect(result).toEqual({ status: 'unsupported', value: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED] });
  });

  it('UC-09 leaves TCF and GPP to framework observers rather than provider attribution', () => {
    const context = { tcf_active: true, gpp_active: true };

    expect(usercentricsProviderEvidence(context)).toEqual([]);
    expect(detectUsercentrics(context)).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
    expect(usercentricsConsentState(context).evidence).toEqual(['tcf_framework_active', 'gpp_framework_active']);
  });

  it('UC-10 keeps a detected provider separate from a hidden or absent banner', () => {
    const context = {
      uc_ui_type: 'object' as const,
      asset_urls: ['https://web.cmp.usercentrics.eu/ui/loader.js'],
      surfaces: [{ selector: 'aside#usercentrics-cmp-ui', visible: false, shadow_mode: 'open' as const }]
    };

    expect(detectUsercentrics(context).status).toBe('detected');
    expect(usercentricsBannerState(context)).toMatchObject({ surface: 'none', visibility: 'not_visible', reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] });
  });

  it('uses safe semantic state separately from framework and persistence contributions', () => {
    const context = {
      safe_provider_state: { decision: 'rejected' as const },
      tcf_active: true,
      storage: [{ key_name: 'ucString' as const, changed: true }]
    };

    expect(usercentricsStateContribution(context)).toMatchObject({ provider_state: { decision: 'rejected' }, framework_context: ['tcf_framework_active'] });
    expect(usercentricsVerificationContribution(context)).toEqual({ strong: ['usercentrics_safe_provider_state'], supporting: ['usercentrics_uc_string_changed'] });
  });
});
