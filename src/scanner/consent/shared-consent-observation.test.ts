import { describe, expect, it } from 'vitest';
import { mergeSharedConsentObservation, type SharedConsentObservation } from './v2-session';

const shared = (): SharedConsentObservation => ({
  source: 'shared', provider: 'onetrust', provider_conflict: false, render_state: 'ready',
  us_privacy: null,
  banner: { surface: 'banner', visibility: 'visible', evidence: ['shared_visible'], reason_codes: [] },
  actions: [
    { action: 'accept_all', availability: 'direct', category: null, evidence: ['shared_accept'], reason_codes: [] },
    { action: 'reject_all', availability: 'direct', category: null, evidence: ['shared_reject'], reason_codes: [] },
    { action: 'open_preferences', availability: 'direct', category: null, evidence: ['shared_preferences'], reason_codes: [] }
  ]
});

const fresh = (banner: 'visible' | 'not_visible' | 'unknown' = 'unknown', provider = 'onetrust') => ({
  telemetry: { provider, provider_conflict: false, render_state: 'ready', session_status: 'completed', timeline: { initial_observation_completed_at: 1 } },
  result: { banner: { surface: banner === 'visible' ? 'banner' : 'none', visibility: banner, evidence: [], reason_codes: [] }, available_actions: [] }
} as any);

describe('shared CMP observation survival', () => {
  it('P0.2B preserves shared named identity, banner and controls through providerless incomplete fresh observations', () => {
    const incomplete = fresh('not_visible');
    incomplete.telemetry.provider = null;
    incomplete.telemetry.render_state = 'incomplete';
    incomplete.telemetry.session_status = 'unavailable';
    incomplete.telemetry.timeline.initial_observation_completed_at = null;
    expect(mergeSharedConsentObservation(shared(), incomplete)).toMatchObject({
      provider: 'onetrust', provider_conflict: false, banner: shared().banner, actions: shared().actions
    });
  });

  it('P0.2B preserves shared generic/custom identity through providerless incomplete fresh observations', () => {
    const incomplete = fresh();
    incomplete.telemetry.provider = null;
    incomplete.telemetry.render_state = 'incomplete';
    expect(mergeSharedConsentObservation({ ...shared(), provider: 'generic' }, incomplete)).toMatchObject({ provider: 'generic', provider_conflict: false });
  });

  it('CMP-SURVIVE-01 preserves OneTrust surface and controls when the fresh session is unavailable', () => {
    const merged = mergeSharedConsentObservation(shared(), null);
    expect(merged).toMatchObject({ provider: 'onetrust', banner: { visibility: 'visible' } });
    expect(merged.actions).toHaveLength(3);
  });

  it('CMP-SURVIVE-02 preserves a shared visible banner after PAGE_CONTEXT_UNAVAILABLE', () => {
    expect(mergeSharedConsentObservation(shared(), null).banner.visibility).toBe('visible');
  });

  it('CMP-SURVIVE-03 preserves a shared visible banner after a fresh timeout', () => {
    expect(mergeSharedConsentObservation(shared(), null).banner.visibility).toBe('visible');
  });

  it('CMP-SURVIVE-RENDER preserves shared positive evidence when fresh rendering is incomplete', () => {
    const incomplete = fresh('not_visible');
    incomplete.telemetry.render_state = 'incomplete';
    const merged = mergeSharedConsentObservation(shared(), incomplete);
    expect(merged).toMatchObject({ provider: 'onetrust', banner: { visibility: 'visible' } });
    expect(merged.actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'reject_all', availability: 'direct' })]));
  });

  it('CMP-SURVIVE-04 keeps incomplete shared observation unknown when fresh is unavailable', () => {
    const incomplete = { ...shared(), provider: null, banner: { surface: 'unknown' as const, visibility: 'unknown' as const, evidence: [], reason_codes: [] }, actions: [] };
    expect(mergeSharedConsentObservation(incomplete, null).banner.visibility).toBe('unknown');
  });

  it('CMP-SURVIVE-05 retains matching shared and fresh visible observations', () => {
    expect(mergeSharedConsentObservation(shared(), fresh('visible')).banner.visibility).toBe('visible');
  });

  it('CMP-SURVIVE-06 treats equal-authority visible/not-visible observations as a contradiction', () => {
    expect(mergeSharedConsentObservation(shared(), fresh('not_visible')).banner.visibility).toBe('unknown');
  });

  it('CMP-FINAL-02 and CMP-FINAL-03 preserve Sourcepoint through unavailable and absent fresh sessions', () => {
    const sourcepoint = { ...shared(), provider: 'sourcepoint' as const };
    expect(mergeSharedConsentObservation(sourcepoint, null)).toMatchObject({ provider: 'sourcepoint', provider_conflict: false });
    expect(mergeSharedConsentObservation(sourcepoint, { telemetry: { provider: null, provider_conflict: false }, result: { banner: { surface: 'none', visibility: 'unknown', evidence: [], reason_codes: [] }, available_actions: [] } } as any)).toMatchObject({ provider: 'sourcepoint', provider_conflict: false });
  });

  it('CMP-FINAL-04 makes incompatible positive provider evidence a conflict', () => {
    expect(mergeSharedConsentObservation(shared(), fresh('visible', 'cookiebot'))).toMatchObject({ provider: null, provider_conflict: true });
  });
});
