import { describe, expect, it } from 'vitest';
import { usercentricsRuntimeVersion, usercentricsV2ChannelAvailable, usercentricsV2Decision, type UsercentricsV2ServiceAggregate } from './usercentrics-v2-state';

const aggregate = (overrides: Partial<UsercentricsV2ServiceAggregate> = {}): UsercentricsV2ServiceAggregate => ({
  read_status: 'readable', essential_total: 1, essential_granted: 1,
  nonessential_total: 2, nonessential_granted: 0, nonessential_denied: 2,
  nonessential_unknown: 0, explicit_decision_present: false, ...overrides
});

describe('Usercentrics Web CMP v2 semantic service state', () => {
  it('UC-V2-STATE-01 / UC-V2-FIRST-VISIT-01 keeps default false services unanswered', () => {
    expect(usercentricsV2Decision(aggregate())).toBe('unanswered');
    expect(usercentricsV2ChannelAvailable(aggregate())).toBe(true);
  });

  it('UC-V2-STATE-02/03 excludes accepted essential services from explicit all-denied classification', () => {
    expect(usercentricsV2Decision(aggregate({ explicit_decision_present: true }))).toBe('rejected');
  });

  it('UC-V2-STATE-04 distinguishes accepted, partial, and malformed states', () => {
    expect(usercentricsV2Decision(aggregate({ explicit_decision_present: true, nonessential_granted: 2, nonessential_denied: 0 }))).toBe('accepted');
    expect(usercentricsV2Decision(aggregate({ explicit_decision_present: true, nonessential_granted: 1, nonessential_denied: 1 }))).toBe('partial');
    expect(usercentricsV2Decision(aggregate({ read_status: 'malformed' }))).toBe('ambiguous');
    expect(usercentricsV2ChannelAvailable(aggregate({ read_status: 'malformed' }))).toBe(false);
  });

  it('UC-V2-VERSION-01 keeps the v3 loader outside the v2 semantic contract', () => {
    const v2 = 'https://app.usercentrics.eu/browser-ui/latest/loader.js';
    const v3 = 'https://web.cmp.usercentrics.eu/ui/loader.js';
    expect(usercentricsRuntimeVersion([v2], true)).toBe('v2_uc_ui');
    expect(usercentricsRuntimeVersion([v2], false)).toBe('unknown');
    expect(usercentricsRuntimeVersion([v3], true)).toBe('v3');
    expect(usercentricsRuntimeVersion([v2, v3], true)).toBe('v3');
  });
});
