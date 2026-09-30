import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureBrowserConsentFacts, waitForConsentAppearance } from './browser-context-builders';
import { detectGenericConsentMechanism } from './generic-consent-detector';
import { chooseGeoInterstitialTarget, resolveGeoInterstitial } from './geo-interstitial';
import { cmpAbsenceEarned, runConsentV2Session } from './v2-session';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

async function fixture(html: string, inspect: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try { await page.setContent(html); await inspect(page); } finally { await page.close(); }
}

async function geoFixture(html: string, inspect: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    await page.route('https://shop.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto('https://shop.example.test/');
    await inspect(page);
  } finally { await page.close(); }
}

const banner = `<div class="x7-prompt" style="position:fixed;bottom:0;left:0;width:680px;height:180px;background:white;z-index:9999">
  We use cookies and personal data to improve your experience.
  <button>Accept All</button><button>Reject All</button><button>Manage Preferences</button>
</div>`;
const geo = (regional: string, alternative = '<button>No, I prefer the Global website</button>') =>
  `<div class="x7-prompt" role="dialog" style="position:fixed;top:20px;left:20px;width:550px;height:240px;background:white">
  Welcome. It looks like you are in the United States. Would you like to visit your local site?
  ${regional}${alternative}</div>`;
const input = { geo: 'USA' as const, geo_verified: true, page_valid: true, appearance_wait_ms: 450 };

