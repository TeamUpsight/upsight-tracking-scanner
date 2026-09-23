import { createServer } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsentV2RolloutControls } from './rollout-controls';
import { captureSharedConsentObservation, mergeSharedConsentObservation, prepareConsentV2Session, runConsentV2Session, type ConsentV2SessionInput } from './v2-session';
import { mapConsentV2ToExisting } from './compatibility-mapper';
import { captureBrowserConsentFacts, installConsentCommandBootstrap, observeConsentFrameworksInPage } from './browser-context-builders';
import { discoverProviderSemanticControls } from './provider-semantic-controls';
import { semanticActionForConsentLabel } from './generic-consent-detector';

const rollout: ConsentV2RolloutControls = {
  enabled: true, actions_enabled: false, action_sample_percent: 0,
  providers: Object.fromEntries(['onetrust', 'cookiebot', 'usercentrics', 'didomi', 'cookieyes', 'sourcepoint', 'shopify', 'generic'].map((provider) => [provider, { detection_enabled: true, actions_enabled: false }])) as ConsentV2RolloutControls['providers']
};

const input: ConsentV2SessionInput = { geo: 'EU', geo_verified: true, page_valid: true, rollout };
const actionRollout: ConsentV2RolloutControls = {
  ...rollout,
  actions_enabled: true,
  action_sample_percent: 100,
  providers: Object.fromEntries(Object.entries(rollout.providers).map(([provider, settings]) => [provider, { ...settings, actions_enabled: true }])) as ConsentV2RolloutControls['providers']
};
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: true
  });
});
afterAll(async () => { await browser?.close(); });

/**
 * Keeps fixture requests realistic for the production page listener without
 * allowing a browser test to depend on a vendor CDN or collection endpoint.
 * Playwright emits `page.on('request')` before this route is fulfilled, so the
 * Consent V2 capture receives the original request facts.
 */
async function installDeterministicExternalFixtureRouting(page: Page) {
  await page.route('https://**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() === 'script') {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: '/* deterministic fixture external script */'
      });
      return;
    }
    await route.fulfill({
      status: 204,
      headers: { 'access-control-allow-origin': '*' }
    });
  });
}

/** Local executable fixture/page → production bridge → runConsentV2Session(). */
async function audit(html: string, sessionInput = input) {
  const page = await browser.newPage();
  try { await installDeterministicExternalFixtureRouting(page); await page.setContent(html); return await runConsentV2Session(page, sessionInput); } finally { await page.close(); }
}

