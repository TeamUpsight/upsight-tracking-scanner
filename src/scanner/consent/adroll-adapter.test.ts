import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry } from './adapter-registry';
import {
  ADROLL_STANDARD_ROOT,
  adRollAdapter,
  adRollBannerState,
  adRollProviderEvidence,
  detectAdRoll,
  hasAdRollConsentAsset
} from './adroll-adapter';

describe('AdRoll Consent adapter', () => {
  it('identifies only the exact AdRoll Consent TCF v2 loader as deterministic evidence', () => {
    expect(hasAdRollConsentAsset(['https://s.adroll.com/j/consent_tcfv2.js?cache=1'])).toBe(true);
    expect(hasAdRollConsentAsset([
      'https://s.adroll.com/j/other.js',
      'https://s.adroll.com.evil.example/j/consent_tcfv2.js',
      'https://s.adroll.com/j/consent_tcfv2.js/extra'
    ])).toBe(false);
    expect(detectAdRoll({ asset_urls: ['https://s.adroll.com/j/consent_tcfv2.js'] })).toMatchObject({
      status: 'detected', evidence: ['provider_asset']
    });
  });

  it('records the exact runtime global without inspecting object contents', () => {
    expect(adRollProviderEvidence({ window_globals: ['__adroll_consent_banner'] })).toEqual([
      expect.objectContaining({
        provider_id: 'adroll', family: 'typed_provider_api',
        deterministic_provider_signature: true
      })
    ]);
  });

  it('keeps visible, hidden, and missing banner-root states distinct', () => {
    expect(adRollBannerState({ surface: { selector: ADROLL_STANDARD_ROOT, present: true, visible: true } })).toMatchObject({ visibility: 'visible' });
    expect(adRollBannerState({ surface: { selector: ADROLL_STANDARD_ROOT, present: true, visible: false } })).toMatchObject({ visibility: 'not_visible' });
    expect(adRollBannerState({ asset_urls: ['https://s.adroll.com/j/consent_tcfv2.js'] })).toMatchObject({ visibility: 'unknown' });
  });

  it('does not reinterpret TCF or GPP presence as AdRoll provider evidence', () => {
    expect(adRollProviderEvidence({ tcf_active: true, gpp_active: true })).toEqual([]);
    expect(detectAdRoll({ tcf_active: true, gpp_active: true })).toMatchObject({ status: 'not_detected' });
  });

  it('uses only a parsed AdRoll-banner decision as deterministic provider-network evidence', () => {
    expect(adRollProviderEvidence({ consent_decision: { parsed: true, banner_mode: 'adroll' } })).toEqual([
      expect.objectContaining({
        provider_id: 'adroll', family: 'provider_network', kind: 'provider_specific_network',
        deterministic_provider_signature: true
      })
    ]);
    expect(adRollProviderEvidence({ consent_decision: { parsed: false, banner_mode: 'adroll' } })).toEqual([]);
    expect(adRollProviderEvidence({ consent_decision: { parsed: true, banner_mode: 'none' } })).toEqual([]);
  });

  it('registers detection and banner observation while leaving every action unsupported', () => {
    expect(cmpAdapterRegistry.get('adroll')).toBe(adRollAdapter);
    expect(cmpAdapterRegistry.getCapability('adroll', 'detection').supported).toBe(true);
    expect(cmpAdapterRegistry.getCapability('adroll', 'banner_state').supported).toBe(true);
    for (const capability of ['available_actions', 'accept', 'reject', 'open_preferences', 'save_preferences'] as const) {
      expect(cmpAdapterRegistry.getCapability('adroll', capability).supported).toBe(false);
    }
    expect(adRollAdapter.accept).toBeUndefined();
    expect(adRollAdapter.reject).toBeUndefined();
    expect(adRollAdapter.openPreferences).toBeUndefined();
  });
});
