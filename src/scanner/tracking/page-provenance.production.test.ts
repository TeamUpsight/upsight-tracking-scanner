import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { isRequestForPdp } from './pdp-association';
import { PageProvenanceTracker, safeObservedPageUrl } from './page-provenance';
import type { TrackingRequestEvidence } from '../../types';

const hit = (overrides: Partial<TrackingRequestEvidence> = {}): TrackingRequestEvidence => ({
  vendor: 'ga4', kind: 'collection', collector: 'same_origin', host: '127.0.0.1', path: '/g/collect',
  method: 'GET', phase: 'product_pdp_load', timestamp: 1, event: 'page_view', ...overrides
});

describe('LN-02 browser page provenance', () => {
  it('advances epochs for pushState, replaceState, popstate, reload, and redirect commits', async () => {
    const server: Server = createServer((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: '/products/widget-new' }); response.end(); return; }
      if (request.url?.startsWith('/g/collect')) { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>fixture</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const root = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'allow' });
      const tracker = new PageProvenanceTracker();
      const existing = await context.newPage();
      tracker.attach(context); // Also covers pages existing before observer attachment.
      await existing.goto(`${root}/products/a`);
      const a = tracker.snapshot(existing);
      const requests: TrackingRequestEvidence[] = [];
      context.on('request', (request) => {
        if (!request.url().includes('/g/collect')) return;
        requests.push(hit({ ...tracker.forRequest(request), page_url: new URL(request.url()).searchParams.get('dl') || undefined }));
      });
      let mainFrameNavigations = 0;
      existing.on('framenavigated', (frame) => { if (frame === existing.mainFrame()) mainFrameNavigations += 1; });
      await existing.evaluate(() => history.pushState({}, '', '/products/b'));
      const b = tracker.snapshot(existing);
      expect(mainFrameNavigations).toBeGreaterThan(0);
      expect(b.observed_page_id).toBe(a.observed_page_id);
      expect(b.navigation_epoch).toBeGreaterThan(a.navigation_epoch!);
      await Promise.all([existing.waitForRequest((request) => request.url().includes('/g/collect?') && request.url().includes('dl=')), existing.evaluate(() => { new Image().src = '/g/collect?tid=G-FIXTURE&en=page_view&dl=' + encodeURIComponent(location.origin + '/products/a'); })]);
      expect(isRequestForPdp(requests[0], { url: `${root}/products/b`, ...b })).toBe(false);
      await Promise.all([existing.waitForRequest((request) => request.url().includes('/g/collect?') && !request.url().includes('dl=')), existing.evaluate(() => { new Image().src = '/g/collect?tid=G-FIXTURE&en=page_view'; })]);
      expect(isRequestForPdp(requests[1], { url: `${root}/products/b`, ...b })).toBe(true);
      await existing.evaluate(() => history.replaceState({}, '', '/products/c'));
      const c = tracker.snapshot(existing);
      expect(c.navigation_epoch).toBeGreaterThan(b.navigation_epoch!);
      await existing.evaluate(() => history.replaceState({}, '', '/products/c?variant=2#detail'));
      const queryRoute = tracker.snapshot(existing);
      expect(queryRoute.navigation_epoch).toBeGreaterThan(c.navigation_epoch!);
      expect(queryRoute.observed_page_url).toBe(`${root}/products/c`);
      await existing.evaluate(() => history.replaceState({}, '', '/products/c?variant=2#other'));
      expect(tracker.snapshot(existing).navigation_epoch).toBe(queryRoute.navigation_epoch);
      await existing.goBack();
      const back = tracker.snapshot(existing);
      expect(back.navigation_epoch).toBeGreaterThan(queryRoute.navigation_epoch!);
      await existing.reload();
      expect(tracker.snapshot(existing).navigation_epoch).toBeGreaterThan(back.navigation_epoch!);
      await existing.goto(`${root}/redirect`);
      const redirected = tracker.snapshot(existing);
      expect(redirected.observed_page_url).toBe(`${root}/products/widget-new`);
      expect(isRequestForPdp(hit({ ...redirected }), { url: `${root}/redirect`, final_url: `${root}/products/widget-new`, ...redirected })).toBe(true);
      const second = await context.newPage();
      expect(tracker.snapshot(second).observed_page_id).not.toBe(redirected.observed_page_id);
      const nextContext = await browser.newContext();
      tracker.attach(nextContext);
      const nextPage = await nextContext.newPage();
      expect(tracker.snapshot(nextPage).observed_page_id).not.toBe(redirected.observed_page_id);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('keeps Service Worker provenance unknown and sanitizes observed URLs', () => {
    const tracker = new PageProvenanceTracker();
    expect(tracker.forRequest({ serviceWorker: () => ({}), frame: () => { throw new Error('no frame'); } } as never)).toEqual({});
    expect(safeObservedPageUrl('https://user:secret@example.com/products/a?email=x#part')).toBe('https://example.com/products/a');
    expect(isRequestForPdp(hit({ source: 'service_worker', page_url: 'https://example.com/products/a' }), { url: 'https://example.com/products/a' })).toBe(true);
    expect(isRequestForPdp(hit({ source: 'service_worker' }), { url: 'https://example.com/products/a' })).toBe(false);
  });

  it('keeps a real Service Worker subrequest frameless', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/sw.js') {
        response.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' });
        response.end("self.addEventListener('fetch', event => { if (new URL(event.request.url).pathname === '/via-worker') event.respondWith(fetch('/g/collect?tid=G-TEST&en=page_view&dl=' + encodeURIComponent(self.location.origin + '/products/a'))); });");
        return;
      }
      response.writeHead(request.url?.startsWith('/g/collect') ? 204 : 200, { 'content-type': 'text/html' });
      response.end(request.url?.startsWith('/g/collect') ? '' : '<!doctype html><title>worker fixture</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'allow' });
      const tracker = new PageProvenanceTracker();
      tracker.attach(context);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/products/a`);
      await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
      await page.reload();
      expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
      const requestPromise = context.waitForEvent('request', (request) => request.url().includes('/g/collect?'));
      await page.evaluate(async () => { await fetch('/via-worker'); });
      const request = await requestPromise;
      expect(request.serviceWorker()).not.toBeNull();
      expect(tracker.forRequest(request)).toEqual({});
      const vendorUrl = new URL(request.url()).searchParams.get('dl')!;
      expect(isRequestForPdp(hit({ source: 'service_worker', page_url: vendorUrl }), { url: vendorUrl })).toBe(true);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