/** Local page navigation → prepared production capture → session evaluation. */
async function auditNavigation(html: string, accessBlocked = false, sessionInput = input) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local Consent V2 fixture server did not expose a TCP port.');
  const page = await browser.newPage();
  try {
    await installDeterministicExternalFixtureRouting(page);
    const capture = await prepareConsentV2Session(page);
    capture.markNavigationStarted();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
    capture.markDOMContentLoaded(); capture.markInitialObservationCompleted();
    return await runConsentV2Session(page, { ...sessionInput, access_blocked: accessBlocked }, capture);
  } finally {
    await page.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function auditSourcepoint(preferences = false, contradictory = false) {
  const iframe = createServer((_request, response) => response.end(`<!doctype html>${preferences
    ? '<button class="sp_choice_type_12" onclick="document.body.innerHTML=\'<button class=&quot;sp_choice_type_REJECT_ALL&quot; onclick=&quot;parent.postMessage(\\\'sourcepoint-reject\\\', \\\'*\\\')&quot;>Reject all</button>\'">Preferences</button>'
    : '<button class="sp_choice_type_13" onclick="parent.postMessage(\'sourcepoint-reject\', \'*\')">Reject</button>'}`));
  await new Promise<void>((resolve) => iframe.listen(0, '127.0.0.1', resolve));
  const iframeAddress = iframe.address();
  if (!iframeAddress || typeof iframeAddress === 'string') throw new Error('Sourcepoint frame server did not expose a TCP port.');
  const top = createServer((_request, response) => response.end(`<!doctype html><script>
    window._sp_={}; window._sp_queue=[]; let listener; const contradictory=${contradictory};
    const state=()=>{const rejected=localStorage.getItem('sourcepoint-rejected')==='true'; const granted=contradictory||!rejected; return {listenerId:1,eventStatus:rejected?'useractioncomplete':'tcloaded',cmpLoaded:true,apiVersion:'2.2',gdprApplies:true,purpose:{consents:{1:granted,2:granted}},vendor:{consents:{1:granted,2:granted}}};};
    window.addEventListener('message', (event) => { if (event.data === 'sourcepoint-reject') { localStorage.setItem('sourcepoint-rejected','true'); setTimeout(()=>listener?.(state(),true),0); } });
    window.__tcfapi=(command, version, callback) => {
      if(command==='ping') callback({cmpLoaded:true,apiVersion:'2.2',gdprApplies:true},true);
      if(command==='addEventListener') { listener=callback; callback(state(),true); }
    };
  </script><iframe id="sp_message_iframe_test" src="http://127.0.0.1:${iframeAddress.port}/"></iframe>`));
  await new Promise<void>((resolve) => top.listen(0, '127.0.0.1', resolve));
  const topAddress = top.address();
  if (!topAddress || typeof topAddress === 'string') throw new Error('Sourcepoint top server did not expose a TCP port.');
  const page = await browser.newPage();
  try {
    const capture = await prepareConsentV2Session(page); capture.markNavigationStarted();
    await page.goto(`http://127.0.0.1:${topAddress.port}/`, { waitUntil: 'domcontentloaded' }); capture.markDOMContentLoaded();
    return await runConsentV2Session(page, { ...input, rollout: actionRollout }, capture);
  } finally {
    await page.close();
    await new Promise<void>((resolve, reject) => top.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => iframe.close((error) => error ? reject(error) : resolve()));
  }
}

describe('Consent V2 production session wiring', () => {
  const usaInput: ConsentV2SessionInput = { ...input, geo: 'USA' };

  it('WP12A-US-01 classifies an Issuu-style Cookiebot control as sale/share opt-out without inventing reject all', async () => {
    const result = await audit(`<script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script>
      <script src="https://consent.cookiebot.com/uc.js"></script>
      <div id="CybotCookiebotDialog" role="dialog" style="position:fixed;width:420px;height:180px">
        Privacy choices. Global Privacy Control is honored when present.
        <button id="CybotCookiebotDialogBodyButtonAccept">OK</button>
        <button id="CybotCookiebotDialogBodyButtonDecline">Do not sell or share my personal information</button>
      </div>`, usaInput);

    expect(result.telemetry).toMatchObject({ provider: 'cookiebot', banner_visibility: 'visible' });
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'not_present' });
    expect(result.result.available_actions.find((action) => action.action === 'accept_all')).toMatchObject({ availability: 'not_present' });
    expect(result.result.us_privacy).toMatchObject({
      observed: true,
      choices: [expect.objectContaining({ choice: 'opt_out', rights: ['sale', 'sharing'], availability: 'direct', source: 'provider_control', provider: 'cookiebot' })],
      gpc: { gpc_acknowledgement_observed: true }
    });
  });

  it('WP12A-EU-02 preserves Cookiebot accept-all and only-necessary semantics in the EU', async () => {
    const result = await audit(`<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script>
      <div id="CybotCookiebotDialog" role="dialog" style="position:fixed;width:360px;height:160px">Cookie preferences
        <button id="CybotCookiebotDialogBodyButtonAccept">Alle akzeptieren</button>
        <button id="CybotCookiebotDialogBodyButtonDecline">Nur notwendige</button>
      </div>`);

    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'only_necessary', availability: 'direct' })
    ]));
    expect(result.result.us_privacy).toBeNull();
  });

  it('WP12A-US-03 preserves an explicit USA cookie reject without inventing privacy rights', async () => {
    const result = await audit(`<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script>
      <div id="CybotCookiebotDialog" role="dialog" style="position:fixed;width:360px;height:140px">Cookie preferences
        <button id="CybotCookiebotDialogBodyButtonDecline">Reject all</button>
      </div>`, usaInput);

    expect(result.result.available_actions.find((action) => action.action === 'reject_all')).toMatchObject({ availability: 'direct' });
    expect(result.result.us_privacy?.choices).toEqual([]);
  });

  it.each([
    ['Your Privacy Choices', 'manage', []],
    ['Opt out of targeted advertising', 'opt_out', ['targeted_advertising']],
    ['Limit the Use of My Sensitive Personal Information', 'limit', ['sensitive_data_use']]
  ])('WP12A-US-04 through WP12A-US-06 classify %s only in the US privacy model', async (label, choice, rights) => {
    const result = await audit(`<div role="dialog" class="privacy-choices" style="position:fixed;width:420px;height:140px">Privacy choices
      <button>${label}</button></div>`, usaInput);

    expect(result.result.us_privacy?.choices).toEqual([
      expect.objectContaining({ choice, rights, availability: 'direct' })
    ]);
    expect(result.result.available_actions.find((action) => action.action === 'reject_all')?.availability).not.toBe('direct');
  });

  it('WP12A-GPC-07 passively reports present, absent, and unavailable browser states without a compliance claim', async () => {
    const present = await audit(`<script>Object.defineProperty(navigator,'globalPrivacyControl',{value:true,configurable:true});</script>
      <div role="dialog" class="privacy-choices" style="position:fixed;width:320px;height:100px">Privacy choices<button>Your Privacy Choices</button></div>`, usaInput);
    const absent = await audit(`<script>Object.defineProperty(navigator,'globalPrivacyControl',{value:false,configurable:true});</script>
      <main>Storefront</main>`, usaInput);
    const unavailable = await audit('<main>Storefront</main>', usaInput);

    expect(present.result.us_privacy?.gpc).toMatchObject({ browser_signal: 'present', signal_evidence: 'gpc_signal_present' });
    expect(absent.result.us_privacy?.gpc).toMatchObject({ browser_signal: 'absent', signal_evidence: 'gpc_signal_absent' });
    expect(unavailable.result.us_privacy?.gpc).toMatchObject({ browser_signal: 'unavailable', signal_evidence: 'gpc_signal_unavailable' });
    expect(JSON.stringify(present.result.us_privacy)).not.toMatch(/honored|compliant/i);
  });

  it('WP12A-GPP-08 projects applicable section IDs without verifying a physical state', async () => {
    const result = await audit(`<script>
      window.__gpp=(command,callback)=>{if(command==='ping')callback({gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'visible',signalStatus:'ready',supportedAPIs:['7:usnat','8:usca'],sectionList:[7,8],applicableSections:[7,8]},true);};
      </script><main>Storefront</main>`, usaInput);

    expect(result.result.us_privacy).toMatchObject({
      jurisdiction: { state_verified: null, framework_declared_sections: [7, 8] },
      gpc: { gpp_present: true, gpp_applicable_sections: [7, 8] }
    });
  });

  it('WP11.4-SEMANTIC-LOCATOR-01 resolves Cookiebot controls inside an accessible child frame only after provider-first fallback', async () => {
    const result = await audit('<script src="https://consent.cookiebot.com/uc.js"></script><section role="dialog" class="cookie-consent" style="position:fixed;width:320px;height:120px">Cookie preferences<iframe srcdoc="&lt;section role=\'dialog\' class=\'cookie-consent\'&gt;&lt;input type=\'button\' value=\'NUR NOTWENDIGE\'&gt;&lt;button aria-label=\'ALLE AKZEPTIEREN\'&gt;&lt;span aria-hidden=\'true\'&gt;accept&lt;/span&gt;&lt;/button&gt;&lt;/section&gt;"></iframe></section>', { ...input, diagnostic: true });
    expect(result.telemetry).toMatchObject({ provider: 'cookiebot', provider_confidence: 'high' });
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'only_necessary', availability: 'direct' }),
      expect.objectContaining({ action: 'accept_all', availability: 'direct' })
    ]));
    expect(result.diagnostic_observation?.semantic_discovery).toMatchObject({
      attempted: true,
      provider: 'cookiebot',
      actionable_control_count: 2,
      role_candidate_count: expect.any(Number),
      rejection_counts: expect.objectContaining({ not_visible: expect.any(Number), outside_verified_consent_context: expect.any(Number) })
    });
  }, 10_000);

  it('WP11.5-SEMANTIC-A11Y-01 invokes the actionable owner for accessible Cookiebot controls and rejects footer false positives', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<footer><button style="width:120px;height:30px" aria-label="ALLE AKZEPTIEREN" onclick="window.__footerAccepted=(window.__footerAccepted||0)+1">Footer link</button></footer><section role="dialog" class="cookie-consent"><button style="width:120px;height:30px" aria-label="ALLE AKZEPTIEREN" onclick="window.__accepted=(window.__accepted||0)+1"><span aria-hidden="true">accept</span></button><div style="width:120px;height:30px" role="button" aria-label="NUR NOTWENDIGE" tabindex="0"></div></section>`);
      const discovery = await discoverProviderSemanticControls(page, 'cookiebot');
      expect(discovery.controls).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'accept_all', accessible_name: 'ALLE AKZEPTIEREN', actionable: true }),
        expect.objectContaining({ action: 'only_necessary', accessible_name: 'NUR NOTWENDIGE', actionable: true })
      ]));
      const accept = discovery.controls.find((control) => control.action === 'accept_all');
      expect(accept).toBeDefined();
      await discovery.invoke(accept!.id);
      expect(await page.evaluate(() => (window as any).__accepted || 0)).toBe(1);
      expect(await page.evaluate(() => (window as any).__footerAccepted || 0)).toBe(0);
      expect(discovery.diagnostic.rejection_counts.outside_verified_consent_context).toBeGreaterThan(0);
      expect(discovery.diagnostic.candidate_samples).toEqual(expect.arrayContaining([
        expect.objectContaining({ accessible_name: 'ALLE AKZEPTIEREN', accepted: false, rejection_reason: 'outside_verified_consent_context' }),
        expect.objectContaining({ accessible_name: 'ALLE AKZEPTIEREN', accepted: true, rejection_reason: null })
      ]));
    } finally { await page.close(); }
  });

  it('WP11.5-SEMANTIC-A11Y-02 traverses accessible child frames with role-first locators', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<section role="dialog" class="cookie-consent"><iframe srcdoc="&lt;section role='dialog' class='cookie-consent'&gt;&lt;button style='width:120px;height:30px' aria-label='ALLE AKZEPTIEREN'&gt;&lt;/button&gt;&lt;input style='width:120px;height:30px' type='button' value='NUR NOTWENDIGE'&gt;&lt;/section&gt;"></iframe></section>`);
      const discovery = await discoverProviderSemanticControls(page, 'cookiebot');
      expect(discovery.controls.filter((control) => control.location === 'child_frame')).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'accept_all' }), expect.objectContaining({ action: 'only_necessary' })
      ]));
    } finally { await page.close(); }
  });

  it('WP11.6-SEMANTIC-DIAGNOSTIC-01 exposes bounded unrecognized control names from verified Consent scopes without changing matching', async () => {
    const result = await audit(`<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script>
      <section id="CybotCookiebotDialog" role="dialog" style="position:fixed;width:360px;height:180px">Cookie privacy settings
        <button aria-label="Allow selected vendors">Continue</button>
        <a href="#" aria-label="Review privacy choices">Review</a>
      </section>`, { ...input, diagnostic: true });
    const discovery = result.diagnostic_observation?.semantic_discovery;

    expect(discovery).toMatchObject({
      attempted: true,
      provider: 'cookiebot',
      role_candidate_count: 0,
      link_candidate_count: 0,
      open_shadow_candidate_count: 0,
      text_candidate_count: 0,
      actionable_control_count: 0,
      candidate_samples: []
    });
    expect(discovery?.nearby_actionable_controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'button', accessible_name: 'Allow selected vendors', visible: true, enabled: true, direct_actionable_target: true, consent_scope_corroborated: true }),
      expect.objectContaining({ role: 'link', accessible_name: 'Review privacy choices', visible: true, enabled: true, direct_actionable_target: true, consent_scope_corroborated: true })
    ]));
    expect(result.result.available_actions.some((action) => action.availability === 'direct')).toBe(false);
  });

  it('WP11.7-CONTROL-BOUND-01 retains visible primary controls after earlier hidden controls exhaust the DOM-order bound', async () => {
    const page = await browser.newPage();
    try {
      const hidden = Array.from({ length: 35 }, (_, index) => `<a href="#vendor-${index}" style="display:none">Hidden vendor ${index}</a>`).join('');
      await page.setContent(`<section role="dialog" class="cookie-consent" style="position:fixed;width:480px;height:240px">Cookie privacy settings${hidden}
        <button aria-label="Choose privacy vendors">Ignored visual label</button>
        <button>Continue with essentials</button>
      </section>`);
      const facts = await captureBrowserConsentFacts(page);
      const names = facts.generic.controls.map((control) => control.accessible_name);

      expect(names).toEqual(expect.arrayContaining(['Choose privacy vendors', 'Continue with essentials']));
      expect(facts.generic.controls.slice(0, 2).map((control) => control.accessible_name)).toEqual(['Choose privacy vendors', 'Continue with essentials']);
    } finally { await page.close(); }
  });

  it('WP11.7-A11Y-CENSUS-01 captures computed unknown names from a verified Consent scope without creating actions', async () => {
    const hidden = Array.from({ length: 35 }, (_, index) => `<a href="#vendor-${index}" style="display:none">Hidden vendor ${index}</a>`).join('');
    const result = await audit(`<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script>
      <section id="CybotCookiebotDialog" role="dialog" style="position:fixed;width:520px;height:300px">Cookie privacy settings${hidden}
        <button aria-label="Choose privacy vendors">Ignored visual label</button>
        <button>Continue with essentials</button>
        <input type="button" value="Use required cookies">
        <span id="privacy-choice-name">Review consent options</span><button aria-labelledby="privacy-choice-name"></button>
        <button><span>Confirm privacy choices</span></button>
      </section>`, { ...input, diagnostic: true });
    const census = result.diagnostic_observation?.semantic_discovery?.nearby_actionable_controls || [];
    const names = census.map((control) => control.accessible_name);

    expect(result.diagnostic_observation?.semantic_discovery).toMatchObject({ role_candidate_count: 0, link_candidate_count: 0, open_shadow_candidate_count: 0, text_candidate_count: 0, actionable_control_count: 0 });
    expect(names).toEqual(expect.arrayContaining([
      'Choose privacy vendors',
      'Continue with essentials',
      'Use required cookies',
      'Review consent options',
      'Confirm privacy choices'
    ]));
    expect(census).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'button', accessible_name: 'Choose privacy vendors', location: 'main_frame', consent_scope_corroborated: true }),
      expect.objectContaining({ role: 'input', accessible_name: 'Use required cookies', location: 'main_frame', consent_scope_corroborated: true }),
      expect.objectContaining({ role: 'button', accessible_name: 'Review consent options', location: 'main_frame', consent_scope_corroborated: true })
    ]));
    expect(census.length).toBeLessThanOrEqual(20);
    expect(census.slice(0, 5).every((control) => control.visible && control.enabled && control.direct_actionable_target)).toBe(true);
    expect(result.diagnostic_observation?.capture_stage_durations_ms).toMatchObject({
      browser_facts: expect.any(Number), framework_observation: expect.any(Number), provider_context: expect.any(Number),
      provider_selection: expect.any(Number), provider_operations: expect.any(Number), semantic_discovery: expect.any(Number),
      ui_readiness: expect.any(Number), accessibility_census: expect.any(Number), total: expect.any(Number)
    });
    expect(result.diagnostic_observation!.capture_stage_durations_ms!.total).toBeGreaterThanOrEqual(result.diagnostic_observation!.capture_stage_durations_ms!.ui_readiness);
    expect(result.result.available_actions.some((action) => action.availability === 'direct')).toBe(false);
  }, 15_000);

  it('WP11.5-UC-BOOTSTRAP-01 is idempotent per context and captures startup lifecycle events after a recreated context', async () => {
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      const firstPage = await first.newPage();
      await installConsentCommandBootstrap(firstPage);
      await installConsentCommandBootstrap(firstPage);
      await firstPage.goto(`data:text/html,<script>window.dispatchEvent(new Event('UC_UI_INITIALIZED'));window.dispatchEvent(new CustomEvent('UC_UI_CMP_EVENT',{detail:{type:'CMP_SHOWN'}}));window.dispatchEvent(new CustomEvent('UC_UI_VIEW_CHANGED',{detail:{view:'FIRST_LAYER'}}));</script>`);
      expect((await captureBrowserConsentFacts(firstPage)).usercentrics.lifecycle).toMatchObject({ initialized: true, latest_view: 'FIRST_LAYER', cmp_shown_observed: true, event_count: 3 });
      const secondPage = await second.newPage();
      await installConsentCommandBootstrap(secondPage);
      await secondPage.goto(`data:text/html,<script>window.dispatchEvent(new Event('UC_UI_INITIALIZED'));window.dispatchEvent(new CustomEvent('UC_UI_VIEW_CHANGED',{detail:{view:'SECOND_LAYER'}}));</script>`);
      expect((await captureBrowserConsentFacts(secondPage)).usercentrics.lifecycle).toMatchObject({ initialized: true, latest_view: 'SECOND_LAYER', event_count: 2 });
    } finally { await first.close(); await second.close(); }
  });

  it('WP11.4-DIDOMI-HOSTED-LOADER-01 recognizes exactly one hosted provider-key loader segment', async () => {
    const result = await audit('<script src="https://sdk.privacy-center.org/provider-key/loader.js?target=fixture"></script><section role="dialog">Cookies<button>Tout accepter</button></section>');
    expect(result.telemetry).toMatchObject({ provider: 'didomi', provider_confidence: 'high' });
  });

  it('WP11.4-UC-LIFECYCLE-01 preserves pre-navigation FIRST_LAYER lifecycle evidence without raw event detail', async () => {
    const result = await auditNavigation('<script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script><script>window.UC_UI={isInitialized:()=>true};window.dispatchEvent(new Event("UC_UI_INITIALIZED"));window.dispatchEvent(new CustomEvent("UC_UI_CMP_EVENT",{detail:{type:"CMP_SHOWN",ignored:"not-retained"}}));window.dispatchEvent(new CustomEvent("UC_UI_VIEW_CHANGED",{detail:{view:"FIRST_LAYER",previousView:"NONE",ignored:"not-retained"}}));</script>');
    expect(result.telemetry).toMatchObject({ provider: 'usercentrics', banner_visibility: 'visible' });
    expect(JSON.stringify(result)).not.toContain('not-retained');
  });

  it('WP11.4-MERGE-POSITIVE-01 retains shared visible provider evidence when fresh observation is providerless', () => {
    const shared = { source: 'shared', provider: 'didomi', provider_conflict: false, banner: { surface: 'banner', visibility: 'visible', evidence: [], reason_codes: [] }, actions: [{ action: 'accept_all', availability: 'direct', category: null, evidence: [], reason_codes: [] }] } as any;
    const fresh = { telemetry: { provider: null, provider_conflict: false, session_status: 'completed', timeline: { initial_observation_completed_at: Date.now() } }, result: { banner: { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [] }, available_actions: [] } } as any;
    expect(mergeSharedConsentObservation(shared, fresh)).toMatchObject({ provider: 'didomi', banner: { visibility: 'visible' }, actions: [expect.objectContaining({ action: 'accept_all', availability: 'direct' })] });
  });

  it('WP11.4-MERGE-POSITIVE-03 retains a true same-provider complete contradiction as unknown', () => {
    const shared = { source: 'shared', provider: 'didomi', provider_conflict: false, banner: { surface: 'banner', visibility: 'visible', evidence: [], reason_codes: [] }, actions: [] } as any;
    const fresh = { telemetry: { provider: 'didomi', provider_conflict: false, session_status: 'completed', timeline: { initial_observation_completed_at: Date.now() } }, result: { banner: { surface: 'none', visibility: 'not_visible', evidence: [], reason_codes: [] }, available_actions: [] } } as any;
    expect(mergeSharedConsentObservation(shared, fresh).banner.visibility).toBe('unknown');
  });
  it('FW-ASYNC-TCF-01 buffers delayed TCF callbacks from the pre-navigation bridge', async () => {
    const page = await browser.newPage();
    try {
      const capture = await prepareConsentV2Session(page);
      await page.goto(`data:text/html,<script>window.__tcfapi=(c,v,cb)=>setTimeout(()=>cb(c==='ping'?{cmpLoaded:true,apiVersion:'2.2',gdprApplies:true}:{listenerId:1,eventStatus:'tcloaded',purpose:{consents:{1:true}},vendor:{consents:{2:true}}},true),150)</script>`);
      const observed = await observeConsentFrameworksInPage(page);
      expect(observed.tcf).toMatchObject({ lifecycle: 'ready', event_count: 1, latest_event: { event_status: 'tcloaded' } });
      capture.dispose();
    } finally { await page.close(); }
  });

  it('FW-ASYNC-TCF-02 retains a delayed useractioncomplete lifecycle update', async () => {
    const page = await browser.newPage();
    try {
      const capture = await prepareConsentV2Session(page);
      await page.goto(`data:text/html,<script>window.__tcfapi=(c,v,cb)=>{if(c==='ping')cb({cmpLoaded:true,apiVersion:'2.2'},true);if(c==='addEventListener'){cb({listenerId:1,eventStatus:'tcloaded',purpose:{consents:{1:true}},vendor:{consents:{2:true}}},true);setTimeout(()=>cb({listenerId:1,eventStatus:'useractioncomplete',purpose:{consents:{1:false}},vendor:{consents:{2:false}}},true),150)}}</script>`);
      await page.waitForTimeout(220);
      expect(await observeConsentFrameworksInPage(page)).toMatchObject({ tcf: { event_count: 2, latest_event: { event_status: 'useractioncomplete', purpose_consents: { denied_count: 1 } } } });
      capture.dispose();
    } finally { await page.close(); }
  });

  it('FW-ASYNC-GPP-01 and USP-E2E-01 preserve asynchronous GPP and legacy USP independently', async () => {
    const result = await auditNavigation(`<script>
      window.__uspapi=()=>{};
      window.__gpp=(c,cb)=>setTimeout(()=>{const p={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',supportedAPIs:['uspv1'],sectionList:[7],applicableSections:[7]};cb(c==='ping'?p:{listenerId:1,pingData:p},true)},150);
    </script>`);
    expect(result.result.frameworks).toMatchObject({ gpp: 'present', usp: 'present' });
    expect(result.result.frameworks.evidence).toContain('usp:legacy_read_only');
  });

  it('POST-GA4-01 observes a POST conversion and safe Consent Mode descriptors without retaining the body', async () => {
    const result = await auditNavigation(`<script>fetch('https://www.google-analytics.com/g/collect',{method:'POST',body:'en=purchase&gcs=G100&gcd=opaque&dma=1'}).catch(()=>{});</script>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'google_analytics', kind: 'conversion_hit', timing: 'pre_choice' })]));
    expect(result.google_consent_mode.network.some((item) => item.parameters.gcs?.present && item.parameters.gcd?.present && item.parameters.dma?.present)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('en=purchase');
  });

  it.each([
    ['TikTok', 'https://analytics.tiktok.com/api/v1/pixel/track', 'event=CompletePayment', 'tiktok'],
    ['Snapchat', 'https://tr.snapchat.com/p', 'event_type=PURCHASE', 'snapchat'],
    ['Pinterest', 'https://ct.pinterest.com/v3/event', 'event_name=checkout', 'pinterest'],
    ['X', 'https://analytics.twitter.com/i/adsct', 'event=registration', 'x']
  ] as const)('POST-VENDOR captures %s event evidence through the production session', async (_name, url, body, vendor) => {
    const result = await auditNavigation(`<script>fetch('${url}',{method:'POST',body:'${body}'}).catch(()=>{});</script>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor, timing: 'pre_choice' })]));
    expect(JSON.stringify(result)).not.toContain(body);
  });

  it('captures Usercentrics open-shadow controls as bounded browser facts', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<aside id="usercentrics-cmp-ui" style="display:block;width:320px;height:120px"></aside><script>document.querySelector('#usercentrics-cmp-ui').attachShadow({mode:'open'}).innerHTML='<button>Alle ablehnen</button>';</script>`);
      expect((await captureBrowserConsentFacts(page)).usercentrics.controls.map((item) => item.accessible_name)).toContain('Alle ablehnen');
      expect(semanticActionForConsentLabel('Alle ablehnen')).toBe('reject_all');
    } finally { await page.close(); }
  });
  it('VER-CB-01 verifies Cookiebot Reject and preserves its semantic state after reload', async () => {
    const result = await auditNavigation(`<script>
      const rejected=document.cookie.includes('CookieConsent=present');
      window.Cookiebot={hasResponse:rejected,consented:false,declined:rejected,consent:{preferences:rejected?false:null,statistics:rejected?false:null,marketing:rejected?false:null}};
      function decline(){localStorage.setItem('cookiebot-rejected','true');document.cookie='CookieConsent=present; path=/';Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consented=false;Cookiebot.consent={preferences:false,statistics:false,marketing:false};}
    </script><script type="application/json" src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline()">Decline</button></div>`, false, { ...input, rollout: actionRollout });
    expect(result.result.interactions[0]).toMatchObject({ origin: 'provider_selector', outcome: 'executed' });
    expect(result.result.rejection_verification.status).toBe('verified');
    expect(result.result.persistence).toMatchObject({ status: 'confirmed', post_reload_observation_completed: true, semantic_channels: { provider: 'persisted' } });
    expect(result.telemetry.timeline?.user_choice_at).not.toBeNull();
  }, 20_000);

  it('VER-OT-01 prefers the visible OneTrust Reject control over its API capability', async () => {
    const result = await audit(`<script>
      window.OneTrust={RejectAll(){window.apiCalled=true;}}; window.OnetrustActiveGroups='C001';
      function reject(){window.OnetrustActiveGroups='C001';}
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="reject()">Reject all</button></div>`, { ...input, rollout: actionRollout });
    expect(result.result.interactions[0]).toMatchObject({ origin: 'provider_selector', outcome: 'executed' });
  });

  it('VER-OT-02 verifies OneTrust Reject only with an emitted transition and TCF rejection', async () => {
    const result = await auditNavigation(`<script>
      let listener; const rejected=()=>localStorage.getItem('onetrust-rejected')==='true';
      const state=()=>({listenerId:1,eventStatus:rejected()?'useractioncomplete':'tcloaded',purpose:{consents:{1:!rejected(),2:!rejected()}},vendor:{consents:{1:!rejected(),2:!rejected()}}});
      window.__tcfapi=(command, version, callback)=>{if(command==='ping')callback({cmpLoaded:true,apiVersion:'2.2',gdprApplies:true},true);if(command==='addEventListener'){listener=callback;callback(state(),true);}};
      window.OneTrust={RejectAll(){}}; window.OnetrustActiveGroups='C001';
      function reject(){localStorage.setItem('onetrust-rejected','true');document.cookie='OptanonConsent=present; path=/';window.dispatchEvent(new Event('OTConsentApplied'));setTimeout(()=>listener?.(state(),true),0);}
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="reject()">Reject all</button></div>`, false, { ...input, rollout: actionRollout });
    expect(result.result.rejection_verification.status).toBe('verified');
    expect(result.result.rejection_verification.evidence).toEqual(expect.arrayContaining(['strong:framework_tcf:matches_requested', 'supporting:provider_event:matches_requested']));
  }, 20_000);

  it('VER-OT-03 keeps OneTrust Reject inconclusive without authoritative semantic evidence', async () => {
    const result = await auditNavigation(`<script>
      window.OneTrust={RejectAll(){}}; window.OnetrustActiveGroups='C001';
      function reject(){window.dispatchEvent(new Event('OTConsentApplied'));}
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="reject()">Reject all</button></div>`, false, { ...input, rollout: actionRollout });
    expect(result.result.interactions[0]).toMatchObject({ outcome: 'executed' });
    expect(result.result.rejection_verification.status).toBe('inconclusive');
  }, 20_000);
  it('uses the OneTrust adapter for provider evidence, state, banner, and actions', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div>`);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('direct');
    expect(mapConsentV2ToExisting(result.result, { geo: 'EU', page_valid: true, tracking_before_interaction: false })).toMatchObject({ cmp_provider: 'OneTrust' });
  });

  it('does not execute an interaction when the V2 rollout is disabled', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){window.apiCalled=true;}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div>`, {
      ...input,
      rollout: { ...actionRollout, enabled: false }
    });
    expect(result.telemetry.enabled).toBe(false);
    expect(result.result.interactions).toEqual([]);
  });

  it('OT-05 treats close as dismissal rather than a Reject action', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button aria-label="Close">×</button></div>`);
    expect(result.result.interactions).toEqual([]);
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('api_only');
    expect(result.result.rejection_verification.status).toBe('inconclusive');
  });

  it('UC-04 executes localized Usercentrics Reject, observes reload storage, and remains inconclusive', async () => {
    const result = await auditNavigation(`<script>window.UC_UI={};</script><script type="application/json" src="https://web.cmp.usercentrics.eu/ui/loader.js"></script><aside id="usercentrics-cmp-ui" style="display:block;width:320px;height:120px"></aside><script>
      function reject(){localStorage.setItem('ucData','present');localStorage.setItem('ucString','present');}
      const root=document.querySelector('#usercentrics-cmp-ui').attachShadow({mode:'open'});
      root.innerHTML='<button id="uc-reject">Alle ablehnen</button>';
      root.querySelector('#uc-reject').addEventListener('click',reject);
    </script>`, false, { ...input, rollout: actionRollout });
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('usercentrics');
    expect(result.result.banner).toMatchObject({ visibility: 'visible' });
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('direct');
    expect(result.result.interactions[0]).toMatchObject({ outcome: 'executed' });
    expect(result.result.rejection_verification.status).toBe('inconclusive');
    expect(result.result.persistence).toMatchObject({ status: 'inconclusive', post_reload_observation_completed: true, storage_continuity: 'matching' });
  }, 20_000);

  it("DI-03 verifies Didomi's fresh rejected state after consent.changed and persists it", async () => {
    const result = await auditNavigation(`<script>
      let rejected=localStorage.getItem('didomi-rejected')==='true'; window.Didomi={
        getCurrentUserStatus(){return {purposes:{a:!rejected,b:!rejected}};},
        setUserDisagreeToAll(){rejected=true;localStorage.setItem('didomi-rejected','true');localStorage.setItem('didomi_token','present');window.dispatchEvent(new Event('consent.changed'));},
        notice:{isVisible(){return true;}}
      };
    </script><script type="application/json" src="https://sdk.privacy-center.org/loader.js"></script><div id="didomi-host" style="display:block;width:320px;height:120px"></div>`, false, { ...input, rollout: actionRollout });
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('didomi');
    expect(result.result.initial_state.decision).toBe('accepted');
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('api_only');
    expect(result.result.interactions[0]).toMatchObject({ outcome: 'executed' });
    expect(result.result.rejection_verification.evidence).toEqual(expect.arrayContaining(['strong:provider_state:matches_requested', 'supporting:provider_event:matches_requested']));
    expect(result.result.rejection_verification.status).toBe('verified');
    expect(result.result.persistence).toMatchObject({ status: 'confirmed', post_reload_observation_completed: true, semantic_channels: { provider: 'persisted' } });
  }, 20_000);

  it('DIDOMI-UI-01 prefers a visible Reject control and never calls the API fallback', async () => {
    const result = await auditNavigation(`<script>
      let rejected=false; window.Didomi={
        getCurrentUserStatus(){return {purposes:{a:!rejected,b:!rejected}};},
        setUserDisagreeToAll(){throw new Error('API fallback must not be used when UI Reject is visible');},
        notice:{isVisible(){return true;}}
      };
    </script><script src="https://sdk.privacy-center.org/loader.js"></script><div id="didomi-notice" style="display:block;width:320px;height:120px"><button aria-label="Reject All" onclick="rejected=true;localStorage.setItem('didomi_token','present');window.dispatchEvent(new Event('consent.changed'))">Reject All</button></div>`, false, { ...input, rollout: actionRollout });
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')).toMatchObject({ availability: 'direct' });
    expect(result.result.interactions[0]).toMatchObject({ action: 'reject_all', origin: 'provider_selector', outcome: 'executed' });
    expect(result.result.resulting_state?.decision).toBe('rejected');
    expect(result.result.rejection_verification.status).toBe('verified');
  }, 20_000);

  it('DIDOMI-API-FALLBACK-01 reports API-only Reject only when no visible Didomi control exists', async () => {
    const result = await audit(`<script>window.Didomi={setUserDisagreeToAll(){},notice:{isVisible(){return true;}}}</script><script src="https://sdk.privacy-center.org/loader.js"></script><div id="didomi-host" style="display:block;width:320px;height:120px"></div>`);
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')).toMatchObject({ availability: 'api_only' });
  });

  it('CY-03 verifies CookieYes optional categories with completed action and persistence', async () => {
    const result = await auditNavigation(`<script>
      const rejected=()=>localStorage.getItem('cookieyes-rejected')==='true';
      window.getCkyConsent=()=>({categories:{analytics:!rejected(),advertisement:!rejected(),performance:!rejected(),functional:!rejected()},isUserActionCompleted:rejected()});
      window.performBannerAction=()=>{localStorage.setItem('cookieyes-rejected','true');localStorage.setItem('cookieyes-consent','present');}; window.CookieYes={};
    </script><script src="https://cdn-cookieyes.com/client_data/test/script.js"></script><div class="cky-consent-container"><button class="cky-btn-reject" onclick="performBannerAction('reject')">Reject</button></div>`, false, { ...input, rollout: actionRollout });
    expect(result.result.interactions[0]).toMatchObject({ origin: 'provider_selector', outcome: 'executed' });
    expect(result.result.resulting_state?.decision).toBe('rejected');
    expect(result.result.rejection_verification.status).toBe('verified');
    expect(result.result.persistence).toMatchObject({ status: 'confirmed', post_reload_observation_completed: true, semantic_channels: { provider: 'persisted' } });
  }, 10_000);

  it('SP-04 verifies asynchronous Sourcepoint TCF rejection through the production session bridge', async () => {
    const result = await auditSourcepoint();
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('sourcepoint');
    expect(result.result.banner).toMatchObject({ surface: 'dialog', visibility: 'visible' });
    expect(result.result.interactions[0]).toMatchObject({ origin: 'provider_selector', outcome: 'executed' });
    expect(result.result.rejection_verification.status).toBe('verified');
  }, 15_000);

  it('SP-05 rejects a contradictory Sourcepoint TCF useractioncomplete state', async () => {
    const result = await auditSourcepoint(false, true);
    expect(result.result.interactions[0]).toMatchObject({ outcome: 'executed' });
    expect(result.result.rejection_verification).toMatchObject({ status: 'not_verified' });
    expect(result.result.rejection_verification.reason_codes).toContain('STATE_CONTRADICTION');
  }, 15_000);

  it('PREF-SP-01 re-discovers the privacy-manager Reject in its real cross-origin iframe', async () => {
    const result = await auditSourcepoint(true);
    expect(result.result.interactions.map((item) => item.action)).toEqual(['open_preferences', 'reject_all']);
    expect(result.telemetry).toMatchObject({ preferences_opened: true, reject_attempted: true, reject_outcome: 'executed', action_status: 'verified' });
  }, 15_000);

  it('TELEMETRY-PREF-02 records missing Reject after preferences as unsupported rather than successful', async () => {
    const iframe = createServer((_request, response) => response.end('<button class="sp_choice_type_12">Preferences</button>'));
    await new Promise<void>((resolve) => iframe.listen(0, '127.0.0.1', resolve));
    const address = iframe.address(); if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    const top = createServer((_request, response) => response.end(`<!doctype html><script>window._sp_={};window._sp_queue=[];window.__tcfapi=(c,v,cb)=>{if(c==='ping')cb({cmpLoaded:true,apiVersion:'2.2'},true);if(c==='addEventListener')cb({listenerId:1,eventStatus:'tcloaded',purpose:{consents:{1:true}},vendor:{consents:{1:true}}},true)}</script><iframe id="sp_message_iframe_missing" src="http://127.0.0.1:${address.port}/"></iframe>`));
    await new Promise<void>((resolve) => top.listen(0, '127.0.0.1', resolve));
    const topAddress = top.address(); if (!topAddress || typeof topAddress === 'string') throw new Error('fixture did not bind');
    const page = await browser.newPage();
    try {
      const capture = await prepareConsentV2Session(page); capture.markNavigationStarted(); await page.goto(`http://127.0.0.1:${topAddress.port}/`, { waitUntil: 'domcontentloaded' });
      const result = await runConsentV2Session(page, { ...input, rollout: actionRollout }, capture);
      expect(result.telemetry).toMatchObject({ preferences_opened: true, reject_attempted: true, reject_outcome: 'unsupported', action_status: 'unsupported' });
    } finally { await page.close(); await new Promise<void>((resolve, reject) => top.close((error) => error ? reject(error) : resolve())); await new Promise<void>((resolve, reject) => iframe.close((error) => error ? reject(error) : resolve())); }
  }, 20_000);

  it('keeps Shopify Customer Privacy as a separate commerce privacy runtime beside OneTrust', async () => {
    const result = await audit(`<script>
      window.OneTrust={RejectAll(){}};
      window.Shopify={customerPrivacy:{
        currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},
        analyticsProcessingAllowed(){return false}, marketingAllowed(){return false}, preferencesProcessingAllowed(){return false}, saleOfDataAllowed(){return false}, shouldShowBanner(){return false}, getRegion(){return 'EU'}
      }};
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"></div>`);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toEqual(expect.arrayContaining(['cmp', 'commerce_privacy_runtime']));
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
  });

  it('reports a GPP stub as stub_present through the framework observer', async () => {
    const result = await audit(`<script>window.__gpp=(command, callback) => { if(command==='ping') callback({gppVersion:'1.1',cmpStatus:'stub',cmpDisplayStatus:'visible',signalStatus:'not ready',cmpId:1,supportedAPIs:[],sectionList:[],applicableSections:[]},true); };</script>`);
    expect(result.result.frameworks.gpp).toBe('stub_present');
    expect(result.result.frameworks.reason_codes).toContain('GPP_STUB_PRESENT');
  });

  it('GPP-02 keeps normalized ready GPP lifecycle fields in framework evidence', async () => {
    const result = await audit(`<script>window.__gpp=(command, callback) => { const ping={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',cmpId:1,supportedAPIs:['usnat'],sectionList:[7],applicableSections:[7,8]}; if(command==='ping') callback(ping,true); if(command==='addEventListener') callback({listenerId:1,pingData:ping},true); };</script>`);
    expect(result.result.frameworks).toMatchObject({ gpp: 'present' });
    expect(result.result.frameworks.evidence).toEqual(expect.arrayContaining(['gpp_cmp_status:loaded', 'gpp_cmp_display_status:hidden', 'gpp_signal_status:ready', 'gpp_applicable_sections:7,8']));
    expect(result.telemetry).toMatchObject({ gpp_present: true, gpp_lifecycle: 'ready', usp_present: false });
  });

  it('GPP-13 captures parsed section availability without returning parsed values or the GPP string', async () => {
    const result = await audit(`<script>
      const ping={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',supportedAPIs:['7:usnat','8:usca'],sectionList:[7,8],applicableSections:[7,8],gppString:'raw-gpp-secret',parsedSections:{usnat:[{SaleOptOut:1,CmpId:24601,PublisherId:'publisher-secret'}],usca:[{SharingOptOut:2}]}};
      window.__gpp=(command,callback)=>{if(command==='ping')callback(ping,true);if(command==='addEventListener')callback({listenerId:1,pingData:ping},true);};
    </script>`, { ...input, diagnostic: true });
    const observation = result.diagnostic_observation?.frameworks.gpp_observation;
    expect(observation?.structure).toMatchObject({
      supported_sections: [7, 8], present_sections: [7, 8], cmp_declared_applicable_sections: [7, 8],
      parsed_sections_available: true, parsed_section_prefixes: ['usca', 'usnat'], structural_consistency: 'consistent',
      sections: [
        expect.objectContaining({ section_id: 7, api_prefix: 'usnat', known: true, supported: true, present: true, cmp_declared_applicable: true, parsed_available: true }),
        expect.objectContaining({ section_id: 8, api_prefix: 'usca', known: true, supported: true, present: true, cmp_declared_applicable: true, parsed_available: true })
      ]
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('raw-gpp-secret');
    expect(serialized).not.toContain('publisher-secret');
    expect(serialized).not.toMatch(/SaleOptOut|SharingOptOut|CmpId|PublisherId/);
  }, 20_000);

  it('MM-01 preserves Shopify, OneTrust, GPP, and GCM as independent mechanisms', async () => {
    const result = await audit(`<script>
      window.dataLayer=[['consent','default',{ad_storage:'denied',analytics_storage:'denied'}]];
      window.OneTrust={RejectAll(){}};
      window.__gpp=(command, callback) => { const ping={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',cmpId:1,supportedAPIs:[],sectionList:[7],applicableSections:[7]}; if(command==='ping') callback(ping,true); if(command==='addEventListener') callback({listenerId:1,pingData:ping},true); };
      window.Shopify={customerPrivacy:{currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},analyticsProcessingAllowed(){return false},marketingAllowed(){return false},preferencesProcessingAllowed(){return false},saleOfDataAllowed(){return false},shouldShowBanner(){return false},getRegion(){return 'EU'}}};
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"></div>`);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toEqual(expect.arrayContaining(['cmp', 'commerce_privacy_runtime', 'framework', 'consent_mode']));
    expect(new Set(result.result.mechanisms.map((item) => `${item.mechanism}:${item.provider?.candidates.map((candidate) => candidate.provider_name).join(',') || ''}`)).size).toBe(result.result.mechanisms.length);
  });

  it('MM-02 reports Shopify alone without inventing an external CMP', async () => {
    const result = await audit(`<script>window.Shopify={customerPrivacy:{currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},analyticsProcessingAllowed(){return false},marketingAllowed(){return false},preferencesProcessingAllowed(){return false},saleOfDataAllowed(){return false},shouldShowBanner(){return false},getRegion(){return 'EU'}}};</script>`);
    expect(result.result.mechanisms.map((item) => item.mechanism)).toContain('commerce_privacy_runtime');
    expect(result.result.mechanisms.some((item) => item.mechanism === 'cmp' || item.mechanism === 'custom')).toBe(false);
  });

  it('GCM-01 classifies a denied default with pre-choice measurement as advanced through production wiring', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';
      function decline(){window.dataLayer.push(['consent','update',{ad_storage:'denied',analytics_storage:'denied'}]);}
    </script></head><body><script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline();Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consent={preferences:false,statistics:false,marketing:false}">Decline</button></div></body>`, false, { ...input, rollout: actionRollout });
    expect(result.google_consent_mode).toMatchObject({ classification: 'advanced_candidate', default_issued_late: false, lifecycle: 'default_and_update' });
    expect(result.telemetry.consent_mode_diagnostics).toMatchObject({ classification: 'advanced_candidate', default_core_signals: { status: 'partial', explicitly_set: ['ad_storage', 'analytics_storage'], missing: ['ad_user_data', 'ad_personalization'] } });
    expect(result.result.mechanisms.map((item) => item.mechanism)).toContain('consent_mode');
  }, 10_000);

  it('GCM-02 requires a full pre-choice window, gated measurement, and a positive update for Basic', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      function decline(){window.dataLayer.push(['consent','update',{ad_storage:'granted',analytics_storage:'granted'}]);new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G111';}
    </script></head><body><script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline();Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consent={preferences:false,statistics:false,marketing:false}">Decline</button></div></body>`, false, { ...input, rollout: actionRollout });
    expect(result.google_consent_mode).toMatchObject({ classification: 'basic_candidate', pre_choice_measurement_window_observed: true, tracking_gated: true });
    expect(result.telemetry.consent_mode_diagnostics).toMatchObject({ classification: 'basic_candidate', chronology: { update_only: false } });
  }, 10_000);

  it('GCM-03 keeps gcd-only evidence ambiguous', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcd=opaque';</script></head><body>fixture</body>`);
    expect(result.google_consent_mode.classification).toBe('ambiguous');
    expect(result.telemetry.consent_mode_diagnostics).toMatchObject({ classification: 'ambiguous', default_core_signals: { status: 'none' }, effective_core_signals: { status: 'none' }, network_observations: 1 });
  });

  it('GCM-04 captures the post-Reject Consent Mode update and surfaces a contradiction', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      function decline(){window.dataLayer.push(['consent','update',{ad_storage:'granted',analytics_storage:'granted'}]);}
    </script></head><body><script>window.Cookiebot={hasResponse:false,consented:false,declined:false,consent:{preferences:null,statistics:null,marketing:null}};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="decline();Cookiebot.hasResponse=true;Cookiebot.declined=true;Cookiebot.consent={preferences:false,statistics:false,marketing:false}">Decline</button></div></body>`, false, { ...input, rollout: actionRollout });
    expect(result.result.google_consent_mode.updates_observed).toBe(true);
    expect(result.google_consent_mode.commands.some((command) => command.command === 'update')).toBe(true);
    expect(result.result.reason_codes).toContain('STATE_CONTRADICTION');
  }, 10_000);

  it('does not classify a newsletter dialog as a custom CMP', async () => {
    const result = await audit('<div role="dialog">Newsletter <button>Sign up</button></div>');
    expect(result.result.mechanisms.some((item) => item.mechanism === 'custom')).toBe(false);
  });

  it.each([
    ['GENERIC-MULTI-01', '<div role="dialog">Subscribe to our newsletter.<button>Accept</button></div>'],
    ['GENERIC-MULTI-02', '<div role="dialog">Log in to your account.<button>Continue</button></div>']
  ])('%s detects the real custom CMP beside a negative-intent surface', async (_name, negativeSurface) => {
    const result = await audit(`${negativeSurface}<div id="cookie-notice">We use cookies.<button>Accept All</button><button>Reject All</button></div>`);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'custom')).toMatchObject({ provider: { attribution: 'unknown_candidate' } });
  });

  it.each([
    'We use cookies to personalize content and newsletter recommendations.',
    'We use cookies depending on your country and region.',
    'Our cookie notice includes a privacy policy and email personalization.'
  ])('GENERIC-POSITIVE retains a consent-shaped surface despite incidental copy', async (copy) => {
    const result = await audit(`<div id="cookie-notice">${copy}<button>Accept All</button><button>Reject All</button><button>Manage Preferences</button></div>`);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'custom')).toMatchObject({ provider: { attribution: 'unknown_candidate' } });
  });

  it.each([
    ['NEGATIVE-01', 'Newsletter — privacy policy and cookies', 'Sign up'],
    ['NEGATIVE-02', 'Login — cookie notice and privacy policy', 'Log in'],
    ['NEGATIVE-03', 'Age gate — cookie text and privacy policy', 'Confirm age'],
    ['NEGATIVE-04', 'Country selector — privacy text and cookies', 'Choose country'],
    ['NEGATIVE-05', 'Privacy notice — cookies', 'Accept'],
    ['NEGATIVE-06', 'Email updates — cookie wording and privacy policy', 'Subscribe']
  ])('%s keeps difficult non-CMP dialog intent out of the custom detector', async (_name, text, button) => {
    const result = await audit(`<div role="dialog">${text}<button>${button}</button></div>`);
    expect(result.result.mechanisms.some((item) => item.mechanism === 'custom')).toBe(false);
  });

  it('PREF-OT-01 runs Preferences then re-discovers the preference-center Reject', async () => {
    const result = await audit(`<script>
      window.OneTrust={ToggleInfoDisplay(){document.querySelector('#onetrust-banner-sdk').innerHTML='<div id="onetrust-pc-sdk"><button id="onetrust-reject-all-handler" onclick="window.rejected=true">Reject all</button></div>';}};
    </script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-pc-btn-handler" onclick="OneTrust.ToggleInfoDisplay()">Preferences</button></div>`, { ...input, rollout: actionRollout });
    expect(result.result.interactions.map((item) => item.action)).toEqual(['open_preferences', 'reject_all']);
    expect(result.result.interactions.every((item) => item.outcome === 'executed')).toBe(true);
  }, 10_000);

  it('PREF-AMB-01 leaves ambiguous preference categories untouched', async () => {
    const result = await audit(`<script>window.OneTrust={ToggleInfoDisplay(){document.querySelector('#onetrust-banner-sdk').innerHTML='<div id="onetrust-pc-sdk"><button>Toggle</button><button>Save preferences</button></div>';}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-pc-btn-handler" onclick="OneTrust.ToggleInfoDisplay()">Preferences</button></div>`, { ...input, rollout: actionRollout });
    // Opening preferences is preparatory; the session must explicitly record
    // that no safe Reject became available after rediscovery.
    expect(result.result.interactions).toMatchObject([
      { action: 'open_preferences', outcome: 'executed' },
      { action: 'reject_all', outcome: 'unsupported' }
    ]);
    expect(result.result.rejection_verification.status).toBe('inconclusive');
  });

  it('UC-SHADOW-01 and UC-SHADOW-02 preserve open and closed shadow topology', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<aside id="usercentrics-cmp-ui" style="display:block;width:320px;height:120px"></aside><script>document.querySelector('#usercentrics-cmp-ui').attachShadow({mode:'open'}).innerHTML='<button>Reject all</button>';</script>`);
      const { buildProviderContexts, actionTargetFor } = await import('./browser-context-builders');
      const contexts = await buildProviderContexts(page, await captureBrowserConsentFacts(page), await observeConsentFrameworksInPage(page));
      expect(actionTargetFor(contexts.get('usercentrics'), 'reject_all')).toMatchObject({ frame_path: ['top'], shadow_mode: 'open', accessible_control: true });
      await page.setContent(`<aside id="usercentrics-cmp-ui" style="display:block;width:320px;height:120px"></aside><script>document.querySelector('#usercentrics-cmp-ui').attachShadow({mode:'closed'});</script>`);
      expect((await captureBrowserConsentFacts(page)).usercentrics.shadow_mode).toBe('closed');
    } finally { await page.close(); }
  });

  it('API-01 and API-02 probe functions rather than provider-object presence', async () => {
    const oneTrust = await audit(`<script>window.OneTrust={AllowAll(){}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"></div>`);
    expect(oneTrust.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('not_present');
    const cookieYes = await audit(`<script>window.performBannerAction=()=>{};window.getCkyConsent=()=>({categories:{analytics:false}});</script><script src="https://cdn-cookieyes.com/client_data/test/script.js"></script><div class="cky-consent-container"></div>`);
    expect(cookieYes.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('cookieyes');
    expect(cookieYes.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('api_only');
  }, 10_000);

  it('CONFLICT-01 selects the visible OneTrust surface over a stale CookieYes library', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};window.CookieYes={};window.performBannerAction=()=>{};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><script src="https://cdn-cookieyes.com/client_data/test/script.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div><div class="cky-consent-container" style="display:none"></div>`);
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('onetrust');
    expect(result.telemetry).toMatchObject({ provider: 'onetrust', provider_conflict: true });
  });

  it('CONFLICT-02 leaves two active CMP surfaces inconclusive and takes no action', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};window.CookieYes={};window.performBannerAction=()=>{};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><script src="https://cdn-cookieyes.com/client_data/test/script.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div><div class="cky-consent-container"><button class="cky-btn-reject">Reject</button></div>`, { ...input, rollout: actionRollout });
    expect(result.result.reason_codes).toContain('PROVIDER_CONFLICT');
    expect(result.result.interactions).toEqual([]);
  });

  it('MULTI-01 keeps visible OneTrust as the primary user surface while preserving Shopify separately', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};window.Shopify={customerPrivacy:{currentVisitorConsent(){return {analytics:'no',marketing:'no',preferences:'no',sale_of_data:'no'}},analyticsProcessingAllowed(){return false},marketingAllowed(){return false},preferencesProcessingAllowed(){return false},saleOfDataAllowed(){return false},shouldShowBanner(){return false},getRegion(){return 'EU'}}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div>`);
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions.find((item) => item.action === 'reject_all')?.availability).toBe('direct');
    expect(result.result.initial_state.decision).toBe('ambiguous');
    expect(result.result.mechanisms.map((item) => item.mechanism)).toEqual(expect.arrayContaining(['cmp', 'commerce_privacy_runtime']));
  });

  it('routes an unknown custom consent banner through the generic detector', async () => {
    const result = await audit('<div id="cookie-notice">We use cookies.<button>Accept all</button><button>Reject all</button></div>');
    expect(result.result.mechanisms.find((item) => item.mechanism === 'custom')?.provider?.reason_codes).toContain('CMP_PROVIDER_UNKNOWN');
  });

  it('GENERIC-LIVE-01 captures the settings-and-acknowledgement topology without fabricating consent actions', async () => {
    const result = await audit('<div role="dialog">Cookie Notice: manage your privacy choices.<button>Manage Cookie Settings</button><button>Acknowledge</button></div>');
    expect(result.result.mechanisms.find((item) => item.mechanism === 'custom')?.provider?.attribution).toBe('unknown_candidate');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'open_preferences', availability: 'direct' }),
      expect.objectContaining({ action: 'accept_all', availability: 'not_present' }),
      expect.objectContaining({ action: 'reject_all', availability: 'not_present' })
    ]));
  });

  it('DIDOMI-LIVE-01 routes a positively identified Didomi template variant through generic-surface visibility corroboration', async () => {
    const result = await auditNavigation('<script>localStorage.setItem("didomi_token", "fixture");window.Didomi={};</script><script src="https://sdk.privacy-center.org/loader.js"></script><div role="dialog">Cookie Notice: manage your privacy choices.<button>Manage Cookie Settings</button><button>Acknowledge</button></div>');
    expect(result.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name).toBe('didomi');
    expect(result.result.banner).toMatchObject({ visibility: 'visible', evidence: ['didomi_generic_consent_surface'] });
  });

  it('CMP-SURFACE-07 captures bounded Cookiebot custom input controls without generic attribution', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><div id="cookie-custom" role="dialog">Cookie preferences<input type="button" value="ALLE AKZEPTIEREN"><input type="submit" value="NUR NOTWENDIGE"></div>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'only_necessary', availability: 'direct' })
    ]));
  });

  it('CMP-SURFACE-08 does not identify Cookiebot from the same generic custom controls', async () => {
    const result = await audit('<div id="cookie-custom" role="dialog">Cookie preferences<input type="button" value="ALLE AKZEPTIEREN"><input type="submit" value="NUR NOTWENDIGE"></div>');
    expect(result.telemetry.provider).not.toBe('cookiebot');
  });

  it('CMP-SURFACE-09 uses French generic controls to corroborate an identified Didomi template', async () => {
    const result = await audit('<script>window.Didomi={};</script><script src="https://sdk.privacy-center.org/loader.js"></script><div id="didomi-notice" style="display:none"></div><div id="cookie-custom" role="dialog">Cookies et confidentialite<button>Tout accepter</button><button>Continuer sans accepter</button><button>Personnaliser</button></div>');
    expect(result.telemetry.provider).toBe('didomi');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'reject_all', availability: 'direct' }),
      expect.objectContaining({ action: 'open_preferences', availability: 'direct' })
    ]));
  });

  it('CMP-SURFACE-11 captures Cookiebot custom descendants with interaction semantics', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><div id="cookie-custom" role="dialog">Cookie preferences<div onclick="void 0">ALLE AKZEPTIEREN</div><div onclick="void 0">NUR NOTWENDIGE</div></div>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'only_necessary', availability: 'direct' })
    ]));
  });

  it('CMP-SURFACE-12 does not identify Cookiebot from the same custom descendants', async () => {
    const result = await audit('<div id="cookie-custom" role="dialog">Cookie preferences<div onclick="void 0">ALLE AKZEPTIEREN</div><div onclick="void 0">NUR NOTWENDIGE</div></div>');
    expect(result.telemetry.provider).not.toBe('cookiebot');
  });

  it('CMP-SURFACE-13 does not promote plain Cookiebot surface text to a control', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><div id="cookie-custom" role="dialog">Cookie preferences<p>ALLE AKZEPTIEREN</p><span>NUR NOTWENDIGE</span></div>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.available_actions.some((action) => action.action === 'accept_all' && action.availability === 'direct')).toBe(false);
    expect(result.result.available_actions.some((action) => action.action === 'only_necessary' && action.availability === 'direct')).toBe(false);
  });

  it('CMP-SURFACE-14 keeps a visible Didomi consent UI visible when notice.isVisible() is false', async () => {
    const result = await audit('<script>window.Didomi={notice:{isVisible:()=>false}};</script><script src="https://sdk.privacy-center.org/loader.js"></script><div id="didomi-notice" style="display:none"></div><div id="cookie-custom" role="dialog">Cookies et confidentialite<button>Tout accepter</button><button>Continuer sans accepter</button><button>Personnaliser</button></div>');
    expect(result.telemetry.provider).toBe('didomi');
    expect(result.result.banner).toMatchObject({ visibility: 'visible', evidence: expect.arrayContaining(['didomi_notice_api_dom_disagreement']) });
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'reject_all', availability: 'direct' }),
      expect.objectContaining({ action: 'open_preferences', availability: 'direct' })
    ]));
  });

  it('UI-BRIDGE-01 through UI-BRIDGE-03 resolve nested semantic labels to their actionable ancestor', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><div role="dialog" class="cookie-consent">Cookie preferences<button><span>ALLE AKZEPTIEREN</span></button><div role="button"><span>NUR NOTWENDIGE</span></div></div>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'accept_all', availability: 'direct' }), expect.objectContaining({ action: 'only_necessary', availability: 'direct' })]));
  });

  it('UI-BRIDGE-04 and UI-BRIDGE-05 / Velux live-shape fixture traverse open nested shadow roots', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><div id="host"></div><script>const one=document.querySelector("#host").attachShadow({mode:"open"});one.innerHTML="<section role=dialog class=cookie-consent><div id=component></div></section>";const two=one.querySelector("#component").attachShadow({mode:"open"});two.innerHTML="<div role=button><span>NUR NOTWENDIGE</span></div><div role=button><span>ALLE AKZEPTIEREN</span></div>";</script>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'accept_all', availability: 'direct' }), expect.objectContaining({ action: 'only_necessary', availability: 'direct' })]));
  });

  it('Decathlon live-shape fixture bridges visible Didomi shadow controls over API false', async () => {
    const result = await audit('<script>window.Didomi={notice:{isVisible:()=>false}};</script><script src="https://sdk.privacy-center.org/loader.js"></script><div id="didomi-notice" style="display:none"></div><div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML="<section role=dialog class=cookie-consent><div role=button><span>Continuer sans accepter</span></div><div role=button><span>Personnaliser</span></div><div role=button><span>Tout accepter</span></div></section>";</script>');
    expect(result.telemetry.provider).toBe('didomi');
    expect(result.result.banner).toMatchObject({ visibility: 'visible', evidence: expect.arrayContaining(['didomi_notice_api_dom_disagreement']) });
    expect(result.result.available_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'accept_all', availability: 'direct' }), expect.objectContaining({ action: 'reject_all', availability: 'direct' }), expect.objectContaining({ action: 'open_preferences', availability: 'direct' })]));
  });

  it('Congstar live-shape fixture identifies the Usercentrics v2 loader and open-shadow controls without UC_UI', async () => {
    const result = await audit('<script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script><div id="host"></div><script>const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML="<section role=dialog class=cookie-consent><div role=button><span>Einstellungen verwalten</span></div><div role=button><span>Alles ablehnen</span></div><div role=button><span>Alles akzeptieren</span></div></section>";</script>');
    expect(result.telemetry).toMatchObject({ provider: 'usercentrics', provider_confidence: 'high' });
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'accept_all', availability: 'direct' }), expect.objectContaining({ action: 'reject_all', availability: 'direct' }), expect.objectContaining({ action: 'open_preferences', availability: 'direct' })]));
  });

  it('UI-BRIDGE-06 does not promote exact plain text without an actionable ancestor', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><div role="dialog" class="cookie-consent"><p>ALLE AKZEPTIEREN</p></div>');
    expect(result.result.available_actions.some((action) => action.action === 'accept_all' && action.availability === 'direct')).toBe(false);
  });

  it('UI-BRIDGE-07 does not classify ordinary cookie-policy footer content as a strong banner', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><footer class="cookie-policy">Read our cookie policy and privacy policy.</footer>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.banner.visibility).not.toBe('visible');
  });

  it('UI-SEPARATION-01 keeps a strong visible banner when no action is extracted', async () => {
    const result = await audit('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><div id="CybotCookiebotDialog" style="display:none"></div><section role="dialog" class="cookie-consent">Cookie and privacy settings</section>');
    expect(result.telemetry.provider).toBe('cookiebot');
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'accept_all', availability: 'not_present' })]));
  });

  it('UI-SEPARATION-02 keeps a deterministic provider when its UI has not rendered', async () => {
    const result = await audit('<script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script>');
    expect(result.telemetry).toMatchObject({ provider: 'usercentrics', provider_confidence: 'high' });
    expect(result.result.banner.visibility).toBe('unknown');
  });

  it('UI-SEPARATION-03 leaves generic cookie text unattributed', async () => {
    const result = await audit('<div class="cookie-policy">Cookie policy and privacy information.</div>');
    expect(result.telemetry.provider).not.toBe('cookiebot');
    expect(result.telemetry.provider).not.toBe('didomi');
    expect(result.telemetry.provider).not.toBe('usercentrics');
  });

  it('CMP-READINESS-LATE-01 / Velux live shape captures delayed Cookiebot controls', async () => {
    const result = await audit('<script src="https://consent.cookiebot.com/uc.js"></script><div id="mount"></div><script>setTimeout(()=>{document.querySelector("#mount").innerHTML=`<section style="position:fixed;width:360px;height:180px"><div class="cookie-copy" role="dialog" style="position:sticky">Cookie privacy settings</div><div class="actions"><div onclick="void 0"><span>NUR NOTWENDIGE</span></div><div onclick="void 0"><span>ALLE AKZEPTIEREN</span></div></div></section>`},3200)</script>', { ...input, diagnostic: true });
    expect(result.telemetry).toMatchObject({ provider: 'cookiebot', provider_confidence: 'high' });
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'only_necessary', availability: 'direct' })
    ]));
    expect(result.diagnostic_observation?.readiness).toMatchObject({ triggered: true, completion: 'positive_ui_ready' });
  }, 10_000);

  it('UI-SCOPE-01 resolves a fixed consent wrapper around sibling non-standard controls without document-wide scanning', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<script>window.Cookiebot={};</script><script src="https://consent.cookiebot.com/uc.js"></script><section style="position:fixed;width:360px;height:180px"><div class="cookie-copy">Cookie privacy settings</div><div class="actions"><div onclick="void 0">ALLE AKZEPTIEREN</div><div onclick="void 0">NUR NOTWENDIGE</div></div></section>');
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.generic.controls.map((control) => control.accessible_name)).toEqual(expect.arrayContaining(['ALLE AKZEPTIEREN', 'NUR NOTWENDIGE']));
    } finally { await page.close(); }
  });

  it('CMP-READINESS-LATE-02 / Decathlon live shape waits for a delayed Didomi DOM modal over API false', async () => {
    const result = await audit('<script>window.Didomi={notice:{isVisible:()=>false}};</script><script src="https://sdk.privacy-center.org/loader.js"></script><div id="mount"></div><script>setTimeout(()=>{document.querySelector("#mount").innerHTML="<section role=dialog style=position:fixed;width:360px;height:180px>Cookies<div role=button>Continuer sans accepter</div><div role=button>Personnaliser</div><div role=button>Tout accepter</div></section>"},1500)</script>', { ...input, diagnostic: true });
    expect(result.telemetry).toMatchObject({ provider: 'didomi', provider_confidence: 'high' });
    expect(result.result.banner).toMatchObject({ visibility: 'visible', evidence: expect.arrayContaining(['didomi_notice_api_dom_disagreement']) });
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'reject_all', availability: 'direct' }),
      expect.objectContaining({ action: 'open_preferences', availability: 'direct' })
    ]));
  }, 10_000);

  it('CMP-READINESS-LATE-03 / Congstar live shape waits for delayed open-shadow Usercentrics controls without UC_UI', async () => {
    const result = await audit('<script src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script><div id="host"></div><script>setTimeout(()=>{const root=document.querySelector("#host").attachShadow({mode:"open"});root.innerHTML="<section role=dialog style=position:fixed;width:360px;height:180px>Cookie settings<div role=button>Einstellungen verwalten</div><div role=button>Alles ablehnen</div><div role=button>Alles akzeptieren</div></section>"},1500)</script>', { ...input, diagnostic: true });
    expect(result.telemetry).toMatchObject({ provider: 'usercentrics', provider_confidence: 'high' });
    expect(result.result.banner.visibility).toBe('visible');
    expect(result.result.available_actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'accept_all', availability: 'direct' }),
      expect.objectContaining({ action: 'reject_all', availability: 'direct' }),
      expect.objectContaining({ action: 'open_preferences', availability: 'direct' })
    ]));
    expect(result.diagnostic_observation?.readiness?.final.open_shadow_roots).toBeGreaterThan(0);
  }, 10_000);

  it('CMP-READINESS-TIMEOUT-01 keeps a known provider without inventing UI after the bounded window', async () => {
    const result = await audit('<script src="https://consent.cookiebot.com/uc.js"></script>', { ...input, diagnostic: true });
    expect(result.telemetry).toMatchObject({ provider: 'cookiebot', provider_confidence: 'high' });
    expect(result.result.banner.visibility).toBe('unknown');
    expect(result.result.available_actions.some((action) => action.availability === 'direct')).toBe(false);
    expect(result.diagnostic_observation?.readiness).toMatchObject({ completion: 'timeout', reason_codes: ['CMP_UI_READINESS_TIMEOUT'] });
  }, 10_000);

  it('CMP-READINESS-EARLY-01 and CMP-READINESS-SKIP-01 exit on early UI and skip ordinary pages', async () => {
    const early = await audit('<script src="https://consent.cookiebot.com/uc.js"></script><div id="mount"></div><script>setTimeout(()=>{document.querySelector("#mount").innerHTML="<section role=dialog style=position:fixed;width:320px;height:120px>Cookies<button>Accept all</button><button>Reject all</button></section>"},200)</script>', { ...input, diagnostic: true });
    expect(early.diagnostic_observation?.readiness).toMatchObject({ triggered: true, completion: 'positive_ui_ready' });
    expect((early.diagnostic_observation?.readiness?.elapsed_ms || 4000)).toBeLessThan(1000);
    const skipped = await audit('<main>Ordinary editorial page</main>', { ...input, diagnostic: true });
    expect(skipped.diagnostic_observation?.readiness).toMatchObject({ triggered: false, completion: 'skipped' });
  }, 10_000);

  it('CMP-READINESS-SHARED-01 uses the same bounded readiness capture for the homepage path', async () => {
    const page = await browser.newPage();
    try {
      await installDeterministicExternalFixtureRouting(page);
      await page.setContent('<script src="https://sdk.privacy-center.org/loader.js"></script><div id="mount"></div><script>setTimeout(()=>{document.querySelector("#mount").innerHTML="<section role=dialog style=position:fixed;width:320px;height:120px>Cookies<button>Tout accepter</button><button>Continuer sans accepter</button></section>"},200)</script>');
      const result = await captureSharedConsentObservation(page, rollout, true);
      expect(result).toMatchObject({ provider: 'didomi', banner: { visibility: 'visible' } });
      expect(result.actions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'accept_all', availability: 'direct' }), expect.objectContaining({ action: 'reject_all', availability: 'direct' })]));
      expect(result.diagnostic_observation?.readiness).toMatchObject({ triggered: true, completion: 'positive_ui_ready' });
    } finally { await page.close(); }
  }, 10_000);

  it('TELEM-UNKNOWN-01 fingerprints the actual generic detector result stably and without raw values', async () => {
    const fixture = (host: string) => `<script src="https://${host}/consent.js"></script><div role="dialog">We use cookies.<button>Accept all</button><button>Reject all</button></div>`;
    const first = await audit(fixture('cmp-one.example'));
    const second = await audit(fixture('cmp-one.example'));
    const changed = await audit(fixture('cmp-two.example'));
    expect(first.result.mechanisms.find((item) => item.mechanism === 'custom')?.provider?.attribution).toBe('unknown_candidate');
    expect(first.telemetry).toMatchObject({ provider: 'generic', unknown_cmp_fingerprint: expect.stringMatching(/^ucmp:v1:/), action_status: 'not_attempted' });
    expect(first.telemetry.unknown_cmp_fingerprint).toBe(second.telemetry.unknown_cmp_fingerprint);
    expect(changed.telemetry.unknown_cmp_fingerprint).not.toBe(first.telemetry.unknown_cmp_fingerprint);
  });

  it('TELEM-CONFLICT-01 records provider conflict independently from final provider attribution', async () => {
    const result = await audit(`<script>window.OneTrust={RejectAll(){}};window.CookieYes={};window.performBannerAction=()=>{};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><script src="https://cdn-cookieyes.com/client_data/test/script.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div><div class="cky-consent-container" style="display:none"></div>`);
    expect(result.telemetry).toMatchObject({ provider: 'onetrust', provider_conflict: true });
  });

  it('PRE-01 captures a GA4 head event before DOMContentLoaded as pre-choice', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';</script></head><body>fixture</body>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'google_analytics', kind: 'event_hit', timing: 'pre_choice' })]));
    expect(result.telemetry.timeline?.navigation_started_at).not.toBeNull();
    expect(result.telemetry.timeline?.dom_content_loaded_at).not.toBeNull();
    expect(result.telemetry.measurement).toMatchObject({ state: 'unknown', pre_choice_event_hits: 1, limited_measurement_count: 0, full_measurement_count: 0, unknown_measurement_count: 1, gcm_network_observations: 1 });
  });

  it('CMP-MEASURE-MORPHE-BROWSER preserves denied head pings and exact fresh-context counts', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(['consent','default',{analytics_storage:'denied'}]);
      new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100';
      new Image().src='https://www.google-analytics.com/g/collect?en=scroll&gcs=G100';
      new Image().src='https://www.google.com/ccm/collect?gcs=G100';
    </script><script src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script></head><body>fixture</body>`);
    expect(result.telemetry.measurement).toMatchObject({ state: 'unknown', contradiction: false,
      tracking_requests_observed: 3, tracking_signals_classified: 3, pre_choice_event_hits: 2,
      pre_choice_script_loads: 1, gcm_network_observations: 3, gcm_commands: 1, full_measurement_count: 0, limited_measurement_count: 0 });
    expect(result.telemetry.observation_only).toBe(true);
    expect(result.result.interactions).toEqual([]);
  });

  it('PRE-02 captures an immediate Meta conversion signal as pre-choice', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.facebook.com/tr/?ev=Purchase';</script></head><body>fixture</body>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'meta', kind: 'conversion_hit', timing: 'pre_choice' })]));
  });

  it('BUFFER-01 retains GA4 after more than 100 unrelated browser requests', async () => {
    const result = await auditNavigation(`<head><script>for(let i=0;i<150;i+=1)new Image().src='https://storefront.example/api/'+i+'?secret=value';new Image().src='https://www.google-analytics.com/g/collect?en=page_view&secret=value';</script></head><body>fixture</body>`);
    expect(result.tracking.signals).toEqual(expect.arrayContaining([expect.objectContaining({ vendor: 'google_analytics', timing: 'pre_choice' })]));
    expect(result.result.network_signals).toHaveLength(1);
  });

  it('TIMESTAMP-01 through TIMESTAMP-03 use activation rather than action-attempt start', async () => {
    const result = await auditNavigation(`<script>let rejected=false;window.OneTrust={RejectAll(){rejected=true;}};</script><script src="https://cdn.cookielaw.org/otSDKStub.js"></script><div id="onetrust-banner-sdk" style="display:block;width:320px;height:120px"><button id="onetrust-reject-all-handler" onclick="const until=Date.now()+25;while(Date.now()<until){};OneTrust.RejectAll()">Reject all</button></div>`, false, { ...input, rollout: actionRollout });
    expect(result.telemetry.timeline?.action_attempt_started_at).not.toBeNull();
    expect(result.telemetry.timeline?.user_choice_at).toBeGreaterThan(result.telemetry.timeline?.action_attempt_started_at || 0);
  }, 20_000);

  it('PRE-03 observes a pre-choice Consent Mode default and its early Google ping', async () => {
    const result = await auditNavigation(`<head><script>
      window.dataLayer=[]; function gtag(){window.dataLayer.push(arguments);}
      gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied'});
      new Image().src='https://www.google-analytics.com/g/collect?en=page_view&gcs=G100&gcd=opaque&dma=1&dma_cps=1&gcu=1&gcut=1&npa=1';
    </script></head><body>fixture</body>`);
    expect(result.result.google_consent_mode.defaults_observed).toBe(true);
    expect(result.google_consent_mode.commands.some((command) => command.command === 'default')).toBe(true);
    expect(result.google_consent_mode.network.some((observation) => observation.parameters.gcs?.present && observation.parameters.gcd?.present && observation.parameters.dma?.present && observation.parameters.dma_cps?.present && observation.parameters.gcu?.present && observation.parameters.gcut?.present && observation.parameters.npa?.present)).toBe(true);
  });

  it('PRE-04 keeps pre-choice tracking classification in observation-only mode', async () => {
    const result = await auditNavigation(`<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view';</script></head><body>fixture</body>`);
    expect(result.telemetry.observation_only).toBe(true);
    expect(result.telemetry.timeline?.user_choice_at).toBeNull();
    expect(result.tracking.signals.some((signal) => signal.timing === 'pre_choice')).toBe(true);
  });

  it('PRE-05 preserves a challenge outcome without claiming no CMP', async () => {
    const result = await auditNavigation('<title>Checking your browser</title><body>challenge</body>', true);
    expect(result.result.reason_codes).toContain('BLOCKED_OR_CHALLENGED');
    expect(result.result.reason_codes).not.toContain('NO_CMP_DETECTED');
  });
});
