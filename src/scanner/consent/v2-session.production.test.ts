import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsentV2RolloutControls } from './rollout-controls';
import { runConsentV2Session } from './v2-session';

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
});
