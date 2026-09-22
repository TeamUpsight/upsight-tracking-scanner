import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { compareGpcObservations, installGpcProfile, openBrowserlessGpcExperimentSession, runGpcExperiment, type GpcObservation } from './gpc-experiment';
import { buildBrowserlessCdpUrl, buildBrowserlessGpcExperimentUrl } from '../proxy/decodo';

async function localFixture(html = '<main>Fixture</main>') {
  const received: Array<string | null> = [];
  const server = createServer((request, response) => {
    const header = request.headers['sec-gpc'];
    received.push(typeof header === 'string' ? header : null);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
  return { server, received, url: 'http://127.0.0.1:' + address.port + '/' };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('WP12B production-boundary GPC profile', () => {
  it('keeps Browserless route and sticky proxy identity while varying only the OFF process flag', () => {
    const canonical = buildBrowserlessCdpUrl({ host: 'chrome.browserless.io', token: 'fixture-token', route: 'stealth',
      externalProxyServer: 'http://user:pass@proxy.example:10001', browserLocale: 'en-US', timeoutMs: 180_000 });
    const off = new URL(buildBrowserlessGpcExperimentUrl(canonical, 'off'));
    const on = new URL(buildBrowserlessGpcExperimentUrl(canonical, 'on'));
    expect(on.toString()).toBe(canonical);
    expect(off.pathname).toBe(on.pathname);
    expect(off.searchParams.get('externalProxyServer')).toBe(on.searchParams.get('externalProxyServer'));
    expect(off.searchParams.get('token')).toBe(on.searchParams.get('token'));
    const offLaunch = JSON.parse(off.searchParams.get('launch')!);
    const onLaunch = JSON.parse(on.searchParams.get('launch')!);
    expect(offLaunch.args).toEqual([...onLaunch.args, '--disable-features=GlobalPrivacyControlForce,GlobalPrivacyControlTest']);
    expect(() => buildBrowserlessGpcExperimentUrl('wss://host/unknown?token=fixture', 'off')).toThrow();
  });

  it('runs OFF and ON in separate browser processes with isolated storage and sent-header checks', async () => {
    const cookies: Array<string | undefined> = [];
    const sentGpc: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      cookies.push(request.headers.cookie);
      sentGpc.push(request.headers['sec-gpc'] as string | undefined);
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'experiment=seen; Path=/' });
      response.end('<main>Fixture</main>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture port unavailable');
    const url = 'http://127.0.0.1:' + address.port + '/';
    const canonical = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
    const opened: string[] = [];
    const canonicalUrl = buildBrowserlessCdpUrl({ host: 'chrome.browserless.io', token: 'fixture-token', route: 'stealth', browserLocale: 'en-US' });
    try {
      const result = await runGpcExperiment({ browser: canonical, url, targetHost: '127.0.0.1', proxyCountry: 'us',
        openBrowserSession: (profile) => openBrowserlessGpcExperimentSession(canonicalUrl, profile, async (url) => {
          opened.push(url.includes('disable-features') ? 'off' : 'on');
          return chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
        }),
        verifyEgress: async () => ({ country: 'us', fingerprint: 'same_fixture' }),
        inspectAccess: async () => ({ category: 'none', reasonCode: 'STOREFRONT_VALID', botProvider: null, botSignals: [], challengeType: null, retryAfterMs: null }) });
      expect(opened).toEqual(['off', 'on']);
      expect(result).toMatchObject({ state: 'completed', identity_matched: true,
        control: { transport: { top_level_sec_gpc: 'absent', dom_global_privacy_control: false, valid: true }, identity: { same_browser_session: false } },
        treatment: { transport: { top_level_sec_gpc: '1', dom_global_privacy_control: true, valid: true }, identity: { same_browser_session: false } } });
      expect(sentGpc).toEqual([undefined, '1']);
      expect(cookies).toEqual([undefined, undefined]);
    } finally { await canonical.close(); await closeServer(server); }
  }, 45_000);

  it('sends matching OFF and ON HTTP/DOM states in clean contexts, and invalidates a mismatch', async () => {
    const fixture = await localFixture();
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
    try {
      const offContext = await browser.newContext();
      const offPage = await offContext.newPage();
      const offTransport = await installGpcProfile(offContext, offPage, 'off', '127.0.0.1');
      await offPage.goto(fixture.url);
      expect(await offTransport()).toMatchObject({ requested_profile: 'off', top_level_sec_gpc: 'absent', dom_global_privacy_control: false, valid: true });
      await offPage.evaluate(() => { localStorage.setItem('choice', 'off'); sessionStorage.setItem('choice', 'off'); document.cookie = 'choice=off'; });
      await offContext.close();

      const onContext = await browser.newContext();
      const onPage = await onContext.newPage();
      const onTransport = await installGpcProfile(onContext, onPage, 'on', '127.0.0.1');
      await onPage.goto(fixture.url);
      expect(fixture.received.at(-1)).toBe('1');
      expect(await onTransport()).toMatchObject({ requested_profile: 'on', top_level_sec_gpc: '1', dom_global_privacy_control: true, valid: true });
      expect(await onPage.evaluate(() => ({ storage: localStorage.getItem('choice'), session: sessionStorage.getItem('choice'), cookie: document.cookie }))).toEqual({ storage: null, session: null, cookie: '' });
      await onPage.evaluate(() => { localStorage.setItem('choice', 'on'); sessionStorage.setItem('choice', 'on'); document.cookie = 'choice=on'; });
      await onContext.close();

      const secondOffContext = await browser.newContext();
      const secondOffPage = await secondOffContext.newPage();
      const secondOffTransport = await installGpcProfile(secondOffContext, secondOffPage, 'off', '127.0.0.1');
      await secondOffPage.goto(fixture.url);
      expect(await secondOffTransport()).toMatchObject({ top_level_sec_gpc: 'absent', dom_global_privacy_control: false, valid: true });
      expect(await secondOffPage.evaluate(() => ({ storage: localStorage.getItem('choice'), session: sessionStorage.getItem('choice'), cookie: document.cookie }))).toEqual({ storage: null, session: null, cookie: '' });
      await secondOffContext.close();

      const mismatchContext = await browser.newContext();
      const mismatchPage = await mismatchContext.newPage();
      const mismatchTransport = await installGpcProfile(mismatchContext, mismatchPage, 'on', '127.0.0.1');
      await mismatchPage.goto(fixture.url);
      await mismatchPage.evaluate(() => Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: false }));
      expect(await mismatchTransport()).toMatchObject({ top_level_sec_gpc: '1', dom_global_privacy_control: false, valid: false });
      await mismatchContext.close();

      const nativeMismatchContext = await browser.newContext();
      await nativeMismatchContext.setExtraHTTPHeaders({ 'Sec-GPC': '1' });
      const nativeMismatchPage = await nativeMismatchContext.newPage();
      const nativeMismatchTransport = await installGpcProfile(nativeMismatchContext, nativeMismatchPage, 'off', '127.0.0.1', undefined, true);
      await nativeMismatchPage.goto(fixture.url);
      expect(await nativeMismatchTransport()).toMatchObject({ top_level_sec_gpc: '1', dom_global_privacy_control: false, valid: false });
      await nativeMismatchContext.close();

      expect(fixture.received).toEqual([null, '1', null, '1', '1']);
    } finally {
      await browser.close();
      await closeServer(fixture.server);
    }
  }, 30_000);

  it('keeps Issuu-style Cookiebot semantics while comparing only observed changes', async () => {
    const html = '<script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script>' +
      '<script type="application/json" src="https://consent.cookiebot.com/uc.js"></script>' +
      '<div id="CybotCookiebotDialog" role="dialog" style="position:fixed;width:420px;height:180px">' +
      '<p>Privacy choices. Global Privacy Control is honored when present.</p>' +
      '<button id="CybotCookiebotDialogBodyButtonAccept">OK</button>' +
      '<button id="CybotCookiebotDialogBodyButtonDecline">Do not sell or share my personal information</button></div>';
    const fixture = await localFixture(html);
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
    try {
      const result = await runGpcExperiment({
        browser, url: fixture.url, targetHost: '127.0.0.1', proxyCountry: 'us', armBudgetMs: 24_000, budgetMs: 48_000,
        verifyEgress: async () => ({ country: 'us', fingerprint: 'same_fixture' }),
        inspectAccess: async () => ({ category: 'none', reasonCode: 'STOREFRONT_VALID', botProvider: null, botSignals: [], challengeType: null, retryAfterMs: null })
      });
      expect(result.outcome).toBe('no_observable_change');
      expect(result.control?.transport.valid).toBe(true);
      expect(result.treatment?.transport.valid).toBe(true);
      expect(result.timings).toMatchObject({
        budget_ms: 48_000, arm_budget_ms: 24_000,
        control: { failed_stage: null, context_ms: expect.any(Number), egress_ms: expect.any(Number), transport_setup_ms: expect.any(Number),
          navigation_ms: expect.any(Number), observation_ms: expect.any(Number), transport_verification_ms: expect.any(Number), total_ms: expect.any(Number) },
        treatment: { failed_stage: null, context_ms: expect.any(Number), egress_ms: expect.any(Number), transport_setup_ms: expect.any(Number),
          navigation_ms: expect.any(Number), observation_ms: expect.any(Number), transport_verification_ms: expect.any(Number), total_ms: expect.any(Number) }
      });
      expect(result.timings!.total_ms).toBeLessThan(result.timings!.budget_ms);
      for (const observation of [result.control, result.treatment]) {
        expect(observation?.cmp).toMatchObject({ provider: 'cookiebot', banner_visibility: 'visible' });
        expect(observation?.cmp?.actions).not.toContain('reject_all');
        expect(observation?.cmp?.actions).not.toContain('accept_all');
        expect(observation?.us_privacy?.choices).toEqual(expect.arrayContaining([
          expect.objectContaining({ choice: 'opt_out', rights: ['sale', 'sharing'] })
        ]));
      }
      expect(result.differences).toEqual([]);
    } finally {
      await browser.close();
      await closeServer(fixture.server);
    }
  }, 45_000);

  it('retains completed control when treatment egress times out, distinct from the total deadline', async () => {
    const fixture = await localFixture();
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
    const inspectAccess = async () => ({ category: 'none' as const, reasonCode: 'STOREFRONT_VALID', botProvider: null, botSignals: [], challengeType: null, retryAfterMs: null });
    try {
      let probes = 0;
      const stageTimeout = await runGpcExperiment({
        browser, url: fixture.url, targetHost: '127.0.0.1', proxyCountry: 'us',
        armBudgetMs: 3_000, budgetMs: 12_000, inspectAccess,
        verifyEgress: () => ++probes === 1
          ? Promise.resolve({ country: 'us', fingerprint: 'same_fixture' })
          : new Promise<never>(() => {})
      });
      expect(stageTimeout).toMatchObject({
        state: 'inconclusive', outcome: 'inconclusive', reason_code: 'TREATMENT_EGRESS_TIMEOUT',
        control: { transport: { valid: true } }, treatment: null,
        timings: { control: { failed_stage: null }, treatment: { failed_stage: 'egress', egress_ms: expect.any(Number) } }
      });
      expect(stageTimeout.control?.identity.egress_fingerprint).toBeUndefined();

      probes = 0;
      const controlTimeout = await runGpcExperiment({
        browser, url: fixture.url, targetHost: '127.0.0.1', proxyCountry: 'us',
        armBudgetMs: 3_000, budgetMs: 12_000, inspectAccess,
        verifyEgress: () => ++probes === 1
          ? new Promise<never>(() => {})
          : Promise.resolve({ country: 'us', fingerprint: 'same_fixture' })
      });
      expect(controlTimeout).toMatchObject({
        state: 'inconclusive', outcome: 'inconclusive', reason_code: 'CONTROL_EGRESS_TIMEOUT',
        control: null, treatment: { transport: { valid: true } },
        timings: { control: { failed_stage: 'egress' }, treatment: { failed_stage: null } }
      });
      expect(controlTimeout.treatment?.identity.egress_fingerprint).toBeUndefined();

      probes = 0;
      const providerTimeout = await runGpcExperiment({
        browser, url: fixture.url, targetHost: '127.0.0.1', proxyCountry: 'us',
        armBudgetMs: 3_000, budgetMs: 12_000, inspectAccess,
        verifyEgress: () => ++probes === 1
          ? Promise.resolve({ country: 'us', fingerprint: 'same_fixture' })
          : Promise.reject(new Error('Navigation timed out during egress probe'))
      });
      expect(providerTimeout).toMatchObject({
        reason_code: 'TREATMENT_EGRESS_TIMEOUT', control: { transport: { valid: true } },
        treatment: null, timings: { treatment: { failed_stage: 'egress' } }
      });

      probes = 0;
      const totalTimeout = await runGpcExperiment({
        browser, url: fixture.url, targetHost: '127.0.0.1', proxyCountry: 'us',
        armBudgetMs: 10_000, budgetMs: 5_000, inspectAccess,
        verifyEgress: () => ++probes === 1
          ? Promise.resolve({ country: 'us', fingerprint: 'same_fixture' })
          : new Promise<never>(() => {})
      });
      expect(totalTimeout).toMatchObject({
        state: 'inconclusive', outcome: 'inconclusive', reason_code: 'TOTAL_EXPERIMENT_BUDGET_EXCEEDED',
        control: { transport: { valid: true } }, treatment: null,
        timings: { control: { failed_stage: null }, treatment: { failed_stage: 'egress' } }
      });
    } finally {
      await browser.close();
      await closeServer(fixture.server);
    }
  }, 30_000);

  it('rejects unmatched egress, access, and HTTP/DOM transport before comparing differences', () => {
    const base: GpcObservation = {
      transport: { requested_profile: 'off', top_level_sec_gpc: 'absent', first_party_requests: { observed: 1, absent: 1, value_1: 0, other: 0 }, dom_global_privacy_control: false, valid: true },
      identity: { same_browser_session: true, browser_configuration_verified: true, locale: 'en-US', timezone: 'America/New_York', viewport: '1280x800', usa_egress_verified: true, egress_fingerprint: 'same' },
      access: { page_valid: true, canonical_host: 'fixture.example', category: 'none', geo_verified: true, observation_complete: true },
      cmp: null, us_privacy: null, gpp: null, measurement: null
    };
    const on: GpcObservation = { ...base, transport: { ...base.transport, requested_profile: 'on', top_level_sec_gpc: '1', first_party_requests: { observed: 1, absent: 0, value_1: 1, other: 0 }, dom_global_privacy_control: true } };
    expect(compareGpcObservations(base, on).outcome).toBe('no_observable_change');
    expect(compareGpcObservations(base, { ...on, transport: { ...on.transport, valid: false } }).outcome).toBe('transport_invalid');
    expect(compareGpcObservations(base, { ...on, identity: { ...on.identity, egress_fingerprint: 'other' } }).outcome).toBe('identity_unmatched');
    const separate = { ...base, identity: { ...base.identity, same_browser_session: false, browser_version: '149.0' } };
    expect(compareGpcObservations(separate, { ...on, identity: { ...on.identity, same_browser_session: false, browser_version: '150.0' } }).outcome).toBe('identity_unmatched');
    expect(compareGpcObservations(separate, { ...on, identity: { ...on.identity, same_browser_session: false, browser_version: '149.0', browser_configuration_verified: false } }).outcome).toBe('identity_unmatched');
    expect(compareGpcObservations(base, { ...on, access: { ...on.access, category: 'bot_protection' } }).outcome).toBe('access_inconclusive');
    expect(compareGpcObservations(base, { ...on, us_privacy: { choices: [], gpc_acknowledgement_observed: true } }).outcome).toBe('observable_privacy_state_change');
    expect(compareGpcObservations(base, { ...on, gpp: { lifecycle: 'ready', section_list: [7], applicable_sections: [7, 8], signal_status: 'ready' } }).outcome).toBe('observable_privacy_state_change');
    expect(compareGpcObservations(base, { ...on, measurement: { state: 'full_measurement', retained: 1, full: 1, limited: 0, unknown: 0, truncated: false } }).outcome).toBe('observable_measurement_change');
    expect(compareGpcObservations(base, { ...on, cmp: { provider: 'cookiebot', provider_conflict: false, banner_visibility: 'visible', actions: [] } }).outcome).toBe('observable_ui_change');
  });
});
