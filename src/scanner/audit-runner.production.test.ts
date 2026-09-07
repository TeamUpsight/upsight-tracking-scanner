import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStorefrontAudit } from './audit-runner';

// Full-runner fixtures validate orchestration, not wall-clock dwell time. Keep
// the production constants intact while making each bounded observation short
// enough for the local browser test process.
vi.mock('./version', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./version')>();
  return { ...actual, PDP_POST_LOAD_OBSERVATION_MS: 1_000, PDP_MIN_TRACKING_OBSERVATION_MS: 250 };
});

const resolvedFixtureHost = async () => ({ status: 'resolved' as const, sources: { fixture: 'resolved' as const } });

type FixtureHtml = string | Record<string, string> | ((path: string) => string);

async function fixtureServer(status: number, html: FixtureHtml) {
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://fixture.example').pathname;
    const body = typeof html === 'function' ? html(path) : typeof html === 'string' ? html : html[path] || html['/'] || '';
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
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

async function auditFixture(status: number, html: FixtureHtml, consentV2Enabled = true, selected_modules: Array<'consent' | 'tracking' | 'server_side'> = ['consent']) {
  vi.stubEnv('BROWSER_PROVIDER', 'local');
  vi.stubEnv('CONSENT_V2_ENABLED', consentV2Enabled ? 'true' : 'false');
  vi.stubEnv('CONSENT_V2_ACTIONS_ENABLED', consentV2Enabled ? 'true' : 'false');
  vi.stubEnv('CONSENT_ONETRUST_ACTIONS_ENABLED', consentV2Enabled ? 'true' : 'false');
  vi.stubEnv('CONSENT_V2_ACTION_SAMPLE_PERCENT', consentV2Enabled ? '100' : '0');
  const fixture = await fixtureServer(status, html);
  const updates: Array<Record<string, unknown>> = [];
  try {
    await runStorefrontAudit({
      audit_id: `runner-${status}-${consentV2Enabled}`,
      domain: 'fixture.example',
      tested_geos: 'EU',
      selected_modules
    }, async (update) => { updates.push(update as Record<string, unknown>); }, {
      storefrontUrl: fixture.url,
      resolveHostname: resolvedFixtureHost,
      consentGeoVerified: true,
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
