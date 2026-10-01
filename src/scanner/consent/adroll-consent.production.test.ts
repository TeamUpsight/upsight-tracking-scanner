import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapConsentV2ToExisting } from './compatibility-mapper';
import { consentV2RolloutControls } from './rollout-controls';
import { prepareConsentV2Session, runConsentV2Session, type ConsentV2SessionInput } from './v2-session';

const input: ConsentV2SessionInput = {
  geo: 'EU', geo_verified: true, page_valid: true, diagnostic: true,
  appearance_wait_ms: 80, rollout_key: 'fixture.example', rollout: consentV2RolloutControls({})
};

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    headless: true
  });
});

afterAll(async () => { await browser?.close(); });

async function installDeterministicExternalFixtureRouting(page: Page) {
  await page.route('https://**/*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: '/* deterministic AdRoll fixture asset */' });
  });
}

async function audit(html: string) {
  const page = await browser.newPage();
  try {
    await installDeterministicExternalFixtureRouting(page);
    const capture = await prepareConsentV2Session(page, true);
    capture.markNavigationStarted();
    await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, { waitUntil: 'domcontentloaded' });
    capture.markDOMContentLoaded();
    const output = await runConsentV2Session(page, input, capture);
    const counters = await page.evaluate(() => ({
      load: Number((window as any).__adrollLoadCalls || 0),
      action: Number((window as any).__adrollActionCalls || 0)
    }));
    return { output, counters };
  } finally {
    await page.close();
  }
}

function selectedProvider(output: Awaited<ReturnType<typeof runConsentV2Session>>) {
  return output.result.mechanisms.find((item) => item.mechanism === 'cmp')?.provider?.candidates[0]?.provider_name;
}

const tcfRuntime = `<script>
  window.__tcfapi=(command,version,callback)=>{
    if(command==='ping')callback({cmpLoaded:true,cmpStatus:'loaded',apiVersion:'2.2',gdprApplies:true},true);
    if(command==='addEventListener')callback({listenerId:1,eventStatus:'tcloaded',cmpStatus:'loaded',gdprApplies:true,purpose:{consents:{}},vendor:{consents:{}}},true);
  };
</script>`;

