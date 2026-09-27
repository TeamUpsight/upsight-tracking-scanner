import type { Page } from 'playwright-core';
import type { BrowserConsentFacts } from './browser-context-builders';

export type GeoInterstitialResolution = 'not_present' | 'resolved' | 'ambiguous' | 'target_unverified' | 'action_failed' | 'transition_incomplete';
export interface GeoInterstitialDecision {
  detected: boolean;
  intent: 'country_selector' | 'location_selector' | null;
  target_match: 'exact' | 'ambiguous' | 'none';
  resolution: GeoInterstitialResolution;
  action_taken: boolean;
  final_url: string | null;
}

const normalized = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const countryNames: Record<string, RegExp> = {
  DE: /\b(?:germany|deutschland)\b/,
  FR: /\bfrance\b/,
  IT: /\b(?:italy|italia)\b/,
  ES: /\b(?:spain|espana)\b/,
  NL: /\b(?:netherlands|nederland)\b/,
  BE: /\b(?:belgium|belgie|belgique)\b/,
  AT: /\b(?:austria|osterreich)\b/,
  IE: /\b(?:ireland|eire)\b/,
  PT: /\b(?:portugal)\b/,
  SE: /\b(?:sweden|sverige)\b/,
  DK: /\b(?:denmark|danmark)\b/,
  FI: /\b(?:finland|suomi)\b/,
  PL: /\b(?:poland|polska)\b/
};

export function geoTargetPattern(geo: 'USA' | 'UK' | 'EU', verifiedCountry: string | null, verified: boolean): RegExp | null {
  if (!verified) return null;
  const country = verifiedCountry?.toUpperCase();
  if (geo === 'USA') return country === 'US' || country === 'USA' ? /\b(?:usa|us|united states)\b/ : null;
  if (geo === 'UK') return country === 'GB' || country === 'UK' ? /\b(?:uk|united kingdom|great britain|british)\b/ : null;
  return country ? countryNames[country] || null : null;
}

/** Only surface-scoped, directly actionable controls may become geo targets. */
export function chooseGeoInterstitialTarget(facts: BrowserConsentFacts, geo: 'USA' | 'UK' | 'EU', verifiedCountry: string | null, verified: boolean) {
  const surfaces = facts.generic.surfaces.filter((surface) => surface.visible && surface.strong_presentation &&
    !surface.privacy_or_cookie_semantics && (surface.intent === 'country_selector' || surface.intent === 'location_selector'));
  if (surfaces.length === 0) return { detected: false as const, intent: null, match: 'none' as const, control: null };
  const pattern = geoTargetPattern(geo, verifiedCountry, verified);
  if (!pattern) return { detected: true as const, intent: surfaces[0].intent as 'country_selector' | 'location_selector', match: 'none' as const, control: null };
  const surfaceIds = new Set(surfaces.map((surface) => surface.id));
  const matches = facts.generic.controls.filter((control) => {
    const label = normalized(control.accessible_name).replace(/^yes[,! ]+/, '');
    return surfaceIds.has(control.surface_id) && control.visible && control.enabled && control.actionable &&
      control.direct_actionable_target === true && (control.role === 'button' || control.role === 'link' || control.role === 'input') &&
      pattern.test(label) && (/\b(?:take me to|visit|continue to|switch to|go to)\b/.test(label) ||
        /^(?:usa|us|united states|uk|united kingdom|great britain|british|germany|deutschland|france|italy|italia|spain|espana|netherlands|nederland|belgium|austria|ireland|portugal|sweden|denmark|finland|poland)(?: site| website| page)?$/.test(label)) &&
      !/\b(?:global|international|currency)\b/.test(label);
  });
  return { detected: true as const, intent: surfaces[0].intent as 'country_selector' | 'location_selector', match: matches.length === 1 ? 'exact' as const : matches.length > 1 ? 'ambiguous' as const : 'none' as const, control: matches.length === 1 ? matches[0] : null };
}

