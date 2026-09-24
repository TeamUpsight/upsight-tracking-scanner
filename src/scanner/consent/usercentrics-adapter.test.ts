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
  usercentricsVerificationContribution,
  usercentricsVerificationCapability
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

  it('UC-DETECTION-01 separates asset/runtime and asset/root identity from generic UI', () => {
    const asset_urls = ['https://app.usercentrics.eu/browser-ui/latest/loader.js'];
    expect(detectUsercentrics({ asset_urls, uc_ui_type: 'object' }).status).toBe('detected');
    expect(detectUsercentrics({ asset_urls, surfaces: [{ selector: 'aside#usercentrics-cmp-ui', present: true, visible: true, shadow_mode: 'open' }] }).status).toBe('detected');
    expect(detectUsercentrics({ generic_surfaces: [{ visible: true, privacy_or_cookie_semantics: true, intent: 'consent', strong_presentation: true }] }).status).toBe('not_detected');
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

  it('UC-07 keeps metadata continuity supporting until semantic persistence is proven', () => {
    const persistence = usercentricsPersistenceEvidence({
      storage: [{ key_name: 'ucData', changed: true, post_reload_exists: true, post_reload_matches_after: true }]
    });

    expect(persistence).toEqual({
      status: 'inconclusive', evidence: ['usercentrics_uc_data_changed', 'usercentrics_uc_data_present_after_reload'], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE]
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

  it('UC-LIFECYCLE-01 treats initialization and view transitions as readiness, not consent', () => {
    const base = { asset_urls: ['https://app.usercentrics.eu/browser-ui/latest/loader.js'],
      lifecycle: { initialized: true, latest_view: 'FIRST_LAYER' as const, latest_view_at_ms: 20, cmp_shown_observed: true, cmp_shown_at_ms: 10, event_count: 3 } };
    expect(usercentricsBannerState(base).visibility).toBe('visible');
    expect(usercentricsConsentState(base).decision).toBe('ambiguous');
    const afterViewChange = { ...base, lifecycle: { ...base.lifecycle, latest_view: 'NONE' as const, latest_view_at_ms: 30 } };
    expect(usercentricsBannerState(afterViewChange).visibility).toBe('not_visible');
    expect(usercentricsConsentState(afterViewChange).decision).toBe('ambiguous');
  });

  it('DET-PROVIDER-06 through DET-PROVIDER-08 preserve exact latest, versioned, and v3 Usercentrics loader signatures', () => {
    for (const loader of ['https://app.usercentrics.eu/browser-ui/latest/loader.js', 'https://app.usercentrics.eu/browser-ui/3.108.0/loader.js', 'https://web.cmp.usercentrics.eu/ui/loader.js']) {
      const candidate = usercentricsProviderEvidence({ asset_urls: [loader] });
      expect(candidate[0]).toMatchObject({ deterministic_provider_signature: true });
      expect(detectUsercentrics({ asset_urls: [loader] })).toMatchObject({ status: 'detected' });
    }
  });

  it('UC-V2-03 rejects Usercentrics-looking non-loader assets and generic TCF', () => {
    expect(detectUsercentrics({ asset_urls: ['https://example.com/usercentrics-helper.js'], tcf_active: true })).toMatchObject({ status: 'not_detected' });
  });

  it('ROOT-EVIDENCE-01 through ROOT-EVIDENCE-03 separate an absent, hidden, and visible root', () => {
    expect(usercentricsProviderEvidence({ surfaces: [{ selector: 'aside#usercentrics-cmp-ui', present: false, visible: false, shadow_mode: 'none' }] }).some((item) => item.family === 'provider_root')).toBe(false);
    expect(usercentricsProviderEvidence({ surfaces: [{ selector: 'aside#usercentrics-cmp-ui', present: true, visible: false, shadow_mode: 'none' }] }).some((item) => item.family === 'provider_root')).toBe(true);
    expect(usercentricsBannerState({ surfaces: [{ selector: 'aside#usercentrics-cmp-ui', present: true, visible: false, shadow_mode: 'none' }] }).visibility).toBe('not_visible');
    expect(usercentricsBannerState({ surfaces: [{ selector: 'aside#usercentrics-cmp-ui', present: true, visible: true, shadow_mode: 'open' }] }).visibility).toBe('visible');
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

  it('UC-CAPABILITY-01 requires two independent future semantic sources before a live action', () => {
    const runtimeOnly = { status: 'available' as const, strong_families: ['provider_state', 'provider_category_state'] as const, reason_codes: [] };
    expect(usercentricsVerificationCapability({ ...runtimeOnly, strong_families: [...runtimeOnly.strong_families] })).toMatchObject({ status: 'unavailable' });
    expect(usercentricsVerificationCapability({ status: 'available', strong_families: ['framework_tcf'], reason_codes: [] })).toMatchObject({ status: 'unavailable' });
    expect(usercentricsVerificationCapability({ status: 'available', strong_families: ['provider_state', 'provider_category_state', 'framework_tcf'], reason_codes: [] })).toMatchObject({ status: 'available' });
  });
});