describe('Consent Detection P0 browser fixtures', () => {
  it('allows remote evaluate delivery slack without extending the semantic window', async () => {
    const delayedPage = { evaluate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 195));
      return 'framework_only';
    } } as unknown as Page;
    const result = await waitForConsentAppearance(delayedPage, 120);
    expect(result).toMatchObject({ result: 'framework_only', semantic_window_ms: 120, outer_watchdog_ms: 1_620, watchdog_fired: false });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(175);
    expect(result.elapsed_ms).toBeLessThan(1_620);
  });

  it('marks a genuinely hung evaluate incomplete at the outer watchdog', async () => {
    const hungPage = { evaluate: () => new Promise(() => {}) } as unknown as Page;
    const result = await waitForConsentAppearance(hungPage, 50);
    expect(result).toMatchObject({ result: 'incomplete', semantic_window_ms: 50, outer_watchdog_ms: 1_550, watchdog_fired: true,
      incomplete_reason: 'outer_watchdog', retry_attempted: false, retry_reason: null, retry_ms: 0 });
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(1_500);
  });

  it('does not retry a closed page and records only the bounded reason', async () => {
    const page = await browser.newPage();
    let guardCalls = 0;
    try {
      await page.setContent('<main>Ordinary shop content</main>');
      const pending = waitForConsentAppearance(page, 400, async () => { guardCalls += 1; return true; });
      setTimeout(() => { void page.close(); }, 60);
      const result = await pending;
      expect(result).toMatchObject({ result: 'incomplete', incomplete_reason: 'page_closed', retry_attempted: false, retry_reason: null, retry_ms: 0 });
      expect(guardCalls).toBe(0);
      expect(JSON.stringify(result)).not.toMatch(/Target|closed while|Protocol error/);
    } finally {
      if (!page.isClosed()) await page.close();
    }
  });

  it('does not retry a recoverable error when the authoritative-page guard rejects it', async () => {
    let evaluations = 0;
    let guardCalls = 0;
    const replacedPage = {
      evaluate: async () => { evaluations += 1; throw new Error('Execution context was destroyed, most likely because of a navigation.'); },
      isClosed: () => false,
      context: () => ({ browser: () => ({ isConnected: () => true }) })
    } as unknown as Page;
    const result = await waitForConsentAppearance(replacedPage, 300, async () => { guardCalls += 1; return false; });
    expect(result).toMatchObject({ result: 'incomplete', incomplete_reason: 'execution_context_destroyed', retry_attempted: false });
    expect(evaluations).toBe(1);
    expect(guardCalls).toBe(1);
  });
  it('never earns absence from an initial empty capture before the appearance window completes', () => {
    const capture = { completion: 'skipped' } as Parameters<typeof cmpAbsenceEarned>[1];
    const facts = { generic: { surfaces: [], text_read_diagnostics: { dom_text_read_error_count: 0, control_text_read_error_count: 0 } } } as unknown as Parameters<typeof cmpAbsenceEarned>[2];
    const generic = { status: 'not_detected' } as Parameters<typeof cmpAbsenceEarned>[3];
    const selection = { provider: undefined, candidates: [], conflict: false } as Parameters<typeof cmpAbsenceEarned>[4];
    const frameworks = { tcf: 'not_present', gpp: 'not_present' } as Parameters<typeof cmpAbsenceEarned>[5];
    expect(cmpAbsenceEarned(input, capture, facts, generic, selection, frameworks)).toBe(false);
    expect(cmpAbsenceEarned({ ...input, render_state: 'ready' }, { ...capture, completion: 'appearance_absent' }, facts, generic, selection, frameworks)).toBe(true);
    expect(cmpAbsenceEarned({ ...input, render_state: 'incomplete' }, { ...capture, completion: 'appearance_absent' }, facts, generic, selection, frameworks)).toBe(false);
    expect(cmpAbsenceEarned({ ...input, geo_interstitial_unresolved: true }, { ...capture, completion: 'appearance_absent' }, facts, generic, selection, frameworks)).toBe(false);
  });

  it('observes a delayed arbitrary-class custom banner and attributes an unknown custom CMP', async () => {
    await fixture(`<script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(banner)}), 180)</script>`, async (page) => {
      const result = await runConsentV2Session(page, { ...input, diagnostic: true });
      expect(result.result.mechanisms).toEqual(expect.arrayContaining([expect.objectContaining({ mechanism: 'custom', provider: expect.objectContaining({ attribution: 'unknown_candidate' }) })]));
      expect(result.result.banner.visibility).toBe('visible');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
      // Render readiness can observe the delayed banner before the Consent appearance snapshot.
      expect(['ui_appeared', 'not_required']).toContain(result.telemetry.consent_appearance_wait_result);
    });
  });

  it('waits past early TCF/GPP stubs for a later arbitrary-class consent banner', async () => {
    await fixture(`<main>Ordinary shop</main><script>
      setTimeout(() => { window.__tcfapi = function() {}; window.__gpp = function() {}; }, 240);
      setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(banner)}), 1150);
    </script>`, async (page) => {
      const result = await runConsentV2Session(page, { ...input, appearance_wait_ms: 1_600, diagnostic: true });
      expect(result.telemetry.consent_appearance_wait_result).toBe('ui_appeared');
      expect(result.telemetry.consent_appearance_wait_ms).toBeGreaterThanOrEqual(700);
      expect(result.telemetry.consent_appearance_wait_ms).toBeLessThan(1_600);
      expect(result.result.frameworks.tcf).not.toBe('not_present');
      expect(result.result.frameworks.gpp).not.toBe('not_present');
      expect(result.result.mechanisms).toEqual(expect.arrayContaining([expect.objectContaining({ mechanism: 'custom' })]));
      expect(result.result.banner.visibility).toBe('visible');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
      expect(result.diagnostic_observation?.readiness?.final.strong_surface_count).toBeGreaterThan(0);
    });
  }, 15_000);

  it('observes the full short window for framework-only runtime and keeps absence inconclusive', async () => {
    await fixture('<main>Ordinary shop</main><script>window.__tcfapi=function(){};window.__gpp=function(){};</script>', async (page) => {
      const appearance = await waitForConsentAppearance(page, 120);
      expect(appearance.result).toBe('framework_only');
      expect(appearance.elapsed_ms).toBeGreaterThanOrEqual(100);
      const result = await runConsentV2Session(page, { ...input, appearance_wait_ms: 120 });
      expect(result.telemetry.consent_appearance_wait_result).toBe('framework_only');
      expect(result.telemetry.consent_appearance_wait_ms).toBeGreaterThanOrEqual(100);
      expect(result.telemetry.consent_appearance_watchdog_fired).toBe(false);
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  });

  it('does not turn a provider runtime without visible UI into UI appearance', async () => {
    await fixture('<main>Ordinary shop</main><script>window.OneTrust={};</script>', async (page) => {
      expect((await waitForConsentAppearance(page, 120)).result).toBe('framework_only');
      const result = await runConsentV2Session(page, { ...input, appearance_wait_ms: 120 });
      expect(result.telemetry.consent_appearance_wait_result).not.toBe('ui_appeared');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  });

  it('finds a fixed custom banner without cookie or consent markers in its class or id', async () => {
    await fixture(banner, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces).toEqual(expect.arrayContaining([expect.objectContaining({ visible: true, strong_presentation: true, privacy_or_cookie_semantics: true, intent: 'consent' })]));
      expect(detectGenericConsentMechanism(facts.generic.surfaces as any, facts.generic.controls).status).toBe('detected');
    });
  });

  it('finds the same arbitrary-class custom banner in an open shadow root', async () => {
    await fixture(`<div id="host"></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(banner)}</script>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces).toEqual(expect.arrayContaining([expect.objectContaining({ location: 'shadow_dom', strong_presentation: true, privacy_or_cookie_semantics: true })]));
      expect(detectGenericConsentMechanism(facts.generic.surfaces as any, facts.generic.controls).status).toBe('detected');
    });
  });

  it('earns absence only after a completed appearance window', async () => {
    await fixture('<main><h1>Ordinary shop</h1></main>', async (page) => {
      expect((await waitForConsentAppearance(page, 90)).result).toBe('absent');
      const result = await runConsentV2Session(page, { ...input, appearance_wait_ms: 90 });
      expect(result.telemetry.consent_appearance_wait_result).toBe('absent');
      expect(result.result.reason_codes).toContain('NO_CMP_DETECTED');
    });
  });

  it('keeps an immediately visible custom CMP without an absence wait', async () => {
    await fixture(banner, async (page) => {
      const result = await runConsentV2Session(page, { ...input, appearance_wait_ms: 400 });
      expect(result.telemetry.consent_appearance_wait_triggered).toBe(false);
      expect(result.telemetry.consent_appearance_wait_result).toBe('not_required');
      expect(result.result.banner.visibility).toBe('visible');
      expect(result.result.mechanisms.some((mechanism) => mechanism.mechanism === 'custom')).toBe(true);
    });
  });

  it('keeps unreadable delayed privacy presentation inconclusive', async () => {
    await fixture(`<script>setTimeout(() => { const el=document.createElement('div'); el.className='x7-prompt'; el.style='position:fixed;width:400px;height:160px';
      Object.defineProperty(el,'innerText',{get(){throw new Error('fixture')}}); Object.defineProperty(el,'textContent',{get(){throw new Error('fixture')}});
      document.body.appendChild(el); }, 70)</script>`, async (page) => {
      const result = await runConsentV2Session(page, { ...input, appearance_wait_ms: 300 });
      expect(result.result.reason_codes).toContain('DETECTION_INCONCLUSIVE');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  });

  it.each([
    ['newsletter', 'Subscribe to our newsletter. Enter your email.'],
    ['login', 'Sign in to your account.'],
    ['age gate', 'Confirm your age. Are you 18?']
  ])('does not make a %s modal a CMP', async (_name, copy) => {
    await fixture(`<div class="x7-prompt" style="position:fixed;width:400px;height:180px">${copy}<button>Continue</button></div>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(detectGenericConsentMechanism(facts.generic.surfaces as any, facts.generic.controls).status).toBe('not_detected');
    });
  });

  it('classifies the sanitized USA/Global selector and activates one USA control', async () => {
    await geoFixture('<main>Global catalog</main>' + geo(`<button onclick="history.pushState({},'', '/us'); document.querySelector('main').textContent='USA catalog'; this.parentElement.remove()">YES, TAKE ME TO THE USA SITE</button>`), async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.surfaces[0]).toMatchObject({ intent: 'country_selector', privacy_or_cookie_semantics: false });
      const decision = await resolveGeoInterstitial(page, facts, 'USA', 'US', true, (url) => new URL(url).hostname === 'shop.example.test', 800);
      expect(decision).toMatchObject({ resolution: 'resolved', target_match: 'exact', action_taken: true });
      expect(page.url()).toBe('https://shop.example.test/us');
    });
  });

  it('detects a delayed regional custom CMP after one geo navigation epoch', async () => {
    await geoFixture('<main>Global catalog</main>' + geo('<button id="us-choice">YES, TAKE ME TO THE USA SITE</button>') +
      `<script>document.querySelector('#us-choice').addEventListener('click', () => {
        history.pushState({},'', '/us'); document.querySelector('main').textContent='USA catalog'; document.querySelector('.x7-prompt').remove();
        setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(banner)}), 90);
      });</script>`, async (page) => {
      const decision = await resolveGeoInterstitial(page, await captureBrowserConsentFacts(page), 'USA', 'US', true, (url) => new URL(url).hostname === 'shop.example.test', 800);
      expect(decision.resolution).toBe('resolved');
      const result = await runConsentV2Session(page, input);
      expect(result.result.mechanisms.some((mechanism) => mechanism.mechanism === 'custom')).toBe(true);
      expect(result.result.banner.visibility).toBe('visible');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  });

  it('leaves ambiguous and unsafe geo targets unresolved without clicking', async () => {
    await fixture(geo('<button>Take me to USA</button><button>Visit US site</button>'), async (page) => {
      const decision = await resolveGeoInterstitial(page, await captureBrowserConsentFacts(page), 'USA', 'US', true, () => true, 800);
      expect(decision).toMatchObject({ resolution: 'ambiguous', action_taken: false });
      const result = await runConsentV2Session(page, { ...input, geo_interstitial_unresolved: true, appearance_wait_ms: 70 });
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
    await fixture(geo('<a href="http://127.0.0.1/internal">Take me to USA</a>'), async (page) => {
      const decision = await resolveGeoInterstitial(page, await captureBrowserConsentFacts(page), 'USA', 'US', true, (url) => new URL(url).hostname !== '127.0.0.1', 800);
      expect(decision).toMatchObject({ resolution: 'target_unverified', action_taken: false });
      const result = await runConsentV2Session(page, { ...input, geo_interstitial_unresolved: true, geo_interstitial_target_unverified: true, appearance_wait_ms: 70 });
      expect(result.result.reason_codes).toContain('GEO_INTERSTITIAL_TARGET_UNVERIFIED');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  });

  it('maps an EU selector only to the verified exact country', async () => {
    await fixture(`<div role="dialog" style="position:fixed;width:450px;height:160px">Choose your country to visit your local site.
      <button>Take me to Germany</button><button>Take me to France</button><button>Global site</button></div>`, async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(chooseGeoInterstitialTarget(facts, 'EU', 'DE', true)).toMatchObject({ detected: true, match: 'exact', control: { accessible_name: 'Take me to Germany' } });
      expect(chooseGeoInterstitialTarget(facts, 'EU', 'ES', true)).toMatchObject({ detected: true, match: 'none', control: null });
    });
  });

  it('does not accept a regional navigation that returns an HTTP error', async () => {
    const page = await browser.newPage();
    try {
      await page.route('https://shop.example.test/**', (route) => route.fulfill({
        status: route.request().url().endsWith('/us') ? 404 : 200,
        contentType: 'text/html',
        body: route.request().url().endsWith('/us') ? '<main>Not found</main>' : '<main>Global shop</main>' + geo('<a href="/us">Take me to USA</a>')
      }));
      await page.goto('https://shop.example.test/');
      const decision = await resolveGeoInterstitial(page, await captureBrowserConsentFacts(page), 'USA', 'US', true,
        (url) => new URL(url).hostname === 'shop.example.test', 1_500);
      expect(decision).toMatchObject({ action_taken: true, resolution: 'target_unverified' });
    } finally { await page.close(); }
  });
});