export async function resolveGeoInterstitial(
  page: Page,
  facts: BrowserConsentFacts,
  geo: 'USA' | 'UK' | 'EU',
  verifiedCountry: string | null,
  verified: boolean,
  safeTarget: (url: string) => boolean,
  maximumMs = 6_000
): Promise<GeoInterstitialDecision> {
  const startedAt = Date.now();
  const target = chooseGeoInterstitialTarget(facts, geo, verifiedCountry, verified);
  const base = { detected: target.detected, intent: target.intent, target_match: target.match, action_taken: false, final_url: null };
  if (!target.detected) return { ...base, resolution: 'not_present' };
  if (!target.control) return { ...base, resolution: target.match === 'ambiguous' ? 'ambiguous' : 'target_unverified' };
  const before = page.url();
  if (target.control.href) {
    let destination: string;
    try { destination = new URL(target.control.href, before).toString(); } catch { return { ...base, resolution: 'target_unverified' }; }
    if (!safeTarget(destination)) return { ...base, resolution: 'target_unverified' };
  }
  const role = target.control.role === 'link' ? 'link' : 'button';
  const locator = page.getByRole(role, { name: target.control.accessible_name, exact: true });
  const initialMain = await page.evaluate(() => (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)).catch(() => '');
  let navigationStatus: number | null = null;
  const onResponse = (response: import('playwright-core').Response) => {
    try { if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) navigationStatus = response.status(); }
    catch { /* A detached navigation response is not authoritative. */ }
  };
  page.on('response', onResponse);
  const finish = (decision: GeoInterstitialDecision) => { page.off('response', onResponse); return decision; };
  try {
    if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) return finish({ ...base, resolution: 'ambiguous' });
    if (role === 'link') {
      const liveHref = await locator.getAttribute('href');
      if (!liveHref || liveHref !== target.control.href) return finish({ ...base, resolution: 'target_unverified' });
    }
    await locator.click({ timeout: Math.min(maximumMs, 2_000), noWaitAfter: true });
  } catch { return finish({ ...base, resolution: 'action_failed' }); }
  const beforeLocation = new URL(before);
  try { if (page.url() === before) await page.waitForURL((url) => url.origin !== beforeLocation.origin || url.pathname !== beforeLocation.pathname || url.search !== beforeLocation.search, { timeout: Math.max(1, maximumMs - (Date.now() - startedAt)) }); }
  catch {
    // A SPA may replace its site state without changing the address. Require
    // both a changed main region and removal of the geo choice controls.
    const replaced = await page.evaluate((beforeMain) => {
      const current = (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      const geoStillVisible = Array.from(document.querySelectorAll('button, a')).slice(0, 150).some((element) => {
        const label = String(element.getAttribute('aria-label') || element.textContent || '').toLowerCase();
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && /take me to|prefer the global|visit (?:the )?(?:usa|us|uk|germany) site/.test(label);
      });
      return beforeMain.length > 20 && current.length > 20 && current !== beforeMain && !geoStillVisible;
    }, initialMain).catch(() => false);
    if (!replaced) return finish({ ...base, action_taken: true, resolution: 'transition_incomplete' });
  }
  const finalUrl = page.url();
  if (!safeTarget(finalUrl)) return finish({ ...base, action_taken: true, resolution: 'target_unverified' });
  await page.waitForLoadState('domcontentloaded', { timeout: 1_500 }).catch(() => {});
  const finalMain = await page.evaluate(() => (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)).catch(() => '');
  if (navigationStatus !== null && (navigationStatus < 200 || navigationStatus >= 400)) return finish({ ...base, action_taken: true, resolution: 'target_unverified' });
  if (new URL(finalUrl).origin === beforeLocation.origin && finalMain === initialMain &&
    (!target.control.href || target.control.href.startsWith('#'))) return finish({ ...base, action_taken: true, resolution: 'transition_incomplete' });
  return finish({ ...base, action_taken: true, resolution: 'resolved', final_url: finalUrl });
}
