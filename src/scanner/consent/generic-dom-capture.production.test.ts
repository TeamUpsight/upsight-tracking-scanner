import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureBrowserConsentFacts } from './browser-context-builders';
import { detectGenericConsentMechanism } from './generic-consent-detector';
import { BrowserFactsCaptureError } from './observation-stage';
import { captureSharedConsentObservation } from './v2-session';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

async function fixture(html: string, check: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try { await page.setContent(html); await check(page); } finally { await page.close(); }
}

const consentDialog = '<div id="dialog" role="dialog" style="display:block;width:320px;height:120px">Cookie consent <button>Accept all</button><button>Reject all</button></div>';

describe('generic DOM text capture and operation attribution', () => {
  it('DOM-01 normal generic surface retains established facts', async () => {
    await fixture(consentDialog, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces[0]).toMatchObject({ privacy_or_cookie_semantics: true, text_evidence_available: true, intent: 'consent', visible: true });
      expect(facts.generic.controls.map((control) => control.accessible_name)).toEqual(expect.arrayContaining(['Accept all', 'Reject all']));
      expect(facts.generic.text_read_diagnostics).toEqual({ dom_text_read_error_count: 0, control_text_read_error_count: 0, dom_text_fallback_used: false });
    });
  });

  it('DOM-02 custom element innerText ReferenceError falls back to textContent', async () => {
    await fixture(`<consent-fixture class="cookie-panel" role="dialog" style="display:block;width:320px;height:120px">Cookie consent <button>Accept all</button><button>Reject all</button></consent-fixture><script>Object.defineProperty(document.querySelector('consent-fixture'),'innerText',{get(){throw new ReferenceError('fixture-only')}})</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces[0]).toMatchObject({ privacy_or_cookie_semantics: true, text_evidence_available: true, intent: 'consent' });
      expect(facts.generic.text_read_diagnostics).toMatchObject({ dom_text_read_error_count: 1, dom_text_fallback_used: true });
      expect(JSON.stringify(facts)).not.toContain('fixture-only');
      const shared = await captureSharedConsentObservation(page, undefined, true);
      expect(shared.diagnostic_observation).toMatchObject({ dom_text_read_error_count: 1, dom_text_fallback_used: true });
    });
  });

  it('DOM-03 both surface text sources fail without positive consent evidence', async () => {
    await fixture(`<div id="dialog" role="dialog" style="display:block;width:320px;height:120px"><button>Accept all</button><button>Reject all</button></div><script>for(const key of ['innerText','textContent'])Object.defineProperty(document.querySelector('#dialog'),key,{get(){throw new ReferenceError('fixture-only')}})</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces[0]).toMatchObject({ privacy_or_cookie_semantics: false, text_evidence_available: false, intent: 'unknown' });
      expect(facts.generic.text_read_diagnostics?.dom_text_read_error_count).toBe(2);
      expect(detectGenericConsentMechanism(facts.generic.surfaces as Parameters<typeof detectGenericConsentMechanism>[0], facts.generic.controls).status).toBe('inconclusive');
    });
  });

  it('DOM-04 control textContent failure leaves a valid aria-label intact', async () => {
    await fixture(`<div role="dialog">Cookie consent <button id="choice" aria-label="Reject all"></button></div><script>Object.defineProperty(document.querySelector('#choice'),'textContent',{get(){throw new TypeError('fixture-only')}})</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.controls.find((control) => control.accessible_name === 'Reject all')).toMatchObject({ actionable: true });
    });
  });

  it('DOM-05 all approved label sources failing leaves an unnamed nonactionable control', async () => {
    await fixture(`<div role="dialog">Cookie consent <button id="choice">Reject all</button></div><script>
      const button=document.querySelector('#choice');const original=button.getAttribute.bind(button);
      button.getAttribute=(name)=>{if(name==='aria-label'||name==='title')throw new TypeError('fixture-only');return original(name)};
      Object.defineProperty(button,'textContent',{get(){throw new TypeError('fixture-only')}});
    </script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.controls[0]).toMatchObject({ accessible_name: '', actionable: false });
      expect(facts.generic.text_read_diagnostics?.control_text_read_error_count).toBeGreaterThan(0);
      expect(detectGenericConsentMechanism(facts.generic.surfaces as Parameters<typeof detectGenericConsentMechanism>[0], facts.generic.controls).action_plan).toEqual([]);
    });
  });

  it('DOM-05B input value failure uses the existing title fallback', async () => {
    await fixture(`<div role="dialog">Cookie consent <input id="choice" type="button" title="Reject all"></div><script>Object.defineProperty(document.querySelector('#choice'),'value',{get(){throw new TypeError('fixture-only')}})</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.controls[0].accessible_name).toBe('Reject all');
      expect(facts.generic.text_read_diagnostics?.control_text_read_error_count).toBeGreaterThan(0);
    });
  });

  it('DOM-06 structural enumeration failure stays fatal and attributed', async () => {
    await fixture(`<script>document.querySelectorAll=()=>{throw new ReferenceError('fixture-only')}</script>`, async (page) => {
      await expect(captureBrowserConsentFacts(page)).rejects.toMatchObject({ browser_facts_substage: 'generic_surface_enumeration', error_family: 'reference_error' });
    });
  });

  it('DOM-07 surface style and control visibility failures remain fatal and distinct', async () => {
    await fixture(`<div role="dialog" style="width:300px;height:100px">Cookie consent</div><script>window.getComputedStyle=()=>{throw new TypeError('fixture-only')}</script>`, async (page) => {
      await expect(captureBrowserConsentFacts(page)).rejects.toMatchObject({ browser_facts_substage: 'generic_surface_style', error_family: 'type_error' });
    });
    await fixture(`<div role="dialog">Cookie consent <button id="choice">Reject all</button></div><script>document.querySelector('#choice').getBoundingClientRect=()=>{throw new TypeError('fixture-only')}</script>`, async (page) => {
      await expect(captureBrowserConsentFacts(page)).rejects.toMatchObject({ browser_facts_substage: 'generic_control_visibility', error_family: 'type_error' });
    });
  });

  it('DOM-08 independent Usercentrics asset and known root survive generic text failure', async () => {
    await fixture(`<script type="application/json" src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script><aside id="usercentrics-cmp-ui" style="display:block;width:320px;height:120px"></aside><div id="dialog" role="dialog">Cookie consent</div><script>
      window.UC_UI={isInitialized(){return true},getServicesBaseInfo(){return []}};
      document.querySelector('#usercentrics-cmp-ui').attachShadow({mode:'open'}).innerHTML='<button>Alles ablehnen</button>';
      Object.defineProperty(document.querySelector('#dialog'),'innerText',{get(){throw new ReferenceError('fixture-only')}});
    </script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.assets.some((asset) => asset.includes('app.usercentrics.eu/browser-ui/latest/loader.js'))).toBe(true);
      expect(facts.usercentrics).toMatchObject({ present: true, shadow_mode: 'open', runtime_version: 'v2_uc_ui' });
      expect(facts.generic.text_read_diagnostics?.dom_text_read_error_count).toBeGreaterThan(0);
      const shared = await captureSharedConsentObservation(page);
      expect(shared.provider).toBe('usercentrics');
    });
  });

  it('DOM-09 unknown unreadable dialog is inconclusive without generic action eligibility', async () => {
    await fixture(`<div id="dialog" role="dialog" style="display:block;width:320px;height:120px"><button>Reject all</button></div><script>for(const key of ['innerText','textContent'])Object.defineProperty(document.querySelector('#dialog'),key,{get(){throw new TypeError('fixture-only')}})</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      const generic = detectGenericConsentMechanism(facts.generic.surfaces as Parameters<typeof detectGenericConsentMechanism>[0], facts.generic.controls);
      expect(generic).toMatchObject({ status: 'inconclusive', mechanism: null, action_plan: [] });
      expect(facts.generic.surfaces[0].privacy_or_cookie_semantics).toBe(false);
    });
  });

  it('DOM-10 nested shadow traversal still completes', async () => {
    await fixture(`<div id="host"></div><script>const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<div role="dialog">Cookie consent<div id="nested"></div></div>';root.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<button>Reject all</button>'</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces.some((surface) => surface.location === 'shadow_dom')).toBe(true);
    });
  });

  it('DOM-11 Usercentrics evaluation retains separate attribution', async () => {
    await fixture(`<script>Object.defineProperty(window,'__upsightUsercentricsLifecycle',{get(){throw new ReferenceError('fixture-only')}})</script>`, async (page) => {
      await expect(captureBrowserConsentFacts(page)).rejects.toMatchObject({ browser_facts_substage: 'usercentrics_lifecycle', error_family: 'reference_error' });
    });
  });

  it('DOM-12 destroyed execution context remains fatal', async () => {
    const destroyed = { evaluate: async () => { throw new Error('Execution context was destroyed'); } } as unknown as Page;
    await expect(captureBrowserConsentFacts(destroyed)).rejects.toBeInstanceOf(BrowserFactsCaptureError);
    await expect(captureBrowserConsentFacts(destroyed)).rejects.toMatchObject({ browser_facts_substage: 'browser_facts_core', error_family: 'execution_context_destroyed' });
  });
});
