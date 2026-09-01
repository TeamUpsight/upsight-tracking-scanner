import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  detectDidomi,
  didomiActionInventory,
  didomiAdapter,
  didomiBannerState,
  didomiConsentState,
  didomiPersistenceEvidence,
  didomiProviderEvidence,
  didomiVerificationContribution
} from './didomi-adapter';
import { ConsentAuditCodes } from './domain-types';

describe('Didomi adapter fixtures', () => {
  it('DI-01 detects Didomi only from independent Didomi-specific families', () => {
    const context = {
      window_globals: ['Didomi', 'didomiOnReady', 'didomiConfig'],
      asset_urls: ['https://sdk.privacy-center.org/loader.js'],
      surfaces: [{ selector: '#didomi-host', visible: true }]
    };

    expect(detectDidomi(context)).toEqual({
      status: 'detected', evidence: ['provider_asset', 'provider_root', 'typed_provider_api'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    });
    expect(cmpAdapterRegistry.get('didomi')).toBe(didomiAdapter);
  });

  it('DI-02 executes a visible direct Didomi Reject control', async () => {
    const calls: string[] = [];
    const context = {
      controls: [{ id: 'didomi-notice-disagree', semantic_action: 'reject_all' as const, origin: 'provider_selector' as const, visible: true, enabled: true, actionable: true, within_confirmed_didomi_surface: true }],
      invoke_control: async (id: string) => { calls.push(id); return true; }
    };

    expect(didomiActionInventory(context)).toMatchObject({ user_facing_reject_available: true, provider_api_reject_available: false });
    expect(await didomiAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { origin: 'provider_selector', outcome: 'executed' } });
    expect(calls).toEqual(['didomi-notice-disagree']);
  });

  it('DI-03 exposes provider API Reject without claiming a visible Reject button', async () => {
    const calls: string[] = [];
    const context = {
      public_methods: ['setUserDisagreeToAll'],
      invoke_public_method: async (method: 'setUserDisagreeToAll') => { calls.push(method); return true; }
    };
    const inventory = didomiActionInventory(context);

    expect(inventory).toMatchObject({ user_facing_reject_available: false, provider_api_reject_available: true });
    expect(inventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'api_only' });
    expect(await didomiAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { origin: 'provider_api', outcome: 'executed' } });
    expect(calls).toEqual(['setUserDisagreeToAll']);
  });

  it('DI-04 describes Reject as preferences-only when no first-layer Reject is visible', () => {
    const inventory = didomiActionInventory({
      controls: [{ id: 'didomi-preferences', semantic_action: 'open_preferences', origin: 'semantic_ui', visible: true, enabled: true, actionable: true, within_confirmed_didomi_surface: true }]
    });

    expect(inventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({
      availability: 'preferences_only', reason_codes: [ConsentAuditCodes.REJECT_PREFERENCES_ONLY]
    });
  });

  it('DI-05 keeps Didomi events supporting and pairs consent.changed with a state read', () => {
    const context = {
      provider_events: ['consent.changed', 'preferences.clickdisagreetoall'],
      runtime: { current_user_status: { decision: 'rejected' as const }, notice_visible: false }
    };

    expect(didomiVerificationContribution(context)).toEqual({
      strong: ['didomi_state_read_after_consent_changed'],
      supporting: ['didomi_event_observed', 'didomi_current_user_status_read']
    });
  });

  it('DI-06 reads a safe provider state summary without vendor or purpose identifiers', () => {
    const state = didomiConsentState({
      public_methods: ['getCurrentUserStatus'],
      runtime: { current_user_status: { decision: 'partial', enabled_purpose_count: 2, disabled_purpose_count: 1 }, notice_visible: null }
    });

    expect(state).toEqual({ decision: 'partial', categories: [], evidence: ['didomi_current_user_status_api_available', 'didomi_current_user_status_read'], reason_codes: [] });
    expect(JSON.stringify(state)).not.toContain('purposeId');
  });

  it('DI-07 observes Didomi persistence names without retaining values', () => {
    const persistence = didomiPersistenceEvidence({
      storage: [{ key_name: 'didomi_token', exists: true, value_length: 200 }, { key_name: 'didomi_dcs', exists: true, value_length: 300 }]
    });

    expect(persistence).toEqual({
      status: 'inconclusive', evidence: ['didomi_persistence_key:didomi_token', 'didomi_persistence_key:didomi_dcs'], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
    });
  });

  it('DI-08 keeps TCF framework evidence out of Didomi attribution', () => {
    const context = { tcf_active: true };

    expect(didomiProviderEvidence(context)).toEqual([]);
    expect(detectDidomi(context)).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
    expect(didomiConsentState(context).evidence).toEqual(['tcf_framework_active']);
  });

  it('DI-09 keeps detected Didomi separate from a hidden banner', () => {
    const context = {
      window_globals: ['Didomi'], asset_urls: ['https://sdk.privacy-center.org/loader.js'],
      surfaces: [{ selector: '#didomi-notice', visible: false }]
    };

    expect(detectDidomi(context).status).toBe('detected');
    expect(didomiBannerState(context)).toMatchObject({ surface: 'none', visibility: 'not_visible', reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] });
  });
});
