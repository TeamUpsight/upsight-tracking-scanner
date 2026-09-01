import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  detectSourcepoint,
  sourcepointActionInventory,
  sourcepointAdapter,
  sourcepointBannerState,
  sourcepointConsentState,
  sourcepointPersistenceEvidence,
  sourcepointProviderEvidence,
  sourcepointVerificationContribution
} from './sourcepoint-adapter';
import { ConsentAuditCodes } from './domain-types';

const firstLayerReject = {
  action_class: 'sp_choice_type_13' as const, surface: 'first_layer' as const, frame_path: ['top', 'sp_message_iframe'],
  frame_attached: true, visible: true, enabled: true, actionable: true, within_confirmed_sourcepoint_surface: true
};

describe('Sourcepoint adapter fixtures', () => {
  it('SP-01 detects Sourcepoint from its runtime, CDN, and message surface', () => {
    const context = {
      window_globals: ['_sp_', '_sp_queue'], asset_urls: ['https://cdn.privacy-mgmt.com/wrapper/v2/messaging.js'],
      surfaces: [{ selector: 'sp_message_iframe_123', surface: 'first_layer' as const, frame_path: ['top', 'sp_message_iframe'], frame_attached: true, visible: true }]
    };

    expect(detectSourcepoint(context)).toEqual({
      status: 'detected', evidence: ['provider_asset', 'provider_root', 'typed_provider_api'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    });
    expect(cmpAdapterRegistry.get('sourcepoint')).toBe(sourcepointAdapter);
  });

  it('SP-02 represents a visible first-layer iframe with its safe frame path', () => {
    expect(sourcepointBannerState({
      surfaces: [{ selector: 'sp_message_iframe_123', surface: 'first_layer', frame_path: ['top', 'sp_message_iframe'], frame_attached: true, visible: true }]
    })).toMatchObject({ surface: 'dialog', visibility: 'visible', reason_codes: [ConsentAuditCodes.BANNER_VISIBLE] });
  });

  it('SP-03 executes the documented first-layer Reject class in a Playwright frame', async () => {
    const calls: string[] = [];
    const context = {
      active_surface: 'first_layer' as const, controls: [firstLayerReject],
      invoke_control: async (actionClass: string, framePath: readonly string[]) => { calls.push(`${actionClass}:${framePath.join('/')}`); return true; }
    };

    expect(await sourcepointAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { origin: 'provider_selector', outcome: 'executed' } });
    expect(calls).toEqual(['sp_choice_type_13:top/sp_message_iframe']);
  });

  it('SP-04 opens Privacy Manager only through the first-layer action class', async () => {
    const calls: string[] = [];
    const context = {
      active_surface: 'first_layer' as const,
      controls: [{ ...firstLayerReject, action_class: 'sp_choice_type_12' as const }],
      invoke_control: async (actionClass: string) => { calls.push(actionClass); return true; }
    };

    expect(await sourcepointAdapter.openPreferences?.({ context })).toMatchObject({ status: 'completed', value: { action: 'open_preferences' } });
    expect(calls).toEqual(['sp_choice_type_12']);
  });

  it('SP-05 executes Privacy Manager Reject without mixing it with numeric first-layer classes', async () => {
    const calls: string[] = [];
    const context = {
      active_surface: 'privacy_manager' as const,
      controls: [{ ...firstLayerReject, action_class: 'sp_choice_type_REJECT_ALL' as const, surface: 'privacy_manager' as const }],
      invoke_control: async (actionClass: string) => { calls.push(actionClass); return true; }
    };

    expect(await sourcepointAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { action: 'reject_all' } });
    expect(calls).toEqual(['sp_choice_type_REJECT_ALL']);
  });

  it('SP-06 executes Privacy Manager Save and Exit only on its own surface', async () => {
    const context = {
      active_surface: 'privacy_manager' as const,
      controls: [{ ...firstLayerReject, action_class: 'sp_choice_type_SAVE_AND_EXIT' as const, surface: 'privacy_manager' as const }],
      invoke_control: async () => true
    };

    expect(await sourcepointAdapter.savePreferences?.({ context })).toMatchObject({ status: 'completed', value: { action: 'save_preferences' } });
  });

  it('SP-07 keeps TCF useractioncomplete supporting until the shared resolver reports purpose and vendor state', () => {
    const eventOnly = { framework: { tcf_present: true, tcf_event_status: 'useractioncomplete' as const } };
    const paired = { framework: { tcf_present: true, tcf_event_status: 'useractioncomplete' as const, tcf_purpose_decision: 'rejected' as const, tcf_vendor_decision: 'rejected' as const } };

    expect(sourcepointVerificationContribution(eventOnly)).toEqual({ strong: [], supporting: ['tcf_useractioncomplete'] });
    expect(sourcepointVerificationContribution(paired)).toEqual({ strong: ['sourcepoint_tcf_rejection_state_after_user_action'], supporting: ['tcf_useractioncomplete', 'tcf_semantic_state_read'] });
    expect(sourcepointConsentState(paired).decision).toBe('rejected');
  });

  it('SP-08 observes Sourcepoint persistence metadata without raw values', () => {
    expect(sourcepointPersistenceEvidence({
      storage: [{ key_name: '_sp_user_consent_sanitized', storage_type: 'local_storage', exists: true, value_length: 240, changed: true, post_reload_exists: true, post_reload_matches_after: true }]
    })).toEqual({
      status: 'confirmed', evidence: ['sourcepoint_persistence_key_present', 'sourcepoint_persistence_key_changed', 'sourcepoint_persistence_key_present_after_reload'], reason_codes: [ConsentAuditCodes.PERSISTENCE_CONFIRMED]
    });
  });

  it('SP-09 treats a detached iframe as a diagnostic, never a missing CMP', () => {
    expect(sourcepointBannerState({
      surfaces: [{ selector: 'sp_message_iframe_123', surface: 'first_layer', frame_path: ['top'], frame_attached: false, visible: false }]
    })).toMatchObject({ visibility: 'unknown', reason_codes: [ConsentAuditCodes.CROSS_ORIGIN_FRAME_ERROR, ConsentAuditCodes.BANNER_VISIBILITY_UNKNOWN] });
  });

  it('SP-10 exposes a missing Privacy Manager configuration as a limitation', async () => {
    const context = { active_surface: 'first_layer' as const, privacy_manager_configuration_available: false };

    expect(sourcepointActionInventory(context)).toMatchObject({ limitations: ['privacy_manager_configuration_unavailable'] });
    expect(await sourcepointAdapter.openPreferences?.({ context })).toEqual({ status: 'unsupported', value: null, reason_codes: [ConsentAuditCodes.ACTION_NOT_EXPOSED] });
  });

  it('SP-11 retains GPP as framework context, never Sourcepoint identification', () => {
    const context = { framework: { gpp_present: true } };

    expect(sourcepointProviderEvidence(context)).toEqual([]);
    expect(detectSourcepoint(context)).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
    expect(sourcepointConsentState(context).evidence).toEqual(['gpp_framework_active']);
  });

  it('SP-12 accepts DNS-verified Sourcepoint CNAME evidence as one provider-specific family', () => {
    const context = {
      window_globals: ['_sp_'], asset_urls: ['https://cdn.privacy-mgmt.com/wrapper/v2/messaging.js'],
      surfaces: [{ selector: 'sp_message_container_123', surface: 'first_layer' as const, frame_path: ['top'], frame_attached: true, visible: true }],
      sourcepoint_cname_endpoint_verified: true
    };

    expect(sourcepointProviderEvidence(context).some((evidence) => evidence.family === 'provider_network')).toBe(true);
    expect(detectSourcepoint(context).status).toBe('detected');
  });
});
