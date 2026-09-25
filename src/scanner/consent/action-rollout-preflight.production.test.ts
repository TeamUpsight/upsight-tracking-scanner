import { createServer } from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actionTargetFor, buildProviderContexts, captureBrowserConsentFacts, observeConsentFrameworksInPage } from './browser-context-builders';
import { createFreshConsentContext, navigateFreshConsentContext } from './fresh-context';
import { certificationSafeConsentV2RolloutControls, consentV2ActionsEnabledFor, consentV2RolloutControls } from './rollout-controls';
import { discoverUsercentricsSemanticControls } from './usercentrics-semantic-controls';
import { usercentricsV2Decision } from './usercentrics-v2-state';
import { usercentricsVerificationCapability } from './usercentrics-adapter';
import { captureSharedConsentObservation, prepareConsentV2Session, runConsentV2Session } from './v2-session';

const actionBoundary = vi.hoisted(() => ({ snapshots: [] as Array<{ action: string; attached: boolean; visible: boolean; enabled: boolean; surface_active: boolean }> }));
vi.mock('./action-planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./action-planner')>();
  return {
    ...actual,
    async executeActionPlan(plan: Parameters<typeof actual.executeActionPlan>[0], bridge: Parameters<typeof actual.executeActionPlan>[1]) {
      // Exercise the production action bridge's final target inspection, then
      // stop before executeStrategy can invoke a browser control.
      const snapshot = await bridge.inspectTarget(plan, plan.eligible_strategies[0]);
      actionBoundary.snapshots.push({
        action: plan.action, attached: snapshot.attached, visible: snapshot.visible,
        enabled: snapshot.enabled, surface_active: snapshot.surface_active
      });
      throw new Error('PREFLIGHT_STOP_BEFORE_ACTIVATION');
    }
  };
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
});
afterAll(async () => { await browser?.close(); });

const html = `<script type="application/json" src="https://app.usercentrics.eu/browser-ui/latest/loader.js"></script>
<script>
  window.__activations = 0;
  window.UC_UI = { isInitialized: () => true, getServicesBaseInfo: () => [
    { isEssential: true, consent: { status: true, history: [] }, categorySlug: 'essential' },
    { isEssential: false, consent: { status: false, history: [] }, categorySlug: 'marketing' }
  ] };
  setTimeout(() => {
    const host = document.createElement('div');
    host.id = 'usercentrics-root';
    host.style = 'position:absolute;width:0;height:0';
    document.body.appendChild(host);
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<div id="uc-center-container" role="dialog" aria-modal="true" data-testid="uc-tcf-first-layer" style="position:fixed;top:20px;left:20px;width:420px;height:220px;background:white">' +
      '<button data-testid="uc-customize-button">Einstellungen verwalten</button>' +
      '<button data-testid="uc-deny-all-button">Alles ablehnen</button>' +
      '<button data-testid="uc-accept-all-button">Alles akzeptieren</button></div>';
    host.shadowRoot.querySelector('[data-testid="uc-deny-all-button"]')
      .addEventListener('click', () => window.__activations++);
    window.dispatchEvent(new Event('UC_UI_INITIALIZED'));
    window.dispatchEvent(new CustomEvent('UC_UI_VIEW_CHANGED', { detail: { view: 'FIRST_LAYER' } }));
    window.dispatchEvent(new CustomEvent('UC_UI_CMP_EVENT', { detail: { type: 'CMP_SHOWN' } }));
  }, 50);
</script>`;

