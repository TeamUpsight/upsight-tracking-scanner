import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  cookiebotActionInventory,
  cookiebotAdapter,
  cookiebotBannerState,
  cookiebotConsentState,
  cookiebotPersistenceEvidence,
  cookiebotProviderEvidence,
  cookiebotVerificationContribution,
  detectCookiebot
} from './cookiebot-adapter';
import { ConsentAuditCodes } from './domain-types';

describe('Cookiebot adapter fixtures', () => {
  it('CB-01 detects Cookiebot from independent provider-specific families', () => {
    const context = {
      window_globals: ['Cookiebot'],
      asset_urls: ['https://consent.cookiebot.com/uc.js'],
      surfaces: [{ selector: '#CybotCookiebotDialog', visible: true }],
      data_cbid_present: true
    };

    expect(detectCookiebot(context)).toEqual({
      status: 'detected',
      evidence: ['provider_asset', 'provider_root', 'typed_provider_api'],
      reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_IDENTIFIED]
    });
    expect(cmpAdapterRegistry.get('cookiebot')).toBe(cookiebotAdapter);
  });

  it('CB-02 exposes and executes a stable direct decline control', async () => {
    const calls: string[] = [];
    const context = {
      controls: [{ id: '#CybotCookiebotDialogBodyButtonDecline', visible: true, enabled: true, actionable: true, within_confirmed_cookiebot_surface: true }],
      invoke_control: async (id: string) => { calls.push(id); return true; }
    };
    const result = await cookiebotAdapter.reject?.({ context });

    expect(cookiebotActionInventory(context)).toMatchObject({ user_facing_reject_available: true });
    expect(result).toMatchObject({ status: 'completed', value: { origin: 'provider_selector', outcome: 'executed' } });
    expect(calls).toEqual(['#CybotCookiebotDialogBodyButtonDecline']);
  });

  it('CB-03 retains Cookiebot decline events as supporting, not final verified, evidence', () => {
    const context = { provider_events: ['CookiebotOnDecline'] };

    expect(cookiebotConsentState(context)).toMatchObject({ decision: 'ambiguous', evidence: ['cookiebot_event_observed'] });
    expect(cookiebotVerificationContribution(context)).toEqual({ strong: [], supporting: ['cookiebot_event_observed'] });
  });

  it('reads Cookiebot readiness and semantic runtime state without a cookie fallback', () => {
    const state = cookiebotConsentState({
      runtime: {
        has_response: true, consented: false, declined: true,
        consent: { preferences: false, statistics: false, marketing: false }
      }
    });

    expect(state).toMatchObject({
      decision: 'rejected',
      categories: [
        { category: 'preferences', decision: 'rejected' },
        { category: 'analytics', decision: 'rejected' },
        { category: 'marketing', decision: 'rejected' }
      ]
    });
  });

  it('CB-04 supports safe semantic category rejection only inside a confirmed Cookiebot surface', () => {
    const inventory = cookiebotActionInventory({
      controls: [
        { id: 'tenant-toggle', visible: true, enabled: true, actionable: true, within_confirmed_cookiebot_surface: true, semantic_action: 'set_category', semantic_category: 'statistics' },
        { id: 'tenant-save', visible: true, enabled: true, actionable: true, within_confirmed_cookiebot_surface: true, semantic_action: 'save_preferences' }
      ]
    });

    expect(inventory.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'set_category', availability: 'direct', category: 'analytics' }),
      expect.objectContaining({ action: 'save_preferences', availability: 'direct' })
    ]));
  });

  it('CB-05 reports CookieConsent only as a persistence signal without the raw value', () => {
    const persistence = cookiebotPersistenceEvidence({ cookies: [{ name: 'CookieConsent', exists: true, value_length: 256 }] });

    expect(persistence).toEqual({ status: 'inconclusive', evidence: ['cookiebot_persistence_key_present'], reason_codes: [ConsentAuditCodes.PERSISTENCE_INCONCLUSIVE] });
  });

  it('CB-06 does not use absent TCF as Cookiebot detection evidence', () => {
    expect(detectCookiebot({ tcf_active: false })).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
  });

  it('CB-07 uses active TCF only as framework context, not provider evidence', () => {
    const context = { tcf_active: true, gpp_active: true, consent_mode_present: true };

    expect(cookiebotProviderEvidence(context)).toEqual([]);
    expect(detectCookiebot(context)).toEqual({ status: 'not_detected', evidence: [], reason_codes: [] });
    expect(cookiebotConsentState(context).evidence).toEqual(['tcf_framework_active', 'gpp_framework_active', 'consent_mode_present']);
  });

  it('CB-08 uses customized controls only after a confirmed Cookiebot surface check', async () => {
    const rejectedInventory = cookiebotActionInventory({
      controls: [{ id: 'custom-decline', visible: true, enabled: true, actionable: true, within_confirmed_cookiebot_surface: false, semantic_action: 'decline_all' }]
    });
    const calls: string[] = [];
    const context = {
      controls: [{ id: 'custom-decline', visible: true, enabled: true, actionable: true, within_confirmed_cookiebot_surface: true, semantic_action: 'decline_all' as const }],
      invoke_control: async (id: string) => { calls.push(id); return true; }
    };
    const result = await cookiebotAdapter.reject?.({ context });

    expect(rejectedInventory).toMatchObject({ user_facing_reject_available: false, preferences_flow_available: false });
    expect(rejectedInventory.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'not_present' });
    expect(result).toMatchObject({ status: 'completed', value: { origin: 'semantic_ui', outcome: 'executed' } });
    expect(calls).toEqual(['custom-decline']);
  });

  it('CB-09 keeps provider detection independent from a hidden Cookiebot banner', () => {
    const context = {
      window_globals: ['Cookiebot'], asset_urls: ['https://consent.cookiebot.com/uc.js'],
      surfaces: [{ selector: '#CybotCookiebotDialog', visible: false }]
    };

    expect(detectCookiebot(context).status).toBe('detected');
    expect(cookiebotBannerState(context)).toMatchObject({ surface: 'none', visibility: 'not_visible', reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE] });
  });
});
