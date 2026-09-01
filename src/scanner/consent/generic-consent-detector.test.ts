import { describe, expect, it } from 'vitest';
import { ConsentAuditCodes } from './domain-types';
import { detectGenericConsentMechanism, normalizeConsentActionLabel } from './generic-consent-detector';

const consentSurface = { id: 'consent-surface', surface_type: 'banner' as const, visible: true, privacy_or_cookie_semantics: true, intent: 'consent' as const };
const control = (semantic_action: 'accept_all' | 'reject_all' | 'only_necessary' | 'open_preferences' | 'save_preferences') => ({
  surface_id: 'consent-surface', visible: true, enabled: true, actionable: true, semantic_action
});

describe('generic custom consent mechanism fixtures', () => {
  it('detects a custom Accept/Reject banner as an unknown CMP without naming a provider', () => {
    const result = detectGenericConsentMechanism([consentSurface], [control('accept_all'), control('reject_all')]);

    expect(result).toMatchObject({ status: 'detected', reason_codes: [ConsentAuditCodes.CMP_DETECTED, ConsentAuditCodes.CMP_PROVIDER_UNKNOWN] });
    expect(result.mechanism).toMatchObject({ mechanism: 'custom', provider: { attribution: 'unknown_candidate' } });
    expect(result.action_plan).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'reject_all', origin: 'semantic_ui' })]));
  });

  it('detects a preferences-only banner without pretending first-layer Reject exists', () => {
    const result = detectGenericConsentMechanism([consentSurface], [control('accept_all'), control('open_preferences')]);

    expect(result.status).toBe('detected');
    expect(result.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'preferences_only' });
  });

  it('uses consent-shaped JSON cookie metadata only as corroboration, never a raw value', () => {
    const result = detectGenericConsentMechanism([consentSurface], [control('accept_all'), control('reject_all')], {
      storage: [{ storage_type: 'cookie', key_name: 'custom_consent', exists: true, consent_shaped: true, parsed_shape: 'json_object' }]
    });

    expect(result.corroborating_signals).toContain('consent_shaped_storage');
    expect(JSON.stringify(result)).not.toContain('value');
  });

  it('uses consent-shaped localStorage metadata only as corroboration', () => {
    const result = detectGenericConsentMechanism([consentSurface], [control('accept_all'), control('reject_all')], {
      storage: [{ storage_type: 'local_storage', key_name: 'privacy_settings', exists: true, consent_shaped: true, parsed_shape: 'delimited_categories' }]
    });

    expect(result.corroborating_signals).toContain('consent_shaped_storage');
  });

  it('does not identify a CMP from TCF-only unknown mechanism evidence', () => {
    expect(detectGenericConsentMechanism([], [], { tcf_present: true })).toMatchObject({
      status: 'not_detected', reason_codes: [ConsentAuditCodes.NO_CMP_DETECTED]
    });
  });

  it('does not identify a CMP from GPP-only evidence', () => {
    expect(detectGenericConsentMechanism([], [], { gpp_present: true })).toMatchObject({ status: 'not_detected' });
  });

  it('does not identify a CMP from manual Consent Mode/tag-gating evidence alone', () => {
    expect(detectGenericConsentMechanism([], [], { consent_mode_transition: true, manual_tag_gating_marker: true })).toMatchObject({ status: 'not_detected' });
  });

  it.each([
    ['privacy policy modal', 'privacy_policy_only'],
    ['newsletter', 'newsletter'],
    ['login', 'login'],
    ['age gate', 'age_gate'],
    ['country selector', 'country_selector']
  ] as const)('excludes %s even when it has generic action structure', (_name, intent) => {
    const result = detectGenericConsentMechanism([{ ...consentSurface, intent }], [control('accept_all'), control('reject_all')]);
    expect(result).toMatchObject({ status: 'not_detected', reason_codes: [ConsentAuditCodes.NO_CMP_DETECTED] });
  });

  it('does not treat a generic Accept button outside a confirmed consent surface as actionable', () => {
    const result = detectGenericConsentMechanism([
      { id: 'ordinary', surface_type: 'dialog', visible: true, privacy_or_cookie_semantics: false, intent: 'unknown' }
    ], [{ surface_id: 'ordinary', visible: true, enabled: true, actionable: true, accessible_name: 'Accept' }]);

    expect(result).toMatchObject({ status: 'not_detected', action_plan: [] });
  });

  it('normalizes labels before matching localized aliases within the confirmed surface', () => {
    expect(normalizeConsentActionLabel('  RÉJECT   ALL  ')).toBe('reject all');
    const result = detectGenericConsentMechanism([consentSurface], [
      { surface_id: 'consent-surface', visible: true, enabled: true, actionable: true, accessible_name: '  RÉJECT   ALL  ' },
      { surface_id: 'consent-surface', visible: true, enabled: true, actionable: true, accessible_name: 'accepter' }
    ], {}, { localized_action_labels: { accept_all: ['accepter'] } });

    expect(result.status).toBe('detected');
    expect(result.actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'direct' });
  });
});