describe('Usercentrics action rollout fresh preflight', () => {
  it('reaches the same no-click Browser UI boundary with actions disabled and enabled', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Preflight fixture server has no port.');
    const url = `http://127.0.0.1:${address.port}/`;

    async function preflight(actionsEnabled: boolean) {
      actionBoundary.snapshots.length = 0;
      const controls = certificationSafeConsentV2RolloutControls(consentV2RolloutControls({
        CONSENT_V2_ENABLED: 'true',
        CONSENT_V2_ACTIONS_ENABLED: String(actionsEnabled),
        CONSENT_V2_ACTION_SAMPLE_PERCENT: actionsEnabled ? '100' : '0',
        CONSENT_USERCENTRICS_ACTIONS_ENABLED: 'true'
      }), true);
      const fresh = await createFreshConsentContext(browser, {
        requestedGeo: 'EU', proxyRegion: 'de', independentlyVerified: true
      });
      const capture = await prepareConsentV2Session(fresh.page);
      try {
        capture.markNavigationStarted();
        const navigation = await navigateFreshConsentContext(fresh.page, url, {
          timings: { initialObservationMs: 150, providerReadinessMs: 500, postActionSettleMs: 300, reloadSettleMs: 500 }
        });
        if (navigation.dom_content_loaded) capture.markDOMContentLoaded();
        capture.markInitialObservationCompleted();
        // This existing production observation boundary runs the same initial
        // snapshot path as runConsentV2Session, then stops before action planning.
        const observed = await captureSharedConsentObservation(fresh.page, controls, true, 'EU');
        const facts = await captureBrowserConsentFacts(fresh.page);
        const frameworks = await observeConsentFrameworksInPage(fresh.page);
        const discovery = await discoverUsercentricsSemanticControls(fresh.page, { browserUiEligible: true });
        const contexts = await buildProviderContexts(fresh.page, facts, frameworks, discovery, 'EU');
        const context = contexts.get('usercentrics');
        const capability = usercentricsVerificationCapability({ status: 'available', strong_families: [], reason_codes: [] }, context);
        const target = actionTargetFor(context, 'reject_all');
        const diagnostic = observed.diagnostic_observation;
        const census = diagnostic?.usercentrics_main_frame_census;
        const preflight = {
          navigation_status: navigation.response?.status(), dom_content_loaded: navigation.dom_content_loaded,
          geo_verified: fresh.geo.verified,
          provider: observed.provider,
          provider_conflict: observed.provider_conflict,
          provider_confidence: diagnostic?.provider_selection.candidates.find((item) => item.provider === 'usercentrics')?.confidence,
          runtime: facts.usercentrics.runtime_version,
          runtime_variant: facts.usercentrics.lifecycle.latest_view,
          topology: census?.usercentrics_surface_topology,
          root_count: census?.browser_ui_root_count,
          shadow_open: census?.browser_ui_shadow_open,
          first_layers: census?.first_layer_surface_count,
          prechoice: usercentricsV2Decision(facts.usercentrics.service_state),
          explicit_decision_present: facts.usercentrics.service_state.explicit_decision_present,
          verification_capability: capability.status,
          reject_availability: observed.actions.find((item) => item.action === 'reject_all')?.availability,
          reject_candidates: census?.reject_semantic_candidate_count,
          provider_owned_reject: census?.provider_owned_reject_candidate_count,
          direct_actionable_reject: census?.direct_actionable_reject_count,
          target_resolved: Boolean(target?.target_ref && target.attached && target.visible && target.enabled && target.accessible_control),
          reject_control: discovery.controls.find((item) => item.action === 'reject_all')?.accessible_name,
          activation_count: await fresh.page.evaluate(() => (window as any).__activations)
        };
        let reachedActionBoundary = false;
        try {
          await runConsentV2Session(fresh.page, {
            geo: 'EU', geo_verified: true, page_valid: true, diagnostic: true,
            rollout: controls,
            timings: { initialObservationMs: 150, providerReadinessMs: 500, postActionSettleMs: 300, reloadSettleMs: 500 }
          }, capture);
        } catch (error) {
          if ((error as Error).message !== 'PREFLIGHT_STOP_BEFORE_ACTIVATION') throw error;
          reachedActionBoundary = true;
        }
        const activationCount = await fresh.page.evaluate(() => (window as any).__activations);
        return {
          preflight, action_gate: consentV2ActionsEnabledFor(controls, 'usercentrics', url),
          reached_action_boundary: reachedActionBoundary,
          boundary_snapshots: [...actionBoundary.snapshots], activation_count: activationCount
        };
      } finally {
        capture.dispose();
        await fresh.context.close();
      }
    }

    try {
      const disabled = await preflight(false);
      const enabled = await preflight(true);
      expect(enabled.preflight).toEqual(disabled.preflight);
      expect(enabled.preflight).toMatchObject({
        navigation_status: 200, dom_content_loaded: true, geo_verified: true,
        provider: 'usercentrics', provider_conflict: false, provider_confidence: 'high',
        runtime: 'v2_uc_ui', runtime_variant: 'FIRST_LAYER', topology: 'open_shadow_browser_ui',
        root_count: 1, shadow_open: true, first_layers: 1,
        prechoice: 'unanswered', explicit_decision_present: false,
        verification_capability: 'available', reject_availability: 'direct',
        reject_candidates: 1, provider_owned_reject: 1, direct_actionable_reject: 1,
        target_resolved: true, reject_control: 'Alles ablehnen', activation_count: 0
      });
      expect(disabled.action_gate).toBe(false);
      expect(enabled.action_gate).toBe(true);
      expect(disabled.reached_action_boundary).toBe(false);
      expect(disabled.boundary_snapshots).toEqual([]);
      expect(enabled.reached_action_boundary).toBe(true);
      expect(enabled.boundary_snapshots).toEqual([{
        action: 'reject_all', attached: true, visible: true, enabled: true, surface_active: true
      }]);
      expect(disabled.activation_count).toBe(0);
      expect(enabled.activation_count).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
