import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureBrowserConsentFacts } from './browser-context-builders';
import { captureUsercentricsMainFrameCensus } from './usercentrics-main-frame-census';
import { discoverUsercentricsSemanticControls } from './usercentrics-semantic-controls';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

async function fixture(html: string, verify: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try { await page.setContent(html); await verify(page); } finally { await page.close(); }
}

const controls = '<button>Einstellungen verwalten</button><button>Alles ablehnen</button><button>Alles akzeptieren</button>';
const dialog = (inside = controls) => `<section role="dialog" aria-modal="true" style="position:fixed;width:420px;height:220px">Cookie Einstellungen ${inside}</section>`;

describe('Usercentrics diagnostic main-frame census', () => {
  it('UC-MAIN-02 keeps exact German labels in an unowned dialog observation-only', async () => {
    await fixture(dialog(), async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      const census = await captureUsercentricsMainFrameCensus(page, facts, true);
      expect(census).toMatchObject({ usercentrics_surface_topology: 'main_frame_unowned', main_frame_consent_surface_count: 1,
        provider_owned_surface_count: 0, reject_semantic_candidate_count: 1, accept_semantic_candidate_count: 1,
        preferences_semantic_candidate_count: 1, provider_owned_reject_candidate_count: 0, ownership_reason: 'no_provider_marker',
        semantic_control_inventory: {
          reject_all: { candidate_count: 1, visible_count: 1, enabled_count: 1, directly_actionable_count: 1 },
          accept_all: { candidate_count: 1, visible_count: 1, enabled_count: 1, directly_actionable_count: 1 },
          open_preferences: { candidate_count: 1, visible_count: 1, enabled_count: 1, directly_actionable_count: 1 }
        } });
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('UC-MAIN-03 does not promote identical labels on a non-Usercentrics page', async () => {
    await fixture(dialog(), async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      expect(facts.usercentrics.runtime_version).toBe('unknown');
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('UC-MAIN-04 reports two visible generic surfaces as ambiguous', async () => {
    await fixture(dialog() + dialog(), async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census).toMatchObject({ usercentrics_surface_topology: 'ambiguous', main_frame_consent_surface_count: 2,
        provider_owned_surface_count: 0, ownership_reason: 'ambiguous_multiple_surfaces' });
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('UC-MAIN-05 reports duplicate Reject owners but resolves no target', async () => {
    await fixture(dialog(controls + '<button>Alles ablehnen</button>'), async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census).toMatchObject({ usercentrics_surface_topology: 'ambiguous', reject_semantic_candidate_count: 2,
        direct_actionable_reject_count: 2, provider_owned_reject_candidate_count: 0, ownership_reason: 'ambiguous_multiple_controls' });
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('UC-MAIN-06 rejects a text descendant when its actionable ancestor has a different name', async () => {
    await fixture(dialog('<button aria-label="Continue"><span>Alles ablehnen</span></button>'), async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census).toMatchObject({ reject_semantic_candidate_count: 0, direct_actionable_reject_count: 0,
        not_direct_actionable_target_count: 1, provider_owned_reject_candidate_count: 0 });
    });
  });

  it('UC-MAIN-07 observes one direct Reject but keeps it non-executable without ownership', async () => {
    await fixture(dialog('<button>Alles ablehnen</button>'), async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census).toMatchObject({ reject_semantic_candidate_count: 1, direct_actionable_reject_count: 1,
        provider_owned_reject_candidate_count: 0, usercentrics_surface_topology: 'main_frame_unowned' });
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('reports a disabled semantic owner without counting it as directly actionable', async () => {
    await fixture(dialog('<button disabled>Alles ablehnen</button>'), async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census.semantic_control_inventory.reject_all).toEqual({ candidate_count: 1, visible_count: 1, enabled_count: 0, directly_actionable_count: 0 });
      expect(census.provider_owned_reject_candidate_count).toBe(0);
    });
  });

  it('UC-MAIN-08 leaves the certified standard open-shadow path intact', async () => {
    await fixture('<aside id="usercentrics-cmp-ui" style="display:block;width:420px;height:220px"></aside><script>document.querySelector("aside").attachShadow({mode:"open"}).innerHTML="<button>Alles ablehnen</button>"</script>', async (page) => {
      const facts = await captureBrowserConsentFacts(page);
      const census = await captureUsercentricsMainFrameCensus(page, facts, true);
      expect(census).toMatchObject({ usercentrics_surface_topology: 'open_shadow_standard', ownership_reason: 'standard_root' });
      expect((await discoverUsercentricsSemanticControls(page)).controls.map((control) => control.action)).toContain('reject_all');
    });
  });

  it('keeps a provider-name prefix as a diagnostic hint, never ownership', async () => {
    await fixture(`<div class="usercentrics-candidate">${dialog()}</div>`, async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census.surfaces[0]).toMatchObject({ provider_prefix_candidate_present: true, provider_marker_present: false });
      expect(census.provider_owned_surface_count).toBe(0);
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('does not turn a named root without an open shadow into a main-frame action topology', async () => {
    await fixture(`<aside id="usercentrics-cmp-ui" role="dialog" style="position:fixed;width:420px;height:220px">Cookie Einstellungen ${controls}</aside>`, async (page) => {
      const census = await captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
      expect(census).toMatchObject({ usercentrics_surface_topology: 'closed_shadow', ownership_reason: 'unsupported_topology', provider_owned_surface_count: 0 });
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });
});
