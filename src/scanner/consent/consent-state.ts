import type { CmpProvider } from '../../types';

export interface ConsentStateSnapshot {
  cookie_values: Record<string, string>;
  banner_visible: boolean;
  provider_state: Record<string, boolean | string | number | null>;
}

function changedCookie(before: ConsentStateSnapshot, after: ConsentStateSnapshot) {
  const names = new Set([...Object.keys(before.cookie_values), ...Object.keys(after.cookie_values)]);
  return [...names].some((name) => before.cookie_values[name] !== after.cookie_values[name]);
}

export function verifyConsentRejection(
  provider: CmpProvider | null,
  before: ConsentStateSnapshot,
  after: ConsentStateSnapshot
): { verified: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const stateChanged = changedCookie(before, after);
  if (stateChanged) evidence.push('consent_cookie_changed');

  const providerDenied = Object.entries(after.provider_state).some(([key, value]) => {
    const normalized = String(value).toLowerCase();
    return key.toLowerCase().includes('denied') && value === true ||
      ['denied', 'false', 'necessary', 'essential'].includes(normalized);
  });
  if (providerDenied) evidence.push('provider_state_denied');

  const bannerDismissed = before.banner_visible && !after.banner_visible;
  if (bannerDismissed) evidence.push('banner_dismissed');

  const providerRequiresState = provider !== null && provider !== 'Not Found' && provider !== 'Unknown';
  const verified = providerDenied || (providerRequiresState && stateChanged && bannerDismissed);
  return { verified, evidence };
}

export function verifyConsentAcceptance(
  provider: CmpProvider | null,
  before: ConsentStateSnapshot,
  after: ConsentStateSnapshot,
  actionTaken = false
): { verified: boolean; evidence: string[] } {
  const evidence: string[] = [];
  const stateChanged = changedCookie(before, after);
  if (stateChanged) evidence.push('consent_cookie_changed');
  const deniedStates = Object.entries(after.provider_state).filter(([key, value]) =>
    key.toLowerCase().includes('denied') && value !== null && value !== undefined
  );
  const providerAllowed = deniedStates.length > 0 && deniedStates.every(([, value]) => value === false || String(value).toLowerCase() === 'allowed');
  if (providerAllowed) evidence.push('provider_state_allowed');
  const providerRequiresState = provider !== null && provider !== 'Not Found' && provider !== 'Unknown';
  return { verified: providerAllowed || (providerRequiresState && actionTaken && stateChanged && !after.banner_visible), evidence };
}
