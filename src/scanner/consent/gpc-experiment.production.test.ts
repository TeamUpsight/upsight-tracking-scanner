import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { compareGpcObservations, installGpcProfile, runGpcExperiment, type GpcObservation } from './gpc-experiment';

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

      expect(fixture.received).toEqual([null, '1', null, '1']);
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
        browser, url: fixture.url, targetHost: '127.0.0.1', proxyCountry: 'us',
        verifyEgress: async () => ({ country: 'us', fingerprint: 'same_fixture' }),
        inspectAccess: async () => ({ category: 'none', reasonCode: 'STOREFRONT_VALID', botProvider: null, botSignals: [], challengeType: null, retryAfterMs: null })
      });
      expect(result.outcome).toBe('no_observable_change');
      expect(result.control?.transport.valid).toBe(true);
      expect(result.treatment?.transport.valid).toBe(true);
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
    expect(compareGpcObservations(base, { ...on, access: { ...on.access, category: 'bot_protection' } }).outcome).toBe('access_inconclusive');
    expect(compareGpcObservations(base, { ...on, us_privacy: { choices: [], gpc_acknowledgement_observed: true } }).outcome).toBe('observable_privacy_state_change');
    expect(compareGpcObservations(base, { ...on, gpp: { lifecycle: 'ready', section_list: [7], applicable_sections: [7, 8], signal_status: 'ready' } }).outcome).toBe('observable_privacy_state_change');
    expect(compareGpcObservations(base, { ...on, measurement: { state: 'full_measurement', retained: 1, full: 1, limited: 0, unknown: 0, truncated: false } }).outcome).toBe('observable_measurement_change');
    expect(compareGpcObservations(base, { ...on, cmp: { provider: 'cookiebot', provider_conflict: false, banner_visibility: 'visible', actions: [] } }).outcome).toBe('observable_ui_change');
  });
});
