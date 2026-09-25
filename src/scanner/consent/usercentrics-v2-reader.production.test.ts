import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureBrowserConsentFacts } from './browser-context-builders';
import { usercentricsV2ChannelAvailable, usercentricsV2Decision } from './usercentrics-v2-state';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

const services = `[{isEssential:true,consent:{status:true,history:[]}},{isEssential:false,consent:{status:false,history:[{timestamp:1,type:'explicit',status:false}]}}]`;

async function readRuntime(runtime: string) {
  const page = await browser.newPage();
  try {
    await page.route('https://app.usercentrics.eu/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.setContent(`<script>window.UC_UI=${runtime}</script><script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script>`);
    return (await captureBrowserConsentFacts(page)).usercentrics;
  } finally { await page.close(); }
}

describe('Usercentrics v2 browser state reader isolation', () => {
  it.each([
    ['missing initializer', `{getServicesBaseInfo(){return ${services}}}`, 'not_initialized'],
    ['throwing initializer', `{isInitialized(){throw Error('private')},getServicesBaseInfo(){return ${services}}}`, 'read_error'],
    ['uninitialized', `{isInitialized(){return false},getServicesBaseInfo(){return ${services}}}`, 'not_initialized'],
    ['missing service API', `{isInitialized(){return true}}`, 'missing_api'],
    ['throwing service API', `{isInitialized(){return true},getServicesBaseInfo(){throw Error('private')}}`, 'read_error'],
    ['undefined services', `{isInitialized(){return true},getServicesBaseInfo(){return undefined}}`, 'malformed'],
    ['null services', `{isInitialized(){return true},getServicesBaseInfo(){return null}}`, 'malformed'],
    ['non-array services', `{isInitialized(){return true},getServicesBaseInfo(){return {}}}`, 'malformed'],
    ['malformed service', `{isInitialized(){return true},getServicesBaseInfo(){return [null]}}`, 'malformed'],
    ['missing consent', `{isInitialized(){return true},getServicesBaseInfo(){return [{isEssential:false}]}}`, 'malformed'],
    ['missing history', `{isInitialized(){return true},getServicesBaseInfo(){return [{isEssential:false,consent:{status:false}}]}}`, 'malformed'],
    ['async service API', `{isInitialized(){return true},async getServicesBaseInfo(){return ${services}}}`, 'malformed']
  ] as const)('bounds %s without crashing common facts', async (_shape, runtime, expected) => {
    const facts = await readRuntime(runtime);
    expect(facts.runtime_version).toBe('v2_uc_ui');
    expect(facts.service_state.read_status).toBe(expected);
    expect(usercentricsV2ChannelAvailable(facts.service_state)).toBe(false);
  }, 15_000);

  it('invokes both APIs with UC_UI as their receiver', async () => {
    const facts = await readRuntime(`{ready:true,isInitialized(){return this.ready},getServicesBaseInfo(){if(!this.ready)throw Error('detached');return ${services}}}`);
    expect(facts.service_state).toMatchObject({ read_status: 'readable', nonessential_total: 1, nonessential_denied: 1, explicit_decision_present: true });
    expect(usercentricsV2Decision(facts.service_state)).toBe('rejected');
  });

  it.each(['[{timestamp:"1",type:"explicit",status:false}]', '[null]', '[{timestamp:1,type:"explicit",status:false},{timestamp:1,type:"explicit",status:false}]'])(
    'keeps malformed history %s non-explicit', async (history) => {
      const facts = await readRuntime(`{isInitialized(){return true},getServicesBaseInfo(){return [{isEssential:false,consent:{status:false,history:${history}}}]}}`);
      expect(facts.service_state).toMatchObject({ read_status: 'readable', explicit_decision_present: false });
      expect(usercentricsV2Decision(facts.service_state)).toBe('unanswered');
    }
  );
});
