import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureBrowserConsentFacts } from './browser-context-builders';
import { BrowserFactsCaptureError, consentObservationFailure } from './observation-stage';
import { captureSharedConsentObservation } from './v2-session';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

async function fixture(html: string, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try { await page.setContent(html); await check(page); } finally { await page.close(); }
}

async function failedCapture(page: Page) {
  let failure: unknown;
  try { await captureBrowserConsentFacts(page); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(BrowserFactsCaptureError);
  expect((failure as Error).message).toBe('BROWSER_FACTS_CAPTURE_FAILED');
  return failure as BrowserFactsCaptureError;
}

describe('browser-facts substage isolation', () => {
  it('BF-ERR-01 attributes a throwing provider global and leaves shared CMP observation inconclusive', async () => {
    await fixture(`<script>Object.defineProperty(window,'UC_UI',{get(){throw new TypeError('fixture-only')}})</script>`, async (page) => {
      const error = await failedCapture(page);
      expect(error).toMatchObject({ browser_facts_substage: 'provider_globals', error_family: 'type_error' });
      let sharedFailure: unknown;
      try { await captureSharedConsentObservation(page); } catch (caught) { sharedFailure = caught; }
      expect(consentObservationFailure(sharedFailure)).toMatchObject({ observation_stage: 'browser_facts', operation: 'captureBrowserConsentFacts', browser_facts_substage: 'provider_globals', error_family: 'type_error' });
      expect(JSON.stringify(consentObservationFailure(sharedFailure))).not.toContain('fixture-only');
    });
  });

  it('BF-ERR-02 attributes a throwing Cookiebot property without returning empty facts', async () => {
    await fixture(`<script>window.Cookiebot={get hasResponse(){throw new TypeError('fixture-only')}}</script>`, async (page) => {
      expect(await failedCapture(page)).toMatchObject({ browser_facts_substage: 'cookiebot_runtime', error_family: 'type_error' });
    });
  });

  it('BF-ERR-03 attributes a throwing OneTrust global method inspection', async () => {
    await fixture(`<script>Object.defineProperty(window,'OneTrust',{get(){throw new TypeError('fixture-only')}})</script>`, async (page) => {
      expect(await failedCapture(page)).toMatchObject({ browser_facts_substage: 'onetrust_runtime', error_family: 'type_error' });
    });
  });

  it('BF-ERR-04 attributes a hostile dataLayer entry', async () => {
    await fixture(`<script>window.dataLayer=[new Proxy([],{get(target,key){if(key==='0')throw new TypeError('fixture-only');return Reflect.get(target,key)}})]</script>`, async (page) => {
      expect(await failedCapture(page)).toMatchObject({ browser_facts_substage: 'consent_commands', error_family: 'type_error' });
    });
  });

  it('BF-ERR-05 keeps inaccessible cookie and localStorage reads non-fatal', async () => {
    await fixture(`<script>Object.defineProperty(document,'cookie',{get(){throw new DOMException('fixture-only','SecurityError')}});Object.defineProperty(window,'localStorage',{get(){throw new DOMException('fixture-only','SecurityError')}})</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.cookie_names).toEqual([]);
      expect(facts.storage_keys).toEqual([]);
    });
  });

  it('BF-ERR-06 completes bounded open and nested shadow traversal with custom controls', async () => {
    await fixture(`<div id="host"></div><script>
      const first=document.querySelector('#host');const root=first.attachShadow({mode:'open'});
      root.innerHTML='<div role="dialog" id="cookie-panel">Cookie consent <button>Alles ablehnen</button><span tabindex="0">Alles akzeptieren</span><div id="nested"></div></div>';
      const nested=root.querySelector('#nested').attachShadow({mode:'open'});nested.innerHTML='<button>Alles ablehnen</button>';
      for(let i=0;i<30;i++){const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<div>bounded</div>'}
      const detached=document.createElement('div');document.body.append(detached);detached.attachShadow({mode:'open'}).innerHTML='<button>Alles ablehnen</button>';detached.remove();
    </script>`, async (page) => {
      expect(await page.evaluate(() => ({ host: Boolean(document.querySelector('#host')), shadow: Boolean(document.querySelector('#host')?.shadowRoot), dialog: Boolean(document.querySelector('#host')?.shadowRoot?.querySelector('[role="dialog"]')) }))).toEqual({ host: true, shadow: true, dialog: true });
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces.some((surface) => surface.location === 'shadow_dom')).toBe(true);
      expect(facts.generic.controls.some((control) => control.location === 'shadow_dom')).toBe(true);
      expect(facts.generic.controls.length).toBeLessThanOrEqual(60);
    });
  });

  it('BF-ERR-06B completes above the shadow-host traversal cap without expanding evidence', async () => {
    await fixture(`<script>for(let i=0;i<55;i++){const host=document.createElement('div');document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<div role="dialog">Cookie consent</div>'}</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces.length).toBeLessThanOrEqual(30);
      expect(facts.generic.controls.length).toBeLessThanOrEqual(60);
    });
  });

  it('BF-ERR-06C attributes a failing shadow traversal without fabricating facts', async () => {
    await fixture(`<script>document.createTreeWalker=()=>{throw new TypeError('fixture-only')}</script>`, async (page) => {
      expect(await failedCapture(page)).toMatchObject({ browser_facts_substage: 'shadow_dom', error_family: 'type_error' });
    });
  });

  it('BF-ERR-07 attributes the second Usercentrics evaluation separately', async () => {
    await fixture(`<script>Object.defineProperty(window,'__upsightUsercentricsLifecycle',{get(){throw new TypeError('fixture-only')}})</script>`, async (page) => {
      expect(await failedCapture(page)).toMatchObject({ browser_facts_substage: 'usercentrics_lifecycle', error_family: 'type_error' });
    });
  });

  it('BF-ERR-08 distinguishes destroyed execution context and closed page at the Playwright boundary', async () => {
    const destroyed = { evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); } } as unknown as Page;
    const closed = { evaluate: async () => { throw new Error('Target page, context or browser has been closed'); } } as unknown as Page;
    await expect(captureBrowserConsentFacts(destroyed)).rejects.toMatchObject({ browser_facts_substage: 'browser_facts_core', error_family: 'execution_context_destroyed' });
    await expect(captureBrowserConsentFacts(closed)).rejects.toMatchObject({ browser_facts_substage: 'browser_facts_core', error_family: 'page_closed' });
  });

  it('BF-SERIALIZE-01 returns only bounded serializable facts', async () => {
    await fixture(`<script>window.Cookiebot={consent:{preferences:false,statistics:false,marketing:false},hasResponse:false};window.OneTrust={RejectAll(){},secret:'secret-fixture'}</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(() => structuredClone(facts)).not.toThrow();
      const plain = JSON.stringify(facts);
      expect(plain).not.toContain('secret-fixture');
      expect(plain.length).toBeLessThan(100_000);
    });
  });
});
