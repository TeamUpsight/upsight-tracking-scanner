import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  cookieYesActionInventory,
  cookieYesAdapter,
  cookieYesBannerState,
  cookieYesConsentState,
  cookieYesPersistenceEvidence,
  cookieYesProviderEvidence,
  cookieYesVerificationContribution,
  detectCookieYes
} from './cookieyes-adapter';
import { ConsentAuditCodes } from './domain-types';

describe('CookieYes adapter fixtures', () => {
  it('CY-01 detects CookieYes from independent provider-specific evidence', () => {
    const context = {
      runtime_functions: ['performBannerAction'],
      asset_urls: ['https://cdn-cookieyes.com/client_data/site-key/script.js'],
      surfaces: [{ selector: '.cky-consent-container', visible: true }]
    };

    expect(detectCookieYes(context)).toEqual({
      status: 'detected', evidence: ['provider_asset', 'provider_root', 'typed_provider_api'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    });
    expect(cmpAdapterRegistry.get('cookieyes')).toBe(cookieYesAdapter);
  });

  it('CY-02 executes direct Reject UI only inside the identified CookieYes surface', async () => {
    const calls: string[] = [];
    const context = {
      controls: [{ selector: '.cky-btn-reject', visible: true, enabled: true, actionable: true, within_confirmed_cookieyes_surface: true }],
      invoke_control: async (selector: string) => { calls.push(selector); return true; }
    };

    expect(cookieYesActionInventory(context)).toMatchObject({ user_facing_reject_available: true });
    expect(await cookieYesAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { origin: 'provider_selector', outcome: 'executed' } });
    expect(calls).toEqual(['.cky-btn-reject']);
    expect(cookieYesActionInventory({ controls: [{ selector: '.cky-btn-reject', visible: true, enabled: true, actionable: true, within_confirmed_cookieyes_surface: false }] }).user_facing_reject_available).toBe(false);
  });

  it('CY-03 executes documented API Reject without claiming a visible Reject button', async () => {
    const calls: string[] = [];
    const context = {
      runtime_functions: ['performBannerAction'],
      invoke_public_action: async (action: 'reject') => { calls.push(action); return true; }
    };
    const inventory = cookieYesActionInventory(context);

    expect(inventory).toMatchObject({ user_facing_reject_available: false, provider_api_reject_available: true });
    expect(inventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'api_only' });
    expect(await cookieYesAdapter.reject?.({ context })).toMatchObject({ status: 'completed', value: { origin: 'provider_api', outcome: 'executed' } });
    expect(calls).toEqual(['reject']);
  });

  it('CY-04 derives rejected state from getCkyConsent categories', () => {
    expect(cookieYesConsentState({
      runtime_functions: ['getCkyConsent'],
      consent: { categories: { necessary: true, analytics: false, advertisement: false, functional: false, performance: false }, is_user_action_completed: true }
    })).toMatchObject({
      decision: 'rejected',
      categories: expect.arrayContaining([
        expect.objectContaining({ category: 'marketing', decision: 'rejected' }),
        expect.objectContaining({ category: 'preferences', decision: 'rejected' })
      ])
    });
  });

  it('CY-05 normalizes a mixed CookieYes category state as partial', () => {
    const state = cookieYesConsentState({
      consent: { categories: { necessary: true, analytics: true, advertisement: false, functional: true, performance: false }, is_user_action_completed: true }
    });

    expect(state.decision).toBe('partial');
    expect(state.categories).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'analytics', decision: 'partial' }),
      expect.objectContaining({ category: 'marketing', decision: 'rejected' }),
      expect.objectContaining({ category: 'preferences', decision: 'accepted' })
    ]));
  });

  it('CY-06 exposes cookieyes-consent persistence descriptors without a raw value', () => {
    const persistence = cookieYesPersistenceEvidence({
      persistence: [{ name: 'cookieyes-consent', exists: true, value_length: 220, changed: true, post_reload_exists: true, post_reload_matches_after: true }]
    });

    expect(persistence).toEqual({
      status: 'confirmed',
      evidence: ['cookieyes_persistence_key_present', 'cookieyes_persistence_key_changed', 'cookieyes_persistence_key_present_after_reload'],
      reason_codes: [ConsentAuditCodes.PERSISTENCE_CONFIRMED]
    });
  });

  it('CY-07 keeps TCF evidence out of CookieYes provider attribution', () => {
    const context = { tcf_active: true };

    expect(cookieYesProviderEvidence(context)).toEqual([]);
    expect(detectCookieYes(context)).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
    expect(cookieYesConsentState(context).evidence).toEqual(['tcf_framework_active']);
  });

  it('CY-08 separates an identified provider from a hidden CookieYes banner', () => {
    const context = {
      runtime_functions: ['performBannerAction'], asset_urls: ['https://cdn-cookieyes.com/client_data/site-key/script.js'],
      surfaces: [{ selector: '.cky-consent-container', visible: false }]
    };

    expect(detectCookieYes(context).status).toBe('detected');
    expect(cookieYesBannerState(context)).toMatchObject({ surface: 'none', visibility: 'not_visible', reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] });
  });

  it('CY-09 never treats completed user action as Reject without rejected categories', () => {
    const context = {
      consent: { categories: { necessary: true, analytics: true, advertisement: true, functional: true, performance: true }, is_user_action_completed: true }
    };

    expect(cookieYesConsentState(context)).toMatchObject({ decision: 'accepted', evidence: ['cookieyes_get_cky_consent_read', 'cookieyes_user_action_completed'] });
    expect(cookieYesVerificationContribution(context)).toEqual({ strong: ['cookieyes_get_cky_consent_state'], supporting: ['cookieyes_user_action_completed'] });
  });
});