describe('Consent P0.1.5 AdRoll production detection', () => {
  it('A: identifies the exact script-only AdRoll fixture without inventing visible UI', async () => {
    const { output } = await audit('<main>Storefront</main><script src="https://s.adroll.com/j/consent_tcfv2.js"></script>');
    expect(selectedProvider(output)).toBe('adroll');
    expect(output.result.banner.visibility).not.toBe('visible');
    expect(output.diagnostic_observation?.provider_selection).toMatchObject({
      selected_provider: 'adroll',
      candidates: [expect.objectContaining({ provider: 'adroll', confidence: 'high', deterministic_provider_signature: true })]
    });
    expect(output.diagnostic_observation?.adroll).toMatchObject({ provider_candidate: true, script_detected: true, banner_visible: false });
  }, 15_000);

  it('B: records the AdRoll global and loadWhenReady availability without invoking it', async () => {
    const { output, counters } = await audit(`<script>
      window.__adrollLoadCalls=0;
      window.__adroll_consent_banner={loadWhenReady(){window.__adrollLoadCalls++;}};
    </script><main>Storefront</main>`);
    expect(selectedProvider(output)).toBe('adroll');
    expect(output.diagnostic_observation?.adroll).toMatchObject({ global_detected: true, load_when_ready_available: true });
    expect(counters.load).toBe(0);
  }, 15_000);

  it('C: observes a visible AdRoll root and root-scoped semantic controls without executing actions', async () => {
    const { output, counters } = await audit(`<script>
      window.__adrollLoadCalls=0;window.__adrollActionCalls=0;
      window.__adroll_consent_banner={loadWhenReady(){window.__adrollLoadCalls++;}};
    </script>
    <section id="adroll_consent_banner" role="dialog" style="display:block;position:fixed;width:420px;height:180px">Cookie privacy choices
      <button onclick="window.__adrollActionCalls++">Accept all</button>
      <button onclick="window.__adrollActionCalls++">Reject all</button>
      <button onclick="window.__adrollActionCalls++">Manage preferences</button>
      <button onclick="window.__adrollActionCalls++">Save preferences</button>
    </section>`);
    expect(selectedProvider(output)).toBe('adroll');
    expect(output.result.banner.visibility).toBe('visible');
    expect(output.diagnostic_observation?.adroll).toMatchObject({ banner_root_detected: true, banner_visible: true, semantic_control_count: 4 });
    expect(output.diagnostic_observation?.visible_controls.map((item) => item.semantic_action)).toEqual(expect.arrayContaining([
      'accept_all', 'reject_all', 'open_preferences', 'save_preferences'
    ]));
    expect(output.result.available_actions).toEqual([]);
    expect(output.result.interactions).toEqual([]);
    expect(counters).toEqual({ load: 0, action: 0 });
  }, 15_000);

  it('D: keeps an existing but hidden AdRoll root non-visible and passive', async () => {
    const { output, counters } = await audit(`<script>window.__adrollActionCalls=0;</script>
      <section id="adroll_consent_banner" style="display:none;width:420px;height:180px">Cookie privacy choices
        <button onclick="window.__adrollActionCalls++">Reject all</button>
      </section>`);
    expect(selectedProvider(output)).toBe('adroll');
    expect(output.result.banner.visibility).toBe('not_visible');
    expect(output.diagnostic_observation?.adroll).toMatchObject({ banner_root_detected: true, banner_visible: false });
    expect(output.result.interactions).toEqual([]);
    expect(counters.action).toBe(0);
  }, 15_000);

  it('E: preserves TCF framework presence beside deterministic AdRoll identity', async () => {
    const { output } = await audit(`${tcfRuntime}<script>window.__adroll_consent_banner={};</script>`);
    expect(selectedProvider(output)).toBe('adroll');
    expect(output.result.frameworks.tcf).toBe('present');
    expect(output.diagnostic_observation?.frameworks.tcf).toBe(true);
  }, 15_000);

  it('F: never maps TCF-only framework evidence to AdRoll', async () => {
    const { output } = await audit(tcfRuntime);
    expect(selectedProvider(output)).not.toBe('adroll');
    expect(output.diagnostic_observation?.provider_selection.candidates.some((candidate) => candidate.provider === 'adroll')).toBe(false);
    expect(output.result.frameworks.tcf).toBe('present');
  }, 15_000);

  it('G: keeps an exact-DE audit-586-shaped observation conservative with TCF/GPP and no visible banner', async () => {
    const { output, counters } = await audit(`${tcfRuntime}<script>
      window.__adrollLoadCalls=0;
      window.__adroll_consent_banner={loadWhenReady(){window.__adrollLoadCalls++;}};
      window.__gpp=(command,callback)=>{const ping={gppVersion:'1.1',cmpStatus:'loaded',cmpDisplayStatus:'hidden',signalStatus:'ready',supportedAPIs:['7:usnat'],sectionList:[7],applicableSections:[7]};if(command==='ping')callback(ping,true);if(command==='addEventListener')callback({listenerId:1,pingData:ping},true);};
    </script><script src="https://s.adroll.com/j/consent_tcfv2.js"></script><main>Rendered storefront</main>`);
    const compatibility = mapConsentV2ToExisting(output.result, {
      geo: 'EU', page_valid: true, tracking_before_interaction: false, post_reject_observation_completed: false
    });
    expect(output.telemetry.render_state).toBe('ready');
    expect(selectedProvider(output)).toBe('adroll');
    expect(output.result.frameworks).toMatchObject({ tcf: 'present', gpp: 'present' });
    expect(output.result.banner.visibility).not.toBe('visible');
    expect(output.result.reason_codes).not.toContain('NO_CMP_DETECTED');
    expect(output.result.interactions).toEqual([]);
    expect(output.telemetry.action_attempted).toBe(false);
    expect(counters.load).toBe(0);
    expect(compatibility).toMatchObject({ cmp_provider: 'AdRoll', consent_status: 'inconclusive' });
  }, 15_000);
});
