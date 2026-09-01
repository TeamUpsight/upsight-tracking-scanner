import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsentV2RolloutControls } from './rollout-controls';
import { prepareConsentV2Session, runConsentV2Session } from './v2-session';

const chromeExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find(existsSync);

const rollout: ConsentV2RolloutControls = {
  enabled: true, actions_enabled: false, action_sample_percent: 0,
  providers: Object.fromEntries(['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'cookieyes', 'sourcepoint', 'shopify', 'generic'].map((provider) => [provider, { detection_enabled: true, actions_enabled: false }])) as ConsentV2RolloutControls['providers']
};

const input = { geo: 'EU' as const, geo_verified: true, page_valid: true, rollout };
const actionRollout: ConsentV2RolloutControls = {
  ...rollout,
  actions_enabled: true,
  action_sample_percent: 100,
  providers: Object.fromEntries(Object.entries(rollout.providers).map(([provider, settings]) => [provider, { ...settings, actions_enabled: true }])) as ConsentV2RolloutControls['providers']
};
let browser: Browser;

beforeAll(async () => {
  if (!chromeExecutable) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to run Consent V2 browser fixture tests.');
  browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
});
afterAll(async () => { await browser?.close(); });

/** Local executable fixture/page → production bridge → runConsentV2Session(). */
async function audit(html: string, sessionInput = input) {
  const page = await browser.newPage();
  try { await page.setContent(html); return await runConsentV2Session(page, sessionInput); } finally { await page.close(); }
}

/** Local page navigation → prepared production capture → session evaluation. */
async function auditNavigation(html: string, accessBlocked = false, sessionInput = input) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local Consent V2 fixture server did not expose a TCP port.');
  const page = await browser.newPage();
  try {
    const capture = await prepareConsentV2Session(page);
    capture.markNavigationStarted();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
    capture.markDOMContentLoaded(); capture.markInitialObservationCompleted();
    return await runConsentV2Session(page, { ...sessionInput, access_blocked: accessBlocked }, capture);
  } finally {
    await page.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('Consent V2 production session wiring', () => {
  it('VER-CB-01 wires Cookiebot runtime rejection through the production verifier', async () => {
    const result = await audit(`<script>
      window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};
      function decline(){Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consented=false;Cookiebot.consent={preferences:false,statistics:false,marketing:false};}
    </script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline()">Decline</button></div>`, { ...input, rollout: actionRollout });
    expect(result.result.interactions[0]).toMatchObject({ origin: 'provider_selector', outcome: 'executed' });
    expect(result.result.rejection_verification.status).toBe('verified');
  });

  it('VER-OT-01 prefers the visible OneTrust Reject control over its API capability', async () => {
    const result = await audit(`<script>
      window.OneTrust={RejectAll(){window.apiCalled=true;}}; window.OnetrustActiveGroups='C001';
      function reject(){window.OnetrustActiveGroups='C001';}
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="reject()">Reject all</button></div>`, { ...input, rollout: actionRollout });
    expect(result.result.interactions[0]).toMatchObject({ origin: 'provider_selector', outcome: 'executed' });
  });
  it('uses the OneTrust adapter for provider evidence, state, banner, and actions', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div>`);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('direct');
  });

  it('keeps Shopify Customer Privacy as a separate commerce privacy runtime beside OneTrust', async () => {
    const result = await audit(`<script>
      window.OneTrust={RejectAll(){}};
      window.Shopify={customerPrivacy:{
        currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},
        analyticsProcessingAllowed(){return false}, marketingAllowed(){return false}, preferencesProcessingAllowed(){return false}, saleOfDataAllowed(){return false}, shouldShowBanner(){return false}, getRegion(){return 'EU'}
      }};
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"></div>`);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toEqual(expect.arrayContaining(['cmp', 'commerce_privacy_runtime']));
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
  });

  it('reports a GPP stub as stub_present through the framework observer', async () => {
    const result = await audit(`<script>window.__gpp=(command, callback) => { if(command==='ping') callback({gppVersion:'1.1',cmpStatus:'stub',cmpDisplayStatus:'visible',signalStatus:'not ready',cmpId:1,supportedAPIs:[],sectionList:[],applicableSections:[]},true); };</script>`);
    expect(result.result.frameworks.gpp).toBe('stub_present');
    expect(result.result.frameworks.reason_codes).toContain('GPP_STUB_PRESENT');
  });

  it('GPP-02 keeps normalized ready GPP lifecycle fields in framework evidence', async () => {
    const result = await audit(`<script>window.__gpp=(command, callback) => { const ping={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',cmpId:1,supportedAPIs:['usnat'],sectionList:[7],applicableSections:[7,8]}; if(command==='ping') callback(ping,true); if(command==='addEventListener') callback({listenerId:1,pingData:ping},true); };</script>`);
    expect(result.result.frameworks).toMatchObject({ gpp: 'present' });
    expect(result.result.frameworks.evidence).toEqual(expect.arrayContaining(['gpp_cmp_status:loaded', 'gpp_cmp_display_status:hidden', 'gpp_signal_status:ready', 'gpp_applicable_sections:7,8']));
  });

  it('MM-01 preserves Shopify, OneTrust, GPP, and GCM as independent mechanisms', async () => {
    const result = await audit(`<script>
      window.dataLayer=[['consent','default',{ad_storage:'denied',analytics_storage:'denied'}]];
      window.OneTrust={RejectAll(){}};
      window.__gpp=(command, callback) => { const ping={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',cmpId:1,supportedAPIs:[],sectionList:[7],applicableSections:[7]}; if(command==='ping') callback(ping,true); if(command==='addEventListener') callback({listenerId:1,pingData:ping},true); };
      window.Shopify={customerPrivacy:{currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},analyticsProcessingAllowed(){return false},marketingAllowed(){return false},preferencesProcessingAllowed(){return false},saleOfDataAllowed(){return false},shouldShowBanner(){return false},getRegion(){return 'EU'}}};
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"></div>`);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toEqual(expect.arrayContaining(['cmp', 'commerce_privacy_runtime', 'framework', 'consent_mode']));
    expect(new Set(result.result.mechanisms.map((item) => `${item.mechanism}:${item.provider?.candidates.map((candidate) => candidate.provider_name).join(',') || ''}`)).size).toBe(result.result.mechanisms.length);
  });

  it('MM-02 reports Shopify alone without inventing an external CMP', async () => {
    const result = await audit(`<script>window.Shopify={customerPrivacy:{currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},analyticsProcessingAllowed(){return false},marketingAllowed(){return false},preferencesProcessingAllowed(){return false},saleOfDataAllowed(){return false},shouldShowBanner(){return false},getRegion(){return 'EU'}}};</script>`);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toContain('commerce_privacy_runtime');
    expect(result.result.mechanisms.some((item) => item.mechanism === 'cmp' || item.mechanism === 'custom')).toBe(false);
  });

  it('GCM-01 classifies a denied default with pre-choice measurement as advanced through production wiring', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';
      function decline(){window.dataLayer.push(['consent','update',{ad_storage:'denied',analytics_storage:'denied'}]);}
    </script></head><body><script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline();Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consent={preferences:false,statistics:false,marketing:false}">Decline</button></div></body>`, false, { ...input, rollout: actionRollout });
    expect(result.google_consent_mode).toMatchObject({ classification: 'advanced_candidate', default_issued_late: false, lifecycle: 'default_and_update' });
    expect(result.result.mechanisms.map((item) => item.mechanism)).toContain('consent_mode');
  }, 10_000);

  it('GCM-02 requires a full pre-choice window, gated measurement, and a positive update for Basic', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      function decline(){window.dataLayer.push(['consent','update',{ad_storage:'granted',analytics_storage:'granted'}]);new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G111';}
    </script></head><body><script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline();Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consent={preferences:false,statistics:false,marketing:false}">Decline</button></div></body>`, false, { ...input, rollout: actionRollout });
    expect(result.google_consent_mode).toMatchObject({ classification: 'basic_candidate', pre_choice_measurement_window_observed: true, tracking_gated: true });
  }, 10_000);

  it('GCM-03 keeps gcd-only evidence ambiguous', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcd=opaque';</script></head><body>fixture</body>`);
    expect(result.google_consent_mode.classification).toBe('ambiguous');
  });

  it('GCM-04 captures the post-Reject Consent Mode update and surfaces a contradiction', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      function decline(){window.dataLayer.push(['consent','update',{ad_storage:'granted',analytics_storage:'granted'}]);}
    </script></head><body><script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline();Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consent={preferences:false,statistics:false,marketing:false}">Decline</button></div></body>`, false, { ...input, rollout: actionRollout });
    expect(result.result.google_consent_mode.updates_observed).toBe(true);
    expect(result.google_consent_mode.commands.some((command) => command.command === 'update')).toBe(true);
    expect(result.result.reason_codes).toContain('STATE_CONTRADICTION');
  }, 10_000);

  it('does not classify a newsletter dialog as a custom CMP', async () => {
    const result = await audit('<div role="dialog">Newsletter <button>Sign up</button></div>');
    expect(result.result.mechanisms.some((item) => item.mechanism === 'custom')).toBe(false);
  });

  it('routes an unknown custom consent banner through the generic detector', async () => {
    const result = await audit('<div id="cookie-notice">We use cookies.<button>Accept all</button><button>Reject all</button></div>');
    expect(result.result.mechanisms.find((item) => item.mechanism === 'custom')?.provider?.reason_codes).toContain('CMP_PROVIDER_UNKNOWN');
  });

  it('PRE-01 captures a GA4 head event before DOMContentLoaded as pre-choice', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';</script></head><body>fixture</body>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'google_analytics', kind: 'event_hit', timing: 'pre_choice' })]));
    expect(result.telemetry.timeline?.navigation_started_at).not.toBeNull();
    expect(result.telemetry.timeline?.dom_content_loaded_at).not.toBeNull();
  });

  it('PRE-02 captures an immediate Meta conversion signal as pre-choice', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.facebook.com/tr/?ev=Purchase';</script></head><body>fixture</body>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'meta', kind: 'conversion_hit', timing: 'pre_choice' })]));
  });

  it('PRE-03 observes a pre-choice Consent Mode default and its early Google ping', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100&gcd=opaque&dma=1&dma_cps=1&gcu=1&gcut=1&npa=1';
    </script></head><body>fixture</body>`);
    expect(result.result.google_consent_mode.defaults_observed).toBe(true);
    expect(result.google_consent_mode.commands.some((command) => command.command === 'default')).toBe(true);
    expect(result.google_consent_mode.network.some((observation) => observation.parameters.gcs?.present && observation.parameters.gcd?.present && observation.parameters.dma?.present && observation.parameters.dma_cps?.present && observation.parameters.gcu?.present && observation.parameters.gcut?.present && observation.parameters.npa?.present)).toBe(true);
  });

  it('PRE-04 keeps pre-choice tracking classification in observation-only mode', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view';</script></head><body>fixture</body>`);
    expect(result.telemetry.observation_only).toBe(true);
    expect(result.telemetry.timeline?.user_choice_at).toBeNull();
    expect(result.tracking.signals.some((signal) => signal.timing === 'pre_choice')).toBe(true);
  });

  it('PRE-05 preserves a challenge outcome without claiming no CMP', async () => {
    const result = await auditNavigation('<title>Checking your browser</title><body>challenge</body>', true);
    expect(result.result.reason_codes).toContain('BLOCKED_OR_CHALLENGED');
    expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
  });
});
