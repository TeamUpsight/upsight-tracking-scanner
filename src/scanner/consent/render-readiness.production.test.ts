import { createServer } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapConsentV2ToExisting } from './compatibility-mapper';
import { attachRenderRuntimeDiagnostics, observeRenderedPage } from './render-readiness';
import { captureSharedConsentObservation, mergeSharedConsentObservation, prepareConsentV2Session, runConsentV2Session } from './v2-session';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

const spinner = '<div id="root" aria-busy="true"><div class="loading-overlay" style="position:fixed;inset:0;background:white"><div class="spinner">Loading...</div></div></div>';
const content = '<main><h1>Ordinary storefront</h1><p>Browse our collection of products and current offers.</p></main>';
const input = { geo: 'EU' as const, geo_verified: true, page_valid: true, appearance_wait_ms: 90, diagnostic: true };
const projection = (result: Awaited<ReturnType<typeof runConsentV2Session>>) => mapConsentV2ToExisting(result.result, {
  geo: 'EU', page_valid: true, tracking_before_interaction: false, post_reject_observation_completed: false
});

async function onPage<T>(html: string, inspect: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    await page.route('https://**/*', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.setContent(html);
    return await inspect(page);
  } finally { await page.close(); }
}

describe('Consent rendered-page completeness', () => {
  it('bounds a stalled browser evaluation as unknown', async () => {
    const stalled = {
      evaluate: () => new Promise(() => {}),
      isClosed: () => false,
      waitForTimeout: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    } as unknown as Page;
    const started = Date.now();
    expect((await observeRenderedPage(stalled, 700)).render_state).toBe('unknown');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps an HTTP-valid permanent app loading shell inconclusive', async () => {
    await onPage(spinner, async (page) => {
      const render = await observeRenderedPage(page, 200);
      expect(render).toMatchObject({ render_state: 'incomplete', app_root_detected: true, loading_indicator_detected: true, aria_busy_detected: true });
      const result = await runConsentV2Session(page, input);
      expect(result.telemetry.render_state).toBe('incomplete');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
      expect(projection(result)).toMatchObject({ consent_status: 'inconclusive' });
      expect(projection(result).cmp_provider).not.toBe('Not Found');
      expect(result.diagnostic_observation?.render).toMatchObject({ render_state: 'incomplete' });
    });
  }, 20_000);

  it('observes a slow SPA transition and resumes normal Consent processing', async () => {
    await onPage(`${spinner}<script>setTimeout(() => { document.querySelector('#root').remove(); document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(content)}); }, 450)</script>`, async (page) => {
      const render = await observeRenderedPage(page);
      expect(render).toMatchObject({ render_state: 'ready', render_state_changed: true });
      expect(render.render_wait_ms).toBeGreaterThanOrEqual(300);
      expect(render.render_wait_ms).toBeLessThan(2_500);
      const result = await runConsentV2Session(page, input);
      expect(result.telemetry.render_state).toBe('ready');
      expect(result.result.reason_codes).toContain('NO_CMP_DETECTED');
    });
  }, 20_000);

  it('keeps positive TCF evidence on an unresolved shell without earning CMP absence', async () => {
    await onPage(`${spinner}<script>window.__tcfapi=function(){};</script>`, async (page) => {
      const result = await runConsentV2Session(page, input);
      expect(result.telemetry.render_state).toBe('incomplete');
      expect(result.result.frameworks.tcf).not.toBe('not_present');
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  }, 20_000);

  it('preserves completed absence on a fully rendered no-CMP page', async () => {
    await onPage(content, async (page) => {
      const result = await runConsentV2Session(page, input);
      expect(result.telemetry.render_state).toBe('ready');
      expect(result.result.reason_codes).toContain('NO_CMP_DETECTED');
      expect(projection(result).cmp_provider).toBe('Not Found');
    });
  }, 20_000);

  it('leaves rendered generic CMP detection unchanged', async () => {
    await onPage(`${content}<div style="position:fixed;bottom:0;left:0;width:700px;height:180px;background:white">We use cookies and personal data to improve your experience.<button>Accept All</button><button>Reject All</button><button>Manage Preferences</button></div>`, async (page) => {
      const result = await runConsentV2Session(page, input);
      expect(result.telemetry.render_state).toBe('ready');
      expect(result.result.mechanisms.some((item) => item.mechanism === 'custom')).toBe(true);
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    });
  }, 20_000);

  it('retains shared provider evidence when fresh Consent remains a loading shell', async () => {
    const shared = await onPage(`${content}<script>window.OneTrust={RejectAll(){}};window.OnetrustActiveGroups='C001';</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk" style="position:fixed;bottom:0;width:700px;height:160px;background:white">Cookie choices<button id="onetrust-reject-all-handler">Reject all</button></div>`, (page) => captureSharedConsentObservation(page, undefined, true));
    expect(shared.provider).toBe('onetrust');
    await onPage(spinner, async (page) => {
      const fresh = await runConsentV2Session(page, input);
      const merged = mergeSharedConsentObservation(shared, fresh);
      expect(fresh.telemetry.render_state).toBe('incomplete');
      expect(fresh.result.reason_codes).not.toContain('NO_CMP_DETECTED');
      expect(merged.provider).toBe('onetrust');
      expect(merged.banner.visibility).toBe('visible');
    });
  }, 25_000);

  it('reproduces a sanitized HTTP 200 and DOMContentLoaded timeout with a persistent shell', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.write(`<html><body>${spinner}<script src="/delayed-bootstrap.js"></script>`);
      setTimeout(() => response.end('</body></html>'), 5_000);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a port');
    const page = await browser.newPage();
    try {
      await page.route('**/delayed-bootstrap.js', (route) => route.abort('failed'));
      const capture = await prepareConsentV2Session(page, true);
      capture.markNavigationStarted();
      const response = await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'commit' });
      expect(response?.status()).toBe(200);
      await expect(page.waitForLoadState('domcontentloaded', { timeout: 100 })).rejects.toThrow();
      const result = await runConsentV2Session(page, input, capture);
      expect(result.telemetry.render_state).toBe('incomplete');
      expect(result.diagnostic_observation?.render).toMatchObject({ render_state: 'incomplete', domcontentloaded_completed: false });
      expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
      expect(projection(result)).toMatchObject({ consent_status: 'inconclusive' });
      expect(projection(result).cmp_provider).not.toBe('Not Found');
    } finally {
      await page.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it('caps and sanitizes page errors and failed requests without promoting CMP evidence', async () => {
    const page = await browser.newPage();
    const diagnostics = attachRenderRuntimeDiagnostics(page);
    try {
      await page.route('https://assets.example.test/**', (route) => route.abort(new URL(route.request().url()).pathname === '/blocked' ? 'blockedbyclient' : 'failed'));
      await page.setContent(`${content}<script>setTimeout(() => { throw new TypeError('private query token=secret-value'); }, 0)</script>${Array.from({ length: 12 }, (_, i) => `<img src="https://assets.example.test/private/${i === 1 ? 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' : i}?secret=do-not-store">`).join('')}<img src="https://assets.example.test/blocked">`);
      await page.waitForTimeout(150);
      const snapshot = diagnostics.snapshot();
      expect(snapshot.page_error_count).toBeGreaterThan(0);
      expect(snapshot.page_error_families).toContain('script_runtime_error');
      expect(snapshot.page_error_families.length).toBeLessThanOrEqual(10);
      expect(snapshot.failed_request_count).toBe(12);
      expect(snapshot.failed_request_samples).toHaveLength(10);
      expect(snapshot.failed_request_samples[0]).toMatchObject({ host: 'assets.example.test', path: '/private/0', resource_type: 'image' });
      expect(snapshot.failed_request_samples[1].path).toBe('/private/:redacted');
      expect(snapshot.failed_request_samples.every((sample) => !sample.path.includes('blocked'))).toBe(true);
      expect(JSON.stringify(snapshot)).not.toMatch(/secret|do-not-store|private query/);
      const result = await runConsentV2Session(page, input);
      expect(result.telemetry.provider).toBeNull();
    } finally { diagnostics.dispose(); await page.close(); }
  }, 20_000);
});
