import { describe, expect, it } from 'vitest';
import { mergeSharedConsentObservation, type SharedConsentObservation } from './v2-session';

const shared = (): SharedConsentObservation => ({
  source: 'shared', provider: 'onetrust', provider_conflict: false,
  banner: { surface: 'banner', visibility: 'visible', evidence: ['shared_visible'], reason_codes: [] },
  actions: [
    { action: 'accept_all', availability: 'direct', category: null, evidence: ['shared_accept'], reason_codes: [] },
    { action: 'reject_all', availability: 'direct', category: null, evidence: ['shared_reject'], reason_codes: [] },
    { action: 'open_preferences', availability: 'direct', category: null, evidence: ['shared_preferences'], reason_codes: [] }
  ]
});

const fresh = (banner: 'visible' | 'not_visible' | 'unknown' = 'unknown', provider = 'onetrust') => ({
  telemetry: { provider, provider_conflict: false },
  result: { banner: { surface: banner === 'visible' ? 'banner' : 'none', visibility: banner, evidence: [], reason_codes: [] }, available_actions: [] }
} as any);

describe('shared CMP observation survival', () => {
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
