import type { ConsentState } from './domain-types';

/** Bounded projection of the documented Web CMP v2 BaseService consent fields. */
export interface UsercentricsV2ServiceAggregate {
  read_status: 'readable' | 'not_initialized' | 'missing_api' | 'malformed' | 'read_error' | 'not_v2';
  essential_total: number;
  essential_granted: number;
  nonessential_total: number;
  nonessential_granted: number;
  nonessential_denied: number;
  nonessential_unknown: number;
  /** Every non-essential service has a latest explicit history entry matching its current status. */
  explicit_decision_present: boolean;
}

export type UsercentricsRuntimeVersion = 'v2_uc_ui' | 'v3' | 'unknown';

export function usercentricsRuntimeVersion(assets: readonly string[], ucUiPresent: boolean): UsercentricsRuntimeVersion {
  const v2Loader = assets.some((url) => /app\.usercentrics\.eu\/browser-ui\/(?:latest|\d+(?:\.\d+){1,3})\/loader\.js(?:[?#]|$)/i.test(url));
  const v3Loader = assets.some((url) => /web\.cmp\.usercentrics\.eu\/ui\/loader\.js(?:[?#]|$)/i.test(url));
  if (v3Loader) return 'v3';
  return v2Loader && ucUiPresent ? 'v2_uc_ui' : 'unknown';
}

export function usercentricsV2Decision(state: UsercentricsV2ServiceAggregate): ConsentState['decision'] {
  if (state.read_status !== 'readable' || state.nonessential_total === 0 || state.nonessential_unknown > 0) return 'ambiguous';
  if (!state.explicit_decision_present) return 'unanswered';
  if (state.nonessential_denied === state.nonessential_total) return 'rejected';
  if (state.nonessential_granted === state.nonessential_total) return 'accepted';
  if (state.nonessential_granted > 0 && state.nonessential_denied > 0) return 'partial';
  return 'ambiguous';
}

export function usercentricsV2ChannelAvailable(state: UsercentricsV2ServiceAggregate | null | undefined): boolean {
  return state?.read_status === 'readable' && state.nonessential_total > 0 && state.nonessential_unknown === 0;
}
