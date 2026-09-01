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
let browser: Browser;

beforeAll(async () => {
  if (!chromeExecutable) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to run Consent V2 browser fixture tests.');
  browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
});
afterAll(async () => { await browser?.close(); });

/** Local executable fixture/page → production bridge → runConsentV2Session(). */
async function audit(html: string) {
  const page = await browser.newPage();
  try { await page.setContent(html); return await runConsentV2Session(page, input); } finally { await page.close(); }
}

/** Local page navigation → prepared production capture → session evaluation. */
async function auditNavigation(html: string, accessBlocked = false) {
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
    return await runConsentV2Session(page, { ...input, access_blocked: accessBlocked }, capture);
  } finally {
    await page.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('Consent V2 production session wiring', () => {
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
