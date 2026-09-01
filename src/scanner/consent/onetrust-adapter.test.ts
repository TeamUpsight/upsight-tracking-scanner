import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  detectOneTrust,
  oneTrustActionInventory,
  oneTrustAdapter,
  oneTrustBannerState,
  oneTrustConsentState,
  oneTrustPersistenceEvidence,
  oneTrustProviderEvidence,
  oneTrustVerificationContribution
} from './onetrust-adapter';
import { ConsentAuditCodes } from './domain-types';

describe('OneTrust / Optanon adapter fixtures', () => {
  it('OT-01 identifies OneTrust only from independent provider-specific evidence', () => {
    const context = {
      window_globals: ['OneTrust'],
      asset_urls: ['https://cdn.cookielaw.org/scripttemplates/otSDKStub.js'],
      surfaces: [{ selector: '#onetrust-banner-sdk', visible: true }]
    };

    expect(detectOneTrust(context)).toEqual({
      status: 'detected',
      evidence: ['provider_asset', 'provider_root', 'typed_provider_api'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    });
    expect(cmpAdapterRegistry.get('onetrust')).toBe(oneTrustAdapter);
  });

  it('OT-02 exposes and executes a direct user-facing Reject independently from API capability', async () => {
    const calls: string[] = [];
    const context = {
      controls: [{ selector: '#onetrust-reject-all-handler', visible: true, enabled: true, actionable: true }],
      invoke_control: async (selector: string) => { calls.push(selector); return true; }
    };
    const inventory = oneTrustActionInventory(context);
    const result = await oneTrustAdapter.reject?.({ context });

    expect(inventory).toMatchObject({ user_facing_reject_available: true, provider_api_reject_available: false });
    expect(result).toMatchObject({ status: 'completed', value: { origin: 'provider_selector', outcome: 'executed' } });
    expect(calls).toEqual(['#onetrust-reject-all-handler']);
  });

  it('OT-03 exposes provider API Reject without claiming a user-facing Reject', async () => {
    const calls: string[] = [];
    const context = {
      public_methods: ['RejectAll'],
      invoke_public_method: async (method: string) => { calls.push(method); return true; }
    };
    const inventory = oneTrustActionInventory(context);
    const result = await oneTrustAdapter.reject?.({ context });

    expect(inventory).toMatchObject({ user_facing_reject_available: false, provider_api_reject_available: true });
    expect(inventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'api_only' });
    expect(result).toMatchObject({ status: 'completed', value: { origin: 'provider_api', outcome: 'executed' } });
    expect(calls).toEqual(['RejectAll']);
  });

  it('OT-04 marks Reject as preferences-only when only the documented preferences control is exposed', () => {
    const inventory = oneTrustActionInventory({
      controls: [{ selector: '#onetrust-pc-btn-handler', visible: true, enabled: true, actionable: true }]
    });

    expect(inventory).toMatchObject({ user_facing_reject_available: false, provider_api_reject_available: false });
    expect(inventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({
      availability: 'preferences_only', reason_codes: [ConsentAuditCodes.REJECT_PREFERENCES_ONLY]
    });
  });

  it('OT-05 returns semantic state evidence without retaining active group identifiers', () => {
    const state = oneTrustConsentState({
      active_group_ids: ['tenant-performance', 'tenant-advertising'],
      cookies: [{ name: 'OptanonConsent', exists: true, value_length: 120 }],
      provider_events: ['OneTrustGroupsUpdated']
    });

    expect(state).toMatchObject({ decision: 'ambiguous', categories: [], evidence: ['onetrust_active_group_count:2', 'optanon_consent_present', 'onetrust_state_event'] });
    expect(JSON.stringify(state)).not.toContain('tenant-performance');
  });

  it('OT-06 returns persistence evidence without a raw cookie value', () => {
    const persistence = oneTrustPersistenceEvidence({
      cookies: [{ name: 'OptanonConsent', exists: true, value_length: 180 }]
    });

    expect(persistence).toEqual({
      status: 'inconclusive', evidence: ['onetrust_persistence_key_present'], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
    });
  });

  it('OT-07 never turns OneTrust.Close into Reject', async () => {
    const context = { public_methods: ['Close'] };
    const inventory = oneTrustActionInventory(context);
    const result = await oneTrustAdapter.reject?.({ context });

    expect(inventory).toMatchObject({ user_facing_reject_available: false, provider_api_reject_available: false });
    expect(result).toEqual({ status: 'unsupported', value: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED] });
  });

  it('OT-08 and OT-09 keep TCF and GPP as state context, never provider detection evidence', () => {
    const frameworkOnly = { tcf_active: true, gpp_active: true };

    expect(detectOneTrust(frameworkOnly)).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
    expect(oneTrustProviderEvidence(frameworkOnly)).toEqual([]);
    expect(oneTrustConsentState(frameworkOnly).evidence).toEqual(['tcf_framework_active', 'gpp_framework_active']);
  });

  it('OT-10 does not hard-code custom category ids and offers only inconclusive verification contributions', () => {
    const context = {
      active_group_ids: ['a-custom-analytics-id', 'a-custom-marketing-id'],
      action_executed: true,
      provider_events: ['OTConsentApplied']
    };
    const contribution = oneTrustVerificationContribution(context);

    expect(contribution).toEqual({ strong: ['onetrust_documented_action_invoked'], supporting: ['onetrust_state_event', 'onetrust_active_group_shape'] });
    expect(JSON.stringify(contribution)).not.toContain('a-custom-analytics-id');
  });

  it('resolves visible OneTrust surfaces independently from provider detection', () => {
    expect(oneTrustBannerState({ surfaces: [{ selector: '#onetrust-banner-sdk', visible: true }] })).toMatchObject({
      surface: 'banner', visibility: 'visible', reason_codes: [ConsentAuditCodes.BANNER_VISIBLE]
    });
    expect(oneTrustBannerState({ surfaces: [{ selector: '#onetrust-banner-sdk', visible: false }] })).toMatchObject({
      visibility: 'not_visible', reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE]
    });
  });
});
