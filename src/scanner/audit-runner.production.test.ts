import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStorefrontAudit, type AuditRunnerDependencies } from './audit-runner';
import type { StorefrontAudit } from '../types';
import { buildDebugPackageFiles } from './quality/debug-package';

// Full-runner fixtures validate orchestration, not wall-clock dwell time. Keep
// the production constants intact while making each bounded observation short
// enough for the local browser test process.
vi.mock('./version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./version')>();
  return { ...actual, PDP_POST_LOAD_OBSERVATION_MS: 1_000, PDP_MIN_TRACKING_OBSERVATION_MS: 250 };
});

const resolvedFixtureHost = async () => ({ status: 'resolved' as const, sources: { fixture: 'resolved' as const } });

type FixtureRoute = string | null | { body: string; status: number };
type FixtureHtml = string | Record<string, FixtureRoute> | ((path: string) => FixtureRoute);

async function fixtureServer(status: number, html: FixtureHtml) {
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://fixture.example').pathname;
    const route = typeof html === 'function' ? html(path) : typeof html === 'string' ? html : Object.prototype.hasOwnProperty.call(html, path) ? html[path] : html['/'] ?? '';
    if (route === null) return;
    const body = (typeof route === 'string' ? route : route.body).replaceAll('{{fixture_url}}', `http://${request.headers.host}`);
    response.writeHead(typeof route === 'string' ? status : route.status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Full-runner fixture server did not expose a TCP port.');
  return { server, url: `http://fixture.example:${address.port}/` };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function auditFixture(
  status: number,
  html: FixtureHtml,
  consentV2Enabled = true,
  selected_modules: Array<'consent' | 'tracking' | 'server_side'> = ['consent'],
  actionsEnabled = consentV2Enabled,
  dependencies: Pick<AuditRunnerDependencies, 'createFreshConsentContext'> = {},
  scanMode: 'normal' | 'diagnostic' = 'normal'
) {
  vi.stubEnv('BROWSER_PROVIDER', 'local');
  vi.stubEnv('CONSENT_V2_ENABLED', consentV2Enabled ? 'true' : 'false');
  vi.stubEnv('CONSENT_V2_ACTIONS_ENABLED', actionsEnabled ? 'true' : 'false');
  vi.stubEnv('CONSENT_ONETRUST_ACTIONS_ENABLED', actionsEnabled ? 'true' : 'false');
  vi.stubEnv('CONSENT_V2_ACTION_SAMPLE_PERCENT', actionsEnabled ? '100' : '0');
  const fixture = await fixtureServer(status, html);
  const updates: Array<Record<string, unknown>> = [];
  try {
    await runStorefrontAudit({
      audit_id: `runner-${status}-${consentV2Enabled}`,
      domain: 'fixture.example',
      tested_geos: 'EU',
      scan_mode: scanMode,
      selected_modules
    }, async (update) => { updates.push(update as Record<string, unknown>); }, {
      storefrontUrl: fixture.url,
      resolveHostname: resolvedFixtureHost,
      consentGeoVerified: true,
      ...dependencies,
      launchBrowser: () => chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        args: ['--host-resolver-rules=MAP fixture.example 127.0.0.1'],
        headless: true
      })
    });
  } finally {
    await closeServer(fixture.server);
  }
  return updates.at(-1) || {};
}

afterEach(() => vi.unstubAllEnvs());

