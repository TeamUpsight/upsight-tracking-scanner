import type { Browser, BrowserContext, Page } from 'playwright-core';

export async function closeWithDeadline(close: () => Promise<unknown>, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      close().then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface BrowserGeoProfile {
  country: string;
  profile_country: string | null;
  match: 'exact' | 'regional_fallback';
  locale: string;
  timezoneId: string;
  acceptLanguage: string;
}

const GEO_PROFILES: Record<string, Omit<BrowserGeoProfile, 'country' | 'profile_country' | 'match'>> = {
  us: { locale: 'en-US', timezoneId: 'America/New_York', acceptLanguage: 'en-US,en;q=0.9' },
  gb: { locale: 'en-GB', timezoneId: 'Europe/London', acceptLanguage: 'en-GB,en;q=0.9' },
  at: { locale: 'de-AT', timezoneId: 'Europe/Vienna', acceptLanguage: 'de-AT,de;q=0.9,en;q=0.8' },
  be: { locale: 'nl-BE', timezoneId: 'Europe/Brussels', acceptLanguage: 'nl-BE,nl;q=0.9,fr;q=0.8,en;q=0.7' },
  bg: { locale: 'bg-BG', timezoneId: 'Europe/Sofia', acceptLanguage: 'bg-BG,bg;q=0.9,en;q=0.8' },
  hr: { locale: 'hr-HR', timezoneId: 'Europe/Zagreb', acceptLanguage: 'hr-HR,hr;q=0.9,en;q=0.8' },
  cy: { locale: 'el-CY', timezoneId: 'Asia/Nicosia', acceptLanguage: 'el-CY,el;q=0.9,en;q=0.8' },
  cz: { locale: 'cs-CZ', timezoneId: 'Europe/Prague', acceptLanguage: 'cs-CZ,cs;q=0.9,en;q=0.8' },
  dk: { locale: 'da-DK', timezoneId: 'Europe/Copenhagen', acceptLanguage: 'da-DK,da;q=0.9,en;q=0.8' },
  ee: { locale: 'et-EE', timezoneId: 'Europe/Tallinn', acceptLanguage: 'et-EE,et;q=0.9,en;q=0.8' },
  fi: { locale: 'fi-FI', timezoneId: 'Europe/Helsinki', acceptLanguage: 'fi-FI,fi;q=0.9,en;q=0.8' },
  de: { locale: 'de-DE', timezoneId: 'Europe/Berlin', acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8' },
  nl: { locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.8' },
  fr: { locale: 'fr-FR', timezoneId: 'Europe/Paris', acceptLanguage: 'fr-FR,fr;q=0.9,en;q=0.8' },
  it: { locale: 'it-IT', timezoneId: 'Europe/Rome', acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8' },
  es: { locale: 'es-ES', timezoneId: 'Europe/Madrid', acceptLanguage: 'es-ES,es;q=0.9,en;q=0.8' },
  gr: { locale: 'el-GR', timezoneId: 'Europe/Athens', acceptLanguage: 'el-GR,el;q=0.9,en;q=0.8' },
  hu: { locale: 'hu-HU', timezoneId: 'Europe/Budapest', acceptLanguage: 'hu-HU,hu;q=0.9,en;q=0.8' },
  ie: { locale: 'en-IE', timezoneId: 'Europe/Dublin', acceptLanguage: 'en-IE,en;q=0.9' },
  lv: { locale: 'lv-LV', timezoneId: 'Europe/Riga', acceptLanguage: 'lv-LV,lv;q=0.9,en;q=0.8' },
  lt: { locale: 'lt-LT', timezoneId: 'Europe/Vilnius', acceptLanguage: 'lt-LT,lt;q=0.9,en;q=0.8' },
  lu: { locale: 'fr-LU', timezoneId: 'Europe/Luxembourg', acceptLanguage: 'fr-LU,fr;q=0.9,de;q=0.8,en;q=0.7' },
  mt: { locale: 'mt-MT', timezoneId: 'Europe/Malta', acceptLanguage: 'mt-MT,mt;q=0.9,en;q=0.8' },
  pl: { locale: 'pl-PL', timezoneId: 'Europe/Warsaw', acceptLanguage: 'pl-PL,pl;q=0.9,en;q=0.8' },
  pt: { locale: 'pt-PT', timezoneId: 'Europe/Lisbon', acceptLanguage: 'pt-PT,pt;q=0.9,en;q=0.8' },
  ro: { locale: 'ro-RO', timezoneId: 'Europe/Bucharest', acceptLanguage: 'ro-RO,ro;q=0.9,en;q=0.8' },
  sk: { locale: 'sk-SK', timezoneId: 'Europe/Bratislava', acceptLanguage: 'sk-SK,sk;q=0.9,en;q=0.8' },
  si: { locale: 'sl-SI', timezoneId: 'Europe/Ljubljana', acceptLanguage: 'sl-SI,sl;q=0.9,en;q=0.8' },
  se: { locale: 'sv-SE', timezoneId: 'Europe/Stockholm', acceptLanguage: 'sv-SE,sv;q=0.9,en;q=0.8' }
};

const UNKNOWN_COUNTRY_PROFILE = { locale: 'en-GB', timezoneId: 'UTC', acceptLanguage: 'en-GB,en;q=0.9' };

export function browserGeoProfile(country: string): BrowserGeoProfile {
  const supplied = country.trim().toLowerCase();
  const normalized = supplied === 'uk' ? 'gb' : supplied;
  const profile = GEO_PROFILES[normalized];
  return profile
    ? { country: normalized, profile_country: normalized, match: 'exact', ...profile }
    : { country: normalized || 'unknown', profile_country: null, match: 'regional_fallback', ...UNKNOWN_COUNTRY_PROFILE };
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
