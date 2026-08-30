const ACRONYMS: Record<string, string> = {
  api: 'API',
  bql: 'BQL',
  captcha: 'CAPTCHA',
  cdp: 'CDP',
  cmp: 'CMP',
  cms: 'CMS',
  csv: 'CSV',
  dns: 'DNS',
  eu: 'EU',
  fn: 'FN',
  fp: 'FP',
  ga4: 'GA4',
  http: 'HTTP',
  https: 'HTTPS',
  id: 'ID',
  ids: 'IDs',
  meta: 'Meta',
  p95: 'P95',
  pdp: 'PDP',
  qa: 'QA',
  tn: 'TN',
  tp: 'TP',
  ui: 'UI',
  uk: 'UK',
  url: 'URL',
  urls: 'URLs',
  usa: 'USA',
  zip: 'ZIP'
};

export function formatLabel(value: unknown) {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => ACRONYMS[word.toLowerCase()] || word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function websiteUrl(domain: string) {
  const trimmed = domain.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
