import type { CmpProvider, Confidence } from '../../types';

export interface CmpRawEvidence {
  dom_selectors: string[];
  script_urls: string[];
  network_hosts: string[];
  cookie_names: string[];
  window_globals: string[];
  iframe_urls: string[];
  banner_visible: boolean | null;
}

export interface CmpDetection {
  provider: CmpProvider;
  confidence: Confidence;
  evidence: string[];
  banner_visible: boolean | null;
  reason_code: string;
}

function includesAny(values: string[], patterns: string[]) {
  return values.some((value) => patterns.some((pattern) => value.toLowerCase().includes(pattern.toLowerCase())));
}

function exactAny(values: string[], expected: string[]) {
  const normalized = new Set(values.map((value) => value.toLowerCase()));
  return expected.some((value) => normalized.has(value.toLowerCase()));
}

export function detectCMP(raw: CmpRawEvidence): CmpDetection {
  const evidence: string[] = [];
  const fidesDom = includesAny(raw.dom_selectors, ['#fides-banner-container', '#fides-modal-container', '#fides-button-group']);
  const fidesGlobal = exactAny(raw.window_globals, ['Fides']);
  const fidesCookie = exactAny(raw.cookie_names, ['fides_consent']);
  const fidesScript = includesAny([...raw.script_urls, ...raw.network_hosts], ['/fides.js', 'fides.ethyca.com']);
  const fidesSources = [fidesDom, fidesGlobal, fidesCookie, fidesScript].filter(Boolean).length;
  if (fidesSources > 0) {
    if (fidesDom) evidence.push('dom');
    if (fidesGlobal) evidence.push('window_global');
    if (fidesCookie) evidence.push('cookie');
    if (fidesScript) evidence.push('script_or_network');
    return {
      provider: 'Fides',
      confidence: fidesSources >= 2 || fidesDom ? 'high' : 'medium',
      evidence,
      banner_visible: raw.banner_visible,
      reason_code: 'CMP_FIDES_DETECTED'
    };
  }

  const oneTrustDom = includesAny(raw.dom_selectors, [
    '#onetrust-banner-sdk', '#onetrust-consent-sdk', '#onetrust-pc-sdk', '.ot-sdk-container', '.ot-sdk-row'
  ]);
  const oneTrustGlobal = exactAny(raw.window_globals, ['OneTrust', 'Optanon', 'OptanonWrapper']);
  const oneTrustCookie = exactAny(raw.cookie_names, ['OptanonConsent', 'OptanonAlertBoxClosed']);
  const oneTrustScript = includesAny([...raw.script_urls, ...raw.network_hosts], [
    'cdn.cookielaw.org', 'cookielaw.org', 'onetrust.com', 'otSDKStub.js', 'Optanon.js'
  ]);
  const oneTrustSources = [oneTrustDom, oneTrustGlobal, oneTrustCookie, oneTrustScript].filter(Boolean).length;
  if (oneTrustSources > 0) {
    if (oneTrustDom) evidence.push('dom');
    if (oneTrustGlobal) evidence.push('window_global');
    if (oneTrustCookie) evidence.push('cookie');
    if (oneTrustScript) evidence.push('script_or_network');
    return {
      provider: 'OneTrust',
      confidence: oneTrustSources >= 2 || oneTrustDom ? 'high' : 'medium',
      evidence,
      banner_visible: raw.banner_visible,
      reason_code: oneTrustDom || oneTrustSources >= 2 ? 'CMP_ONETRUST_DETECTED' : 'CMP_SCRIPT_ONLY'
    };
  }

  const shopifyDom = includesAny(raw.dom_selectors, ['#shopify-pc__banner', '.shopify-policy-banner', 'shopify-pc']);
  const shopifyScript = includesAny([...raw.script_urls, ...raw.network_hosts], ['privacy-bar', 'tracking-consent', 'shopify.com/privacy']);
  const shopifyGlobal = exactAny(raw.window_globals, ['Shopify.trackingConsent']);
  const shopifyCookie = includesAny(raw.cookie_names, ['_tracking_consent', 'privacy']);
  const shopifyStrong = shopifyDom || shopifyScript;
  const shopifySupporting = [shopifyDom, shopifyScript, shopifyGlobal, shopifyCookie].filter(Boolean).length;
  if (shopifyStrong && shopifySupporting >= 2) {
    if (shopifyDom) evidence.push('dom');
    if (shopifyScript) evidence.push('script_or_network');
    if (shopifyGlobal) evidence.push('window_global');
    if (shopifyCookie) evidence.push('cookie');
    return {
      provider: 'Shopify Privacy',
      confidence: shopifySupporting >= 3 ? 'high' : 'medium',
      evidence,
      banner_visible: raw.banner_visible,
      reason_code: 'CMP_SHOPIFY_PRIVACY_DETECTED'
    };
  }

  const providers: Array<{ provider: CmpProvider; patterns: string[] }> = [
    { provider: 'Cookiebot', patterns: ['cookiebot', 'cookieconsent'] },
    { provider: 'Didomi', patterns: ['didomi'] },
    { provider: 'Usercentrics', patterns: ['usercentrics', 'uc_ui', '__ucCmp'] },
    { provider: 'CookieYes', patterns: ['cookieyes', 'cky-consent'] },
    { provider: 'Osano', patterns: ['osano'] },
    { provider: 'Iubenda', patterns: ['iubenda', '_iub'] },
    { provider: 'TrustArc', patterns: ['trustarc', 'truste'] },
    { provider: 'Quantcast', patterns: ['quantcast', 'quantcast-choice'] }
  ];
  const allSpecific = [...raw.dom_selectors, ...raw.script_urls, ...raw.network_hosts, ...raw.cookie_names, ...raw.window_globals, ...raw.iframe_urls];
  for (const candidate of providers) {
    if (includesAny(allSpecific, candidate.patterns)) {
      return {
        provider: candidate.provider,
        confidence: 'medium',
        evidence: ['provider_specific_signal'],
        banner_visible: raw.banner_visible,
        reason_code: 'CMP_PROVIDER_SIGNAL'
      };
    }
  }

  const tcfEvidence = exactAny(raw.cookie_names, ['eupubconsent-v2', 'euconsent-v2']) ||
    exactAny(raw.window_globals, ['__tcfapi']);
  if (tcfEvidence) {
    return {
      provider: 'IAB TCF',
      confidence: 'medium',
      evidence: ['generic_iab_tcf'],
      banner_visible: raw.banner_visible,
      reason_code: 'CMP_IAB_TCF_GENERIC'
    };
  }

  const hasUnknownCmpSignal = raw.banner_visible === true && includesAny(raw.dom_selectors, ['consent', 'cookie', 'privacy']);
  return {
    provider: hasUnknownCmpSignal ? 'Unknown' : 'Not Found',
    confidence: hasUnknownCmpSignal ? 'low' : 'medium',
    evidence: hasUnknownCmpSignal ? ['unknown_consent_dom'] : [],
    banner_visible: raw.banner_visible,
    reason_code: hasUnknownCmpSignal ? 'CMP_UNKNOWN' : 'CMP_NOT_DETECTED'
  };
}
