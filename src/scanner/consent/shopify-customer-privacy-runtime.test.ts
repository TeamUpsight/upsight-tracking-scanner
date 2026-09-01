import { describe, expect, it } from 'vitest';
import { cmpAdapterRegistry, platformRuntimeRegistry } from './adapter-registry';
import {
  detectShopifyCustomerPrivacy,
  shopifyCustomerPrivacyAvailableActions,
  shopifyCustomerPrivacyBannerState,
  shopifyCustomerPrivacyMechanism,
  shopifyCustomerPrivacyRuntime,
  shopifyCustomerPrivacyState
} from './shopify-customer-privacy-runtime';
import { ConsentAuditCodes } from './domain-types';

const currentRuntime = {
  shopify_object_present: true,
  customer_privacy_object_present: true,
  runtime_methods: ['currentVisitorConsent', 'shouldShowBanner', 'analyticsProcessingAllowed', 'marketingAllowed', 'preferencesProcessingAllowed', 'saleOfDataAllowed', 'getRegion']
};

describe('Shopify Customer Privacy runtime fixtures', () => {
  it('SH-01 detects the verified current runtime only with expected read methods', () => {
    expect(detectShopifyCustomerPrivacy(currentRuntime)).toMatchObject({ status: 'detected', evidence: ['shopify_customer_privacy_object', 'shopify_customer_privacy_read_methods'] });
    expect(detectShopifyCustomerPrivacy({ shopify_object_present: true, customer_privacy_object_present: true })).toMatchObject({ status: 'inconclusive' });
    expect(platformRuntimeRegistry.get('shopify_customer_privacy')).toBe(shopifyCustomerPrivacyRuntime);
    expect(cmpAdapterRegistry.knownIds()).not.toContain('shopify_customer_privacy');
  });

  it('SH-02 preserves empty consent values as unanswered', () => {
    expect(shopifyCustomerPrivacyState({
      ...currentRuntime,
      visitor_consent: { analytics: '', marketing: '', preferences: '', sale_of_data: '' }
    })).toMatchObject({ decision: 'unanswered', categories: expect.arrayContaining([expect.objectContaining({ category: 'analytics', decision: 'unanswered' })]) });
  });

  it('SH-03 maps explicit yes values to granted state', () => {
    expect(shopifyCustomerPrivacyState({
      ...currentRuntime,
      visitor_consent: { analytics: 'yes', marketing: 'yes', preferences: 'yes', sale_of_data: 'yes' },
      processing_allowed: { analytics: true, marketing: true, preferences: true, sale_of_data: true }
    })).toMatchObject({ decision: 'accepted', categories: expect.arrayContaining([expect.objectContaining({ category: 'marketing', decision: 'accepted' })]) });
  });

  it('SH-04 maps explicit no values to denied state', () => {
    expect(shopifyCustomerPrivacyState({
      ...currentRuntime,
      visitor_consent: { analytics: 'no', marketing: 'no', preferences: 'no', sale_of_data: 'no' }
    })).toMatchObject({ decision: 'rejected', categories: expect.arrayContaining([expect.objectContaining({ category: 'sale_or_share', decision: 'rejected' })]) });
  });

  it('SH-05 treats shouldShowBanner false as native applicability, not CMP identity', () => {
    expect(shopifyCustomerPrivacyBannerState({ ...currentRuntime, should_show_banner: false })).toEqual({
      surface: 'none', visibility: 'not_visible', evidence: ['shopify_should_show_banner_false'], reason_codes: [ConsentAuditCodes.BANNER_NOT_VISIBLE]
    });
  });

  it('SH-06 exposes runtime-confirmed visible native semantic controls without enabling interaction', () => {
    const context = { ...currentRuntime, native_surface: { visible: true, confirmed_by_runtime: true, semantic_actions: ['reject_all', 'open_preferences'] as const } };

    expect(shopifyCustomerPrivacyBannerState(context)).toMatchObject({ surface: 'banner', visibility: 'visible' });
    expect(shopifyCustomerPrivacyAvailableActions(context).find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'direct' });
    expect(shopifyCustomerPrivacyRuntime.accept).toBeUndefined();
    expect(shopifyCustomerPrivacyRuntime.reject).toBeUndefined();
  });

  it('SH-07 keeps Shopify Customer Privacy separate when OneTrust is also present', () => {
    const mechanism = shopifyCustomerPrivacyMechanism(currentRuntime);

    expect(mechanism).toMatchObject({ mechanism: 'commerce_privacy_runtime', provider: { candidates: [expect.objectContaining({ provider_name: 'shopify' })] } });
    expect(mechanism.mechanism).not.toBe('cmp');
  });

  it('SH-08 remains a separate runtime alongside an unknown custom CMP', () => {
    const mechanism = shopifyCustomerPrivacyMechanism(currentRuntime);

    expect(mechanism.provider?.attribution).toBe('identified');
    expect(mechanism.provider?.candidates[0].provider_name).toBe('shopify');
  });

  it('SH-09 retains legacy trackingConsent only as supporting/inconclusive evidence', () => {
    expect(detectShopifyCustomerPrivacy({ legacy_tracking_consent_present: true })).toEqual({
      status: 'inconclusive', evidence: ['shopify_tracking_consent_legacy'], reason_codes: [ConsentAuditCodes.DETECTION_INCONCLUSIVE]
    });
  });
});
