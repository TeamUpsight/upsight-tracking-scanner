import { describe, expect, it } from 'vitest';
import type { ConsentFrameworkObservations } from './framework-observers';
import { buildUSPrivacyObservation, classifyUSPrivacyLabel } from './us-privacy';

const frameworks = (applicableSections: number[] = []): ConsentFrameworkObservations => ({
  tcf: { present: false, lifecycle: 'absent', ping: null, latest_event: null, event_count: 0, reason_codes: [] },
  gpp: applicableSections.length
    ? {
        present: true,
        lifecycle: 'ready',
        ping: { gpp_version: '1.1', cmp_status: 'loaded', cmp_display_status: 'visible', signal_status: 'ready', supported_apis: ['7:usnat'], supported_section_ids: [7], section_list: applicableSections, applicable_sections: applicableSections, parsed_sections_available: false, parsed_section_prefixes: [], supported_apis_valid: true, section_list_valid: true, applicable_sections_valid: true },
        structure: null,
        event_count: 0,
        reason_codes: []
      }
    : { present: false, lifecycle: 'absent', ping: null, structure: null, event_count: 0, reason_codes: [] },
  usp: { present: false, mode: 'absent', reason_codes: [] }
});

describe('US privacy semantic classification', () => {
  it('US-SEM-01 uses exact bounded concepts and does not fuzzy-match arbitrary privacy text', () => {
    expect(classifyUSPrivacyLabel('Do Not Sell or Share My Personal Information')).toMatchObject({ choice: 'opt_out', rights: ['sale', 'sharing'] });
    expect(classifyUSPrivacyLabel('Read our privacy policy')).toBeNull();
    expect(classifyUSPrivacyLabel('Privacy')).toBeNull();
  });

  it('US-SEM-02 keeps management controls rights-neutral', () => {
    expect(classifyUSPrivacyLabel('Your California Privacy Choices')).toMatchObject({ choice: 'manage', rights: [] });
  });

  it('US-SEM-03 does not promote a footer-style privacy link without a confirmed surface', () => {
    const observation = buildUSPrivacyObservation({
      geo: 'USA', provider: null, provider_confirmed: false,
      surfaces: [{ id: 'footer', visible: true, privacy_or_cookie_semantics: true, intent: 'consent', strong_presentation: false }],
      controls: [{ surface_id: 'footer', accessible_name: 'Your Privacy Choices', visible: true, enabled: true, actionable: true }],
      gpc_signal: 'unavailable', gpc_acknowledgement_observed: false, frameworks: frameworks()
    });

    expect(observation?.choices).toEqual([]);
  });

  it('US-GPP-04 retains framework sections as declared context with no verified state', () => {
    const observation = buildUSPrivacyObservation({
      geo: 'USA', provider: null, provider_confirmed: false, surfaces: [], controls: [],
      gpc_signal: 'absent', gpc_acknowledgement_observed: false, frameworks: frameworks([7, 8])
    });

    expect(observation).toMatchObject({
      jurisdiction: { state_verified: null, framework_declared_sections: [7, 8] },
      gpc: { browser_signal: 'absent', signal_evidence: 'gpc_signal_absent', gpp_present: true, gpp_applicable_sections: [7, 8] }
    });
  });

  it('US-SEM-05 emits no US projection for EU/UK observations', () => {
    expect(buildUSPrivacyObservation({
      geo: 'EU', provider: null, provider_confirmed: false, surfaces: [], controls: [],
      gpc_signal: 'unavailable', gpc_acknowledgement_observed: null, frameworks: frameworks()
    })).toBeNull();
  });
});
