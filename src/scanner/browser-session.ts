import type { Browser, BrowserContext, Page } from 'playwright-core';

export interface BrowserGeoProfile {
  country: string;
  locale: string;
  timezoneId: string;
  acceptLanguage: string;
}

const GEO_PROFILES: Record<string, Omit<BrowserGeoProfile, 'country'>> = {
  us: { locale: 'en-US', timezoneId: 'America/New_York', acceptLanguage: 'en-US,en;q=0.9' },
  gb: { locale: 'en-GB', timezoneId: 'Europe/London', acceptLanguage: 'en-GB,en;q=0.9' },
  de: { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8' },
  nl: { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.8' },
  fr: { locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8' },
  it: { locale: 'it-IT', timezoneId: 'Europe/Rome', acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8' },
  es: { locale: 'es-ES', timezoneId: 'Europe/Madrid', acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8' }
};

export function browserGeoProfile(country: string): BrowserGeoProfile {
  const normalized = country.toLowerCase();
  const profile = GEO_PROFILES[normalized] || GEO_PROFILES.us;
  return { country: normalized, ...profile };
}

export async function configureBrowserGeo(context: BrowserContext, page: Page, country: string) {
  const profile = browserGeoProfile(country);
  await context.setExtraHTTPHeaders({ 'Accept-Language': profile.acceptLanguage });
  const cdp = await context.newCDPSession(page);
  const results = await Promise.allSettled([
    cdp.send('Emulation.setLocaleOverride', { locale: profile.locale }),
    cdp.send('Emulation.setTimezoneOverride', { timezoneId: profile.timezoneId })
  ]);
  await cdp.detach().catch(() => {});
  return {
    profile,
    localeApplied: results[0].status === 'fulfilled',
    timezoneApplied: results[1].status === 'fulfilled'
  };
}

export async function reuseOrCreateContext(
  browser: Browser,
  options: Parameters<Browser['newContext']>[0],
  preferExisting: boolean
): Promise<{ context: BrowserContext; reused: boolean }> {
  if (preferExisting) {
    const existing = browser.contexts()[0];
    if (existing) return { context: existing, reused: true };
  }
  return { context: await browser.newContext(options), reused: false };
}
