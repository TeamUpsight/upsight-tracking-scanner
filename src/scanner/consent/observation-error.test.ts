import { chromium, type Browser } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as builders from './browser-context-builders';
import { consentObservationFailure, withConsentObservationStage } from './observation-stage';
import { captureSharedConsentObservation } from './v2-session';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('bounded Consent observation failures', () => {
  it.each([
    ['OBS-ERR-01', 'captureBrowserConsentFacts', 'browser_facts', 'captureBrowserConsentFacts'],
    ['OBS-ERR-02', 'observeConsentFrameworksInPage', 'framework_observation', 'observeConsentFrameworksInPage'],
    ['OBS-ERR-03', 'buildProviderContexts', 'provider_context_build', 'buildProviderContexts']
  ] as const)('%s attributes %s without declaring CMP absent', async (_id, functionName, stage, operation) => {
    const page = await browser.newPage();
    try {
      const failure = new Error('raw page data must never enter the trace');
      vi.spyOn(builders, functionName).mockRejectedValueOnce(failure as never);
      let caught: unknown;
      try { await captureSharedConsentObservation(page); } catch (error) { caught = error; }
      expect(caught).toBe(failure);
      expect(consentObservationFailure(caught)).toEqual({ observation_stage: stage, operation });
      expect(JSON.stringify(consentObservationFailure(caught))).not.toContain('raw page data');
    } finally { await page.close(); }
  }, 15_000);

  it('OBS-ERR-04 keeps the first, more precise stage on a nested rethrow', async () => {
    const error = new Error('private');
    let caught: unknown;
    try {
      await withConsentObservationStage('ui_readiness', 'waitForConsentUiReadiness', () =>
        withConsentObservationStage('usercentrics_v2_state_read', 'readUsercentricsV2State', async () => { throw error; }));
    } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(consentObservationFailure(caught)).toEqual({ observation_stage: 'usercentrics_v2_state_read', operation: 'readUsercentricsV2State' });
  });
});
