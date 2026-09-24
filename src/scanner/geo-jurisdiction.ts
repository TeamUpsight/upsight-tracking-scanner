export const EU_MEMBER_COUNTRIES = new Set([
  'at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'ie', 'it',
  'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'
]);

/** Whether an independently observed country belongs to the requested jurisdiction. */
export function countryMatchesRequestedGeo(requestedGeo: 'USA' | 'EU' | 'UK', actualCountry: string) {
  const country = actualCountry.trim().toLowerCase() === 'uk' ? 'gb' : actualCountry.trim().toLowerCase();
  if (requestedGeo === 'USA') return country === 'us';
  if (requestedGeo === 'UK') return country === 'gb';
  return EU_MEMBER_COUNTRIES.has(country);
}