describe('runStorefrontAudit production browser wiring', () => {
  const oneTrust = `<script>window.OneTrust={RejectAll(){ window.__rejectCalled = true; }};</script><script src="/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div>`;
  const verifiedOneTrust = `<script>
    let listener; let rejected = false;
    const state = () => ({ listenerId: 1, eventStatus: rejected ? 'useractioncomplete' : 'tcloaded', purpose: { consents: { 1: !rejected, 2: !rejected } }, vendor: { consents: { 1: !rejected, 2: !rejected } } });
    window.__tcfapi = (command, version, callback) => { if (command === 'ping') callback({ cmpLoaded: true, apiVersion: '2.2', gdprApplies: true }, true); if (command === 'addEventListener') { listener = callback; callback(state(), true); } };
    window.OneTrust = { RejectAll() {} }; window.OnetrustActiveGroups = 'C001';
    function reject() { rejected = true; document.cookie = 'OptanonConsent=present; path=/'; window.dispatchEvent(new Event('OTConsentApplied')); setTimeout(() => listener?.(state(), true), 0); }
  </script><script src="/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="reject()">Reject all</button></div>`;

  it('RUNNER-V2-01 finalizes Consent V2 compatibility fields from the real runner', async () => {
    const result = await auditFixture(200, oneTrust);
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'inconclusive', scan_status: 'completed' });
    expect((result.finding_confidence as { consent?: { reason_code?: string } } | undefined)?.consent?.reason_code).toBe('CMP_REJECT_NOT_VERIFIED');
    expect(JSON.parse(String(result.trace_steps))).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'cmp_provider_detected' }),
      expect.objectContaining({ step: 'consent_context_started', module: 'consent', severity: 'info' }),
      expect.objectContaining({ step: 'scan_finalized', module: 'runtime', severity: 'success' })
    ]));
    expect((result.runtime_metrics as { consent_v2?: { enabled: boolean } }).consent_v2?.enabled).toBe(true);
  }, 30_000);

  it('RUNNER-V2-PASS-01 persists a verified Consent V2 pass through the canonical finalization path', async () => {
    const result = await auditFixture(200, verifiedOneTrust);
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'pass', overall_status: 'pass', scan_status: 'completed' });
    expect((result.evidence_bundle as { decision_summary: Array<{ decision_name: string; status: string }> }).decision_summary)
      .toEqual(expect.arrayContaining([expect.objectContaining({ decision_name: 'consent', status: 'pass' })]));
  }, 30_000);

  it('RUNNER-V2-02 maps pre-choice tracking to the final consent status', async () => {
    const result = await auditFixture(200, `<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G111';</script></head>${oneTrust}`);
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'prior_consent_violation', scan_status: 'completed' });
  }, 30_000);

  it('CMP-SURVIVE-01 retains completed shared OneTrust observation when fresh V2 setup is unavailable', async () => {
    const sharedOnly = `<script>document.cookie='OptanonConsent=present; path=/'; window.OneTrust={RejectAll(){},AllowAll(){}};</script>
      <script src="/otSDKStub.js"></script><div role="dialog" aria-modal="true"><p>We use cookies and value your privacy.</p><button>Accept All Cookies</button><button>Reject All Cookies</button><button>Cookies Settings</button></div>`;
    const result = await auditFixture(200, sharedOnly, true, ['consent'], false, {
      createFreshConsentContext: async () => { throw new Error('PAGE_CONTEXT_UNAVAILABLE'); }
    });
    const evidence = result.evidence_bundle as { consent: { banner_visible: boolean | null; accept_action_available: boolean; reject_action_available: boolean; preferences_action_available: boolean; interaction_attempted: boolean }; runtime: { consent_v2?: { session_status?: string; observation_only?: boolean; shared_observation?: { provider: string | null; banner_visibility: string } } } };
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'inconclusive' });
    expect(evidence.consent).toMatchObject({ banner_visible: true, accept_action_available: true, reject_action_available: true, preferences_action_available: true, interaction_attempted: false });
    expect(evidence.runtime.consent_v2).toMatchObject({ session_status: 'unavailable', observation_only: true, shared_observation: { provider: 'onetrust', banner_visibility: 'visible' } });
  }, 30_000);

  it('WP11.5-RUNNER-UC-SHARED-01 installs the lifecycle bootstrap before the shared homepage navigation', async () => {
    const fixture = `<script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script><script>
      window.UC_UI={isInitialized:()=>true};
      window.__wp115BootstrapMarkerSeen=window.__upsightConsentBootstrapInstalled===true;
      if(window.__wp115BootstrapMarkerSeen){
        window.dispatchEvent(new Event('UC_UI_INITIALIZED'));
        window.dispatchEvent(new CustomEvent('UC_UI_CMP_EVENT',{detail:{type:'CMP_SHOWN'}}));
        window.dispatchEvent(new CustomEvent('UC_UI_VIEW_CHANGED',{detail:{view:'FIRST_LAYER'}}));
      }
    </script>`;
    const result = await auditFixture(200, fixture, true, ['consent'], false, {
      createFreshConsentContext: async () => { throw new Error('fresh-context-intentionally-unavailable'); }
    });
    const telemetry = (result.evidence_bundle as { runtime: { consent_v2?: { shared_observation?: { provider: string | null; banner_visibility: string } } } }).runtime.consent_v2;
    expect(telemetry?.shared_observation).toMatchObject({ provider: 'usercentrics', banner_visibility: 'visible' });
  }, 30_000);

  it('WP11.5-RUNNER-MERGE-IDEMPOTENT-01 keeps providerless fresh evidence distinct across ordinary finalization', async () => {
    const sharedDidomi = `<script>window.Didomi={notice:{isVisible:()=>true}};</script><script src="https://sdk.privacy-center.org/loader.js"></script>
      <section id="didomi-notice" role="dialog" style="position:fixed;width:360px;height:180px">Cookies
        <button>Personnaliser</button><button>Tout accepter</button>
      </section>`;
    const result = await auditFixture(200, sharedDidomi, true, ['consent'], false, {
      createFreshConsentContext: async (browser, input) => {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Fresh providerless observation</main>' }));
        return {
          context,
          page,
          service_workers: 'blocked' as const,
          geo: { requested_geo: input.requestedGeo, proxy_region: input.proxyRegion, verified: true, verification_method: 'egress_probe' as const, confidence: 'high' as const, reason_codes: [] }
        };
      }
    }, 'diagnostic') as unknown as StorefrontAudit;
    const evidence = result.evidence_bundle!;
    const shared = evidence.diagnostic_observability?.consent_observations.find((observation) => observation.context === 'shared');
    const fresh = evidence.diagnostic_observability?.consent_observations.find((observation) => observation.context === 'fresh');
    const observability = JSON.parse(String(buildDebugPackageFiles(result)['observability-consistency.json'])) as { checks: Array<{ code: string; status: string }> };

    expect(shared).toMatchObject({ provider_selection: { selected_provider: 'didomi' }, banner: { visibility: 'visible' } });
    expect(fresh).toMatchObject({ observation_complete: true, provider_selection: { selected_provider: null, candidates: [] }, banner: { visibility: 'not_visible' }, visible_surfaces: [], visible_controls: [] });
    expect(evidence.runtime.consent_v2).toMatchObject({ provider: 'didomi', banner_visibility: 'visible' });
    expect(evidence.consent).toMatchObject({ banner_visible: true, accept_action_available: true, preferences_action_available: true });
    expect(observability.checks.find((check) => check.code === 'OBS_CONSENT_SURFACE_BANNER_MISMATCH')?.status).toBe('pass');
  }, 35_000);

  it('RUNNER-TESCO-OBS-01 keeps homepage PDP discovery when sitemap enrichment hangs and records an observation-only OneTrust session', async () => {
    const customOneTrust = `<script>window.OneTrust={RejectAll(){window.__rejectCalled=true},AllowAll(){}};</script><script src="/otSDKStub.js"></script><div id="onetrust-banner-sdk" style="display:none"></div>
      <div role="dialog" aria-modal="true"><p>We use cookies and value your privacy.</p><button>Accept all</button><button>Reject all</button></div>`;
    const result = await auditFixture(200, {
      '/': `${customOneTrust}<a href="/products/widget">Widget</a><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';</script>`,
      '/products/widget': `${customOneTrust}<form action="/cart/add"><button>Add to cart</button></form><script>window.dataLayer=[{event:'view_item',ecommerce:{items:[{item_id:'widget',item_name:'Widget'}]}}]</script>`,
      '/sitemap.xml': null
    }, true, ['consent', 'tracking'], false);
    const evidence = result.evidence_bundle as { consent: { banner_visible: boolean; reject_action_available: boolean; interaction_attempted: boolean }; product: { pdp_candidates: string[]; sitemap_enrichment_status: string; candidate_outcomes: Array<{ source?: string }> }; decision_summary: Array<{ decision_name: string; status: unknown; blocking_uncertainty: string[] }> };
    const trace = JSON.parse(String(result.trace_steps)) as Array<{ step: string }>;
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'inconclusive', product_payload_status: 'pass', site_ga4_detected: true, scan_status: 'completed' });
    expect(evidence.consent).toMatchObject({ banner_visible: true, reject_action_available: true, interaction_attempted: false });
    expect(evidence.product).toMatchObject({ sitemap_enrichment_status: 'timed_out' });
    expect(evidence.product.pdp_candidates).toEqual(expect.arrayContaining([expect.stringContaining('/products/widget')]));
    expect(evidence.product.candidate_outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'homepage_link' })]));
    expect(trace.filter((item) => item.step === 'consent_context_started')).toHaveLength(1);
    expect(trace.some((item) => item.step === 'cmp_reject_executed' || item.step === 'consent_pdp_reject_completed')).toBe(false);
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'consent_observation_only' })]));
    expect(evidence.decision_summary.find((item) => item.decision_name === 'ga4')).toMatchObject({ status: true, blocking_uncertainty: [] });
  }, 45_000);

  it('LISTING-01 through LISTING-06 promote one bounded child PDP without spending PDP grace on the listing', async () => {
    const customOneTrust = `<script>window.OneTrust={RejectAll(){},AllowAll(){}};</script><script src="/otSDKStub.js"></script><div id="onetrust-banner-sdk" style="display:none"></div>
      <div role="dialog" aria-modal="true"><p>We use cookies and value your privacy.</p><button>Accept all</button><button>Reject all</button></div>`;
    const result = await auditFixture(200, {
      '/': `${customOneTrust}<a href="/collections/all">Shop all products</a><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';</script>`,
      '/collections/all': `${customOneTrust}<main class="collection"><script>window.dataLayer=[{event:'view_item_list', ecommerce:{items:[{item_id:'a'},{item_id:'b'}]}}]</script><article class="product-card"><a href="/products/widget">Buy product Widget</a><span>$10</span></article><article class="product-card"><a href="/products/other">Other</a><span>$12</span></article><button>Add to cart</button><button>Add to cart</button></main>`,
      '/products/other': `<main>Not used</main>`,
      '/products/widget': `${customOneTrust}<form action="/cart/add"><button>Add to cart</button></form><script>window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'widget',item_name:'Widget'}]}}]</script>`,
      '/sitemap.xml': null
    }, true, ['consent', 'tracking'], false);
    const evidence = result.evidence_bundle as { product: { candidate_outcomes: Array<{ page_role?: string; outcome: string; promoted_from?: string | null }>; candidate_discovered_count: number; candidate_queued_count: number; candidate_promoted_count: number; candidate_attempted_count: number; candidate_completed_count: number } };
    const trace = JSON.parse(String(result.trace_steps)) as Array<{ step: string; candidate_url?: string }>;
    expect(result).toMatchObject({ consent_status: 'inconclusive', product_payload_status: 'pass', site_ga4_detected: true });
    expect(evidence.product.candidate_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ page_role: 'PRODUCT_LISTING', outcome: 'PRODUCT_LISTING' }),
      expect.objectContaining({ outcome: 'VALID_PRODUCT_WITH_VIEW_ITEM', promoted_from: expect.stringContaining('/collections/all') })
    ]));
    expect(evidence.product).toMatchObject({ candidate_promoted_count: 2, candidate_attempted_count: 2, candidate_completed_count: 2 });
    expect(trace.filter((item) => item.step === 'pdp_candidate_tracking_observation_started')).toHaveLength(0);
  }, 45_000);

  it('PRODUCT-CHILD-01 rejects legal and generic listing links while retaining strong product-card children', async () => {
    const result = await auditFixture(200, {
      '/': '<a href="/collections/top-picks">Top picks</a>',
      '/collections/top-picks': `<main class="collection">
        <article class="product-card" data-product-id="one"><a href="/products/one">Product one</a><span>£10</span></article>
        <article class="product-card" data-product-id="two"><a href="/products/two">Product two</a><span>£12</span></article>
        <article class="product-card"><a href="/zone/grocery-terms-and-conditions/">Terms and conditions</a><span>£1</span></article>
        <article class="product-card"><a href="/promotions/weekly">Promotions</a><span>£1</span></article>
        <a href="/help">Help</a><script>window.dataLayer=[{event:'view_item_list',ecommerce:{items:[{item_id:'one'},{item_id:'two'}]}}]</script>
      </main>`,
      '/products/one': `<form action="/cart/add"><button>Add to cart</button></form><script>window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'one',item_name:'One'}]}}]</script>`,
      '/products/two': '<main>Not reached after confirmed first child</main>',
      '/sitemap.xml': null
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { pdp_candidates: string[]; candidate_promoted_count: number } };
    expect(evidence.product.candidate_promoted_count).toBe(2);
    expect(evidence.product.pdp_candidates.join(' ')).not.toMatch(/terms|promotions|help/);
    expect(result.pdp_url_tested).toContain('/products/one');
  }, 45_000);

  it('PRODUCT-CHILD-02 and PRODUCT-CHILD-03 promote zero or one child without forcing the cap', async () => {
    const noProduct = await auditFixture(200, {
      '/': '<a href="/collections/legal">Legal collection</a>',
      '/collections/legal': '<main class="collection"><article class="product-card"><a href="/zone/terms">Terms and conditions</a><span>£10</span></article><a href="/privacy">Privacy</a></main>',
      '/sitemap.xml': null
    }, true, ['tracking']);
    const oneProduct = await auditFixture(200, {
      '/': '<a href="/collections/one">One product</a>',
      '/collections/one': `<main class="collection"><script>window.dataLayer=[{event:'view_item_list', ecommerce:{items:[{item_id:'one'}]}}]</script><article class="product-card" data-product-id="one"><a href="/products/one">Product one</a><span>£10</span></article><button>Add to cart</button><button>Add to cart</button><a href="/support">Support</a></main>`,
      '/products/one': `<form action="/cart/add"><button>Add to cart</button></form><script>window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'one',item_name:'One'}]}}]</script>`,
      '/sitemap.xml': null
    }, true, ['tracking']);
    expect((noProduct.evidence_bundle as { product: { candidate_promoted_count: number } }).product.candidate_promoted_count).toBe(0);
    expect(noProduct.pdp_url_tested).toBeNull();
    expect((oneProduct.evidence_bundle as { product: { candidate_promoted_count: number } }).product.candidate_promoted_count).toBe(1);
    expect(oneProduct.pdp_url_tested).toContain('/products/one');
  }, 60_000);

  it('PDP-SANITIZE-01 filters homepage image candidates before queueing or navigation while retaining a product URL', async () => {
    const result = await auditFixture(200, {
      '/': '<a href="/wp-content/uploads/2025/03/SNF7-2-23-109-scaled.jpg">Image</a><a href="/wp-content/uploads/2025/03/SNF7-2-23-115-scaled.jpg">Image</a><a href="/products/real-product">Real product</a>',
      '/products/real-product': '<form action="/cart/add"><button>Add to cart</button></form>',
      '/sitemap.xml': null
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { pdp_candidates: string[]; candidate_queued_count: number; candidate_attempted_count: number } };
    expect(evidence.product.pdp_candidates).toEqual([expect.stringContaining('/products/real-product')]);
    expect(evidence.product.pdp_candidates.join(' ')).not.toMatch(/\.jpg/);
    expect(evidence.product).toMatchObject({ candidate_queued_count: 1, candidate_attempted_count: 1 });
  }, 45_000);

  it('PDP-SANITIZE-04 fetches nested sitemap sources but queues only the extracted product page', async () => {
    const result = await auditFixture(200, {
      '/': '<main>Store</main>',
      '/sitemap.xml': '<sitemapindex><sitemap><loc>{{fixture_url}}/product-sitemap.xml</loc></sitemap></sitemapindex>',
      '/product-sitemap.xml': '<urlset><url><loc>{{fixture_url}}/products/widget</loc></url></urlset>',
      '/products/widget': '<form action="/cart/add"><button>Add to cart</button></form>'
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { pdp_candidates: string[]; sitemap_enrichment_status: string; candidate_queued_count: number } };
    expect(evidence.product).toMatchObject({ sitemap_enrichment_status: 'completed', candidate_queued_count: 1 });
    expect(evidence.product.pdp_candidates).toEqual([expect.stringContaining('/products/widget')]);
    expect(evidence.product.pdp_candidates.join(' ')).not.toMatch(/\.xml/);
  }, 45_000);

  it('PDP-SANITIZE-08 rejects static listing children while promoting the strong real product child', async () => {
    const result = await auditFixture(200, {
      '/': '<a href="/collections/all">Products</a>',
      '/collections/all': '<main class="collection"><script>window.dataLayer=[{event:"view_item_list",ecommerce:{items:[{item_id:"widget"},{item_id:"asset"}]}}]</script><article class="product-card" data-product-id="widget"><a href="/products/widget">Widget</a><span>$10</span></article><article class="product-card" data-product-id="asset"><a href="/assets/widget.jpg">Image</a><span>$12</span></article><article class="product-card" data-product-id="manual"><a href="/manual.pdf">Manual</a><span>$12</span></article><button>Add to cart</button><button>Add to cart</button></main>',
      '/products/widget': '<form action="/cart/add"><button>Add to cart</button></form>',
      '/sitemap.xml': null
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { pdp_candidates: string[]; candidate_promoted_count: number } };
    expect(evidence.product).toMatchObject({ candidate_promoted_count: 1 });
    expect(evidence.product.pdp_candidates.join(' ')).toContain('/products/widget');
    expect(evidence.product.pdp_candidates.join(' ')).not.toMatch(/widget\.jpg|manual\.pdf/);
  }, 45_000);

  it('PDP-SANITIZE-10 never navigates an all-static discovery result', async () => {
    const result = await auditFixture(200, {
      '/': '<a href="/image.png">Image</a><a href="/manual.pdf">Manual</a><a href="/feed.xml">Feed</a>',
      '/sitemap.xml': null
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { pdp_candidates: string[]; candidate_queued_count: number; candidate_attempted_count: number } };
    const trace = JSON.parse(String(result.trace_steps)) as Array<{ step: string }>;
    expect(evidence.product).toMatchObject({ pdp_candidates: [], candidate_queued_count: 0, candidate_attempted_count: 0 });
    expect(trace.some((item) => item.step === 'pdp_navigation_started')).toBe(false);
    expect(result.product_payload_status).not.toBe('fail');
  }, 45_000);

  it('PDP-URL-01 through PDP-URL-03 persist only a confirmed PDP after later invalid candidates', async () => {
    const product = '<form action="/cart/add"><button>Add to cart</button></form>';
    const result = await auditFixture(200, {
      '/': '<a href="/products/confirmed">Confirmed</a><a href="/products/not-a-product">Not a product</a>',
      '/products/confirmed': product,
      '/products/not-a-product': '<main>Terms and conditions</main>'
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { candidate_outcomes: Array<{ url: string; outcome: string; semantic_result?: string }> } };
    expect(evidence.product.candidate_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/products/confirmed'), semantic_result: 'VALID_PRODUCT' }),
      expect.objectContaining({ url: expect.stringContaining('/products/not-a-product'), outcome: 'INVALID_PRODUCT' })
    ]));
    expect(result.pdp_url_tested).toContain('/products/confirmed');
    expect(result.pdp_url_tested).not.toContain('not-a-product');
  }, 45_000);

  it('ACCESS-01 preserves an Akamai PDP challenge as ACCESS_BLOCKED without persisting its URL', async () => {
    const result = await auditFixture(200, {
      '/': '<a href="/products/blocked">Blocked product</a>',
      '/products/blocked': { status: 403, body: '<title>Access denied</title><main class="akamai">Akamai request blocked</main>' }
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { candidate_outcomes: Array<{ outcome: string; reason_code?: string }> } };
    expect(evidence.product.candidate_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'ACCESS_BLOCKED', reason_code: 'AKAMAI_CHALLENGE' })
    ]));
    expect(result.pdp_url_tested).toBeNull();
  }, 45_000);

  it('RUNNER-DISABLED-01 keeps the full runner on the legacy detector without an interaction', async () => {
    const result = await auditFixture(200, oneTrust, false);
    const trace = JSON.parse(String(result.trace_steps));
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', scan_status: 'completed' });
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'consent_v2_disabled_legacy_fallback' })]));
    expect(trace).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: 'consent_v2' })]));
    expect((result.runtime_metrics as { consent_v2?: unknown }).consent_v2).toBeUndefined();
  }, 30_000);

  it('RUNNER-BLOCKED-01 persists a blocked final state without a no-CMP finding', async () => {
    const result = await auditFixture(451, '<title>Access blocked</title><body>challenge/access blocked fixture</body>');
    expect(result).toMatchObject({ scan_status: 'failed', overall_status: 'inconclusive' });
    expect(result.cmp_provider).not.toBe('Not Found');
    expect(result.consent_status).not.toBe('not_detected');
    expect(JSON.parse(String(result.trace_steps))).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'page_validity_failed' })]));
  }, 30_000);

  it('RUNNER-UNIFIED-01 reaches the PDP before any consent action and retains its early view_item evidence', async () => {
    const html = `<a href="/products/widget">Widget</a><form action="/cart/add"><button>Add to cart</button></form>
      <script>window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'widget-1',item_name:'Widget'}]}}]</script>`;
    const result = await auditFixture(200, html, true, ['tracking']);
    const trace = JSON.parse(String(result.trace_steps));
    expect(result).toMatchObject({ product_payload_status: 'pass', scan_status: 'completed' });
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'pdp_navigation_started' })]));
    expect(trace).not.toEqual(expect.arrayContaining([expect.objectContaining({ step: 'product_consent_enablement' })]));
    expect((result.evidence_bundle as { product: { data_layer_view_item_hits: unknown[] } }).product.data_layer_view_item_hits).toHaveLength(1);
  }, 35_000);

  it('MULTI-PDP-01 lets a later PDP view_item rescue an earlier complete no-event PDP', async () => {
    const product = (body = '') => `<form action="/cart/add"><button>Add to cart</button></form>${body}`;
    const result = await auditFixture(200, {
      '/': `<a href="/products/a">A</a><a href="/products/b">B</a>`,
      '/products/a': product(),
      '/products/b': product(`<script>window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'b',item_name:'B'}]}}]</script>`)
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { candidate_outcomes: Array<{ outcome: string }> } };
    expect(result.product_payload_status).toBe('pass');
    expect(evidence.product.candidate_outcomes.map((item) => item.outcome)).toEqual([
      'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM', 'VALID_PRODUCT_WITH_VIEW_ITEM'
    ]);
  }, 45_000);

  it('PRODUCT-RUNTIME-01 advances from the minimum checkpoint to a strong alternate PDP with delayed view_item', async () => {
    const product = (body = '') => `<form action="/cart/add"><button>Add to cart</button></form>${body}`;
    const result = await auditFixture(200, {
      '/': `<a href="/products/a">A</a><a href="/products/b">B</a><a href="/products/c">Fallback</a>`,
      '/products/a': product(),
      '/products/b': product(`<script>setTimeout(() => { window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'b', item_name:'B'}]}}]; }, 300)</script>`),
      '/products/c': product()
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { candidate_outcomes: Array<{ url: string; outcome: string; minimum_observation_ms?: number; extended_observation_used?: boolean }>; product_runtime: { candidate_total_ms: number; minimum_observation_ms: number; extended_observation_ms: number; product_budget_ms: number } } };
    const trace = JSON.parse(String(result.trace_steps)) as Array<{ step: string; candidate_attempt?: number }>;
    expect(result.product_payload_status).toBe('pass');
    expect(evidence.product.candidate_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining('/products/a'), outcome: 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM', extended_observation_used: false }),
      expect.objectContaining({ url: expect.stringContaining('/products/b'), outcome: 'VALID_PRODUCT_WITH_VIEW_ITEM' })
    ]));
    expect(evidence.product.candidate_outcomes).not.toEqual(expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining('/products/c') })]));
    expect(evidence.product.candidate_outcomes[0].minimum_observation_ms).toBeGreaterThanOrEqual(250);
    expect(evidence.product.product_runtime).toMatchObject({ product_budget_ms: expect.any(Number), candidate_total_ms: expect.any(Number) });
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'pdp_extended_observation_skipped_for_reserve', candidate_attempt: 1 })]));
  }, 45_000);

  it('PRODUCT-RUNTIME-02 stops after two complete negative PDPs and emits missing_view_item', async () => {
    const product = `<form action="/cart/add"><button>Add to cart</button></form>`;
    const result = await auditFixture(200, {
      '/': `<script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view';</script><a href="/products/a">A</a><a href="/products/b">B</a><a href="/products/c">Fallback</a>`,
      '/products/a': product,
      '/products/b': product,
      '/products/c': product
    }, true, ['tracking'], false);
    const evidence = result.evidence_bundle as { product: { candidate_outcomes: Array<{ url: string; outcome: string; observation_complete: boolean }> } };
    const trace = JSON.parse(String(result.trace_steps)) as Array<{ step: string }>;
    expect(result.product_payload_status).toBe('missing_view_item');
    expect(evidence.product.candidate_outcomes.filter((outcome) => outcome.outcome === 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM' && outcome.observation_complete)).toHaveLength(2);
    expect(evidence.product.candidate_outcomes).not.toEqual(expect.arrayContaining([expect.objectContaining({ url: expect.stringContaining('/products/c') })]));
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'pdp_negative_evidence_sufficient' })]));
  }, 45_000);

  it('PRODUCT-RUNTIME-03 keeps an incomplete second PDP from becoming a negative finding', async () => {
    const product = `<form action="/cart/add"><button>Add to cart</button></form>`;
    const result = await auditFixture(200, {
      '/': `<script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view';</script><a href="/products/a">A</a><a href="/products/b">B</a>`,
      '/products/a': product,
      '/products/b': { status: 503, body: '<main>Temporarily unavailable</main>' }
    }, true, ['tracking']);
    const evidence = result.evidence_bundle as { product: { pdp_url: string; final_pdp_url: string; candidate_outcomes: Array<{ outcome: string; observation_complete: boolean }> } };
    expect(result.product_payload_status).toBe('inconclusive');
    expect(result.pdp_url_tested).toContain('/products/a');
    expect(evidence.product).toMatchObject({ pdp_url: expect.stringContaining('/products/a'), final_pdp_url: expect.stringContaining('/products/a') });
    expect(evidence.product.candidate_outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'VALID_PRODUCT_COMPLETE_NO_VIEW_ITEM', observation_complete: true }),
      expect.objectContaining({ outcome: 'OBSERVATION_INCOMPLETE', observation_complete: false })
    ]));
  }, 45_000);

  it('PRODUCT-RUNTIME-04 does not wait for DOMContentLoaded when committed PDP semantics are already ready', async () => {
    const result = await auditFixture(200, {
      '/': `<a href="/products/stalled">Stalled</a>`,
      '/products/stalled': `<form action="/cart/add"><button>Add to cart</button></form><script>window.dataLayer=[{event:'view_item', ecommerce:{items:[{item_id:'stalled', item_name:'Stalled'}]}}]</script><script src="/dcl-stall.js"></script>`,
      '/dcl-stall.js': null
    }, true, ['tracking']);
    const trace = JSON.parse(String(result.trace_steps)) as Array<{ step: string }>;
    expect(result.product_payload_status).toBe('pass');
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'pdp_domcontentloaded_bypassed_for_semantic_readiness' })]));
    expect(trace).not.toEqual(expect.arrayContaining([expect.objectContaining({ step: 'domcontentloaded_wait_timed_out_continuing', phase: 'product_pdp_load' })]));
  }, 45_000);

  it('PRODUCT-RUNTIME-05 waits for slow JS hydration when initial product semantics are absent', async () => {
    const result = await auditFixture(200, {
      '/': `<a href="/products/hydrated">Hydrated</a>`,
      '/products/hydrated': `<main id="app">Loading</main><script>setTimeout(() => { document.querySelector('#app').innerHTML = '<form action="/cart/add"><button>Add to cart</button></form>'; window.dataLayer=[{event:"view_item", ecommerce:{items:[{item_id:"hydrated", item_name:"Hydrated"}]}}]; }, 300)</script>`
    }, true, ['tracking']);
    expect(result.product_payload_status).toBe('pass');
    expect((result.evidence_bundle as { product: { candidate_outcomes: Array<{ outcome: string }> } }).product.candidate_outcomes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ outcome: 'VALID_PRODUCT_WITH_VIEW_ITEM' })]));
  }, 45_000);

  it('ACCEPT-E2E-01 runs clean-context Accept for Tracking-only and retains post-Accept view_item', async () => {
    const gatedPdp = `<script>window.OneTrust={AllowAll(){}};</script><script src="/otSDKStub.js"></script>
      <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler" onclick="window.dataLayer=[{event:'view_item',ecommerce:{items:[{item_id:'accepted',item_name:'Accepted'}]}}]">Accept all</button></div>
      <form action="/cart/add"><button>Add to cart</button></form>`;
    const result = await auditFixture(200, { '/': `<a href="/products/gated">Gated</a>`, '/products/gated': gatedPdp }, true, ['tracking']);
    const trace = JSON.parse(String(result.trace_steps));
    expect(result).toMatchObject({ product_payload_status: 'pass', consent_status: 'not_tested' });
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'accept_comparison_completed', reason_code: 'NO_TRACKING_OBSERVED_PRE_ACCEPT' })]));
    expect((result.evidence_bundle as { product: { data_layer_view_item_hits: unknown[] } }).product.data_layer_view_item_hits).toHaveLength(1);
  }, 45_000);

  it('ADVANCED-ACCEPT-E2E-01 preserves denied pre-Accept measurement and captures post-Accept view_item', async () => {
    const advancedPdp = `<script>window.OneTrust={AllowAll(){}};new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';</script><script src="/otSDKStub.js"></script>
      <div id="onetrust-banner-sdk"><button id="onetrust-accept-btn-handler" onclick="window.dataLayer=[{event:'view_item',ecommerce:{items:[{item_id:'advanced',item_name:'Advanced'}]}}]">Accept all</button></div>
      <form action="/cart/add"><button>Add to cart</button></form>`;
    const result = await auditFixture(200, { '/': `<a href="/products/advanced">Advanced</a>`, '/products/advanced': advancedPdp }, true, ['tracking']);
    const trace = JSON.parse(String(result.trace_steps));
    expect(result.product_payload_status).toBe('pass');
    expect((result.evidence_bundle as { network: { observation: { limited_measurement_observed: boolean } } }).network.observation.limited_measurement_observed).toBe(true);
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'accept_comparison_completed', reason_code: 'ADVANCED_CONSENT_MODE_OBSERVED' })]));
  }, 45_000);

  it('CONSENT-SHARED-01 carries shared pre-choice traffic into the final consent result', async () => {
    let homepageLoads = 0;
    const result = await auditFixture(200, (path) => {
      if (path !== '/') return '';
      homepageLoads += 1;
      const tracking = homepageLoads === 1 ? `<script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G111';</script>` : '';
      return `${tracking}${oneTrust}`;
    });
    expect(result).toMatchObject({ consent_status: 'prior_consent_violation', scan_status: 'completed' });
    expect((result.evidence_bundle as { consent: { post_reject_observation_completed: boolean } }).consent.post_reject_observation_completed).toBe(true);
  }, 35_000);

  it.each([
    ['CMP-MEASURE-MORPHE-RUNNER', 'G100', 'G100', 'limited_measurement', false],
    ['CMP-MEASURE-04-RUNNER', 'G111', 'G100', 'unknown', true],
    ['CMP-MEASURE-05-RUNNER', 'G100', 'G111', 'unknown', true]
  ])('%s persists coherent measurement and counts from both contexts', async (_id, shared, fresh, state, contradiction) => {
    let homepageLoads = 0;
    const result = await auditFixture(200, (path) => {
      if (path !== '/') return '';
      const marker = ++homepageLoads === 1 ? shared : fresh;
      // Local collection route exercises the existing first-party GA4 parser.
      return `<script>new Image().src='/g/collect?tid=G-FIXTURE&en=page_view&gcs=${marker}';</script>${oneTrust}`;
    }, true, ['consent'], false) as unknown as StorefrontAudit;
    expect(result).toMatchObject({ consent_status: 'inconclusive', scan_status: 'completed' });
    expect(result.evidence_bundle?.consent.pre_choice_measurement).toBe(state);
    const measurement = result.runtime_metrics?.consent_v2?.measurement;
    expect(measurement).toMatchObject({ state, contradiction, pre_choice_event_hits: 2 });
    expect(measurement?.sources.map((source) => source.context)).toEqual(['shared', 'fresh']);
    expect(result.runtime_metrics?.consent_v2).toMatchObject({ observation_only: true, action_attempted: false });
    const summary = JSON.parse(String(buildDebugPackageFiles(result)['consent-summary.json']));
    expect(summary.measurement).toEqual(measurement);
    expect(summary.pre_choice_measurement).toBe(state);
  }, 35_000);

  it('CMP-TELEM-SURVIVE-01 persists shared limited telemetry after a successful fresh session', async () => {
    let homepageLoads = 0;
    const result = await auditFixture(200, (path) => {
      if (path !== '/') return '';
      const marker = ++homepageLoads === 1 ? 'G100' : 'G100';
      return `<script>new Image().src='/g/collect?tid=G-FIXTURE&en=page_view&gcs=${marker}';</script>${oneTrust}`;
    }, true, ['consent'], false) as unknown as StorefrontAudit;
    const measurement = result.runtime_metrics?.consent_v2?.measurement;
    expect(measurement).toMatchObject({ state: 'limited_measurement', limited_measurement_count: 2 });
    expect(result.runtime_metrics?.consent_v2).toMatchObject({ session_status: 'completed', observation_only: true });
    expect(JSON.parse(String(buildDebugPackageFiles(result)['consent-summary.json'])).measurement).toEqual(measurement);
  }, 35_000);

  it('CMP-TELEM-SURVIVE-02 Audit 409 preserves shared telemetry when the fresh PDP context is unavailable', async () => {
    const result = await auditFixture(
      200,
      `<script>new Image().src='/g/collect?tid=G-FIXTURE&en=page_view&gcs=G100';</script>${oneTrust}`,
      true,
      ['consent', 'tracking'],
      false,
      { createFreshConsentContext: async () => { throw new Error('Target page, context or browser has been closed'); } }
    ) as unknown as StorefrontAudit;
    const evidence = result.evidence_bundle!;
    const telemetry = result.runtime_metrics?.consent_v2!;
    expect(result).toMatchObject({ scan_status: 'partial', cmp_provider: 'OneTrust' });
    // The shared consent baseline executed; session_status distinguishes the
    // unavailable fresh PDP session from that completed shared observation.
    expect(evidence.consent).toMatchObject({ executed: true, pre_choice_measurement: 'limited_measurement' });
    expect(telemetry).toMatchObject({
      session_status: 'unavailable', observation_only: true, provider: 'onetrust',
      interaction_outcome: 'not_attempted', verification: 'inconclusive', persistence: 'inconclusive',
      shared_observation: { provider: 'onetrust', banner_visibility: 'visible' },
      measurement: { state: 'limited_measurement', limited_measurement_count: 1, full_measurement_count: 0, unknown_measurement_count: 0, contradiction: false }
    });
    expect(telemetry.measurement?.sources.map((source) => source.context)).toEqual(['shared']);
    expect(JSON.parse(String(result.trace_steps))).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'consent_pdp_reject_inconclusive', error_family: 'PAGE_CONTEXT_UNAVAILABLE' })
    ]));
    expect(JSON.parse(String(buildDebugPackageFiles(result)['consent-summary.json'])).measurement).toEqual(telemetry.measurement);
  }, 35_000);

  it('SERVER-BUDGET-01 preserves passive server classification with the minimum global budget', async () => {
    vi.stubEnv('AUDIT_TIMEOUT_MS', '30000');
    const result = await auditFixture(200, `<script>new Image().src='/g/collect?en=page_view';</script>`, true, ['server_side']);
    const evidence = result.evidence_bundle as { server_side: { passive_classification_completed: boolean } };
    expect(result).toMatchObject({ scan_status: 'completed' });
    expect(evidence.server_side.passive_classification_completed).toBe(true);
    expect(JSON.parse(String(result.trace_steps))).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'server_relevant_requests_summarized' })
    ]));
  }, 35_000);

  it('ACCESS-RECOVERY-01 clears the active challenge state after a verified storefront recovery', async () => {
    let homepageLoads = 0;
    const result = await auditFixture(200, (path) => {
      if (path !== '/') return '';
      homepageLoads += 1;
      if (homepageLoads > 1) return '<title>Storefront</title><main>Products</main>';
      return `<title>Verify you are human</title><main>challenge</main><script>setTimeout(() => {
        document.title = 'Storefront'; document.body.innerHTML = '<main>Products</main>';
      }, 250)</script>`;
    }, true, []);
    const evidence = result.evidence_bundle as { access: { valid_storefront: boolean; challenge_detected: boolean; challenge_type: string | null }; page: { challenge_cleared: boolean } };
    expect(result).toMatchObject({ scan_status: 'completed' });
    expect(evidence.access).toMatchObject({ valid_storefront: true, challenge_detected: false, challenge_type: null });
    expect(evidence.page.challenge_cleared).toBe(true);
  }, 35_000);
});
