import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureBrowserConsentFacts } from './browser-context-builders';
import { captureUsercentricsMainFrameCensus } from './usercentrics-main-frame-census';
import { discoverUsercentricsSemanticControls } from './usercentrics-semantic-controls';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true }); });
afterAll(async () => { await browser?.close(); });

const deny = '<button data-testid="uc-deny-all-button">Alles ablehnen</button>';
const accept = '<button data-testid="uc-accept-all-button">Alles akzeptieren</button>';
const customize = '<button data-testid="uc-customize-button">Einstellungen verwalten</button>';
const layer = (controls = `${customize}${deny}${accept}`, testId = 'uc-tcf-first-layer') =>
  `<div id="uc-center-container" role="dialog" aria-modal="true" data-testid="${testId}" style="position:fixed;top:20px;left:20px;width:420px;height:220px;background:white">${controls}</div>`;

async function fixture(markup: string, check: (page: Page) => Promise<void>, hosts = 1) {
  const page = await browser.newPage();
  try {
    await page.setContent(Array.from({ length: hosts }, () => '<div id="usercentrics-root" style="position:absolute;width:0;height:0"></div>').join(''));
    if (hosts === 1) await page.evaluate((html) => { document.querySelector('#usercentrics-root')!.attachShadow({ mode: 'open' }).innerHTML = html; }, markup);
    await check(page);
  } finally { await page.close(); }
}

async function census(page: Page) {
  return captureUsercentricsMainFrameCensus(page, await captureBrowserConsentFacts(page), true);
}

const discover = (page: Page) => discoverUsercentricsSemanticControls(page, { browserUiEligible: true });

describe('Usercentrics Browser UI open-shadow ownership', () => {
  it('UC-BUI-01 resolves all three exact controls under an invisible host', async () => {
    await fixture(layer(), async (page) => {
      expect(await page.locator('div#usercentrics-root').isVisible()).toBe(false);
      const found = await discover(page);
      expect(found.controls.map((control) => control.action).sort()).toEqual(['accept_all', 'open_preferences', 'reject_all']);
      expect(found.controls.find((control) => control.action === 'reject_all')).toMatchObject({
        surface_id: 'div#usercentrics-root', shadow_mode: 'open', actionable: true
      });
      expect(await census(page)).toMatchObject({ usercentrics_surface_topology: 'open_shadow_browser_ui',
        browser_ui_root_present: true, browser_ui_shadow_open: true, first_layer_surface_count: 1,
        provider_owned_surface_count: 1, reject_semantic_candidate_count: 1, accept_semantic_candidate_count: 1,
        preferences_semantic_candidate_count: 1, provider_owned_reject_candidate_count: 1,
        ownership_reason: 'browser_ui_open_shadow_root' });
    });
  });

  it('UC-BUI-02 never promotes a generic main-frame dialog with identical labels', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div role="dialog" aria-modal="true" style="position:fixed;width:420px;height:220px">Cookie Einstellungen ${customize}${deny}${accept}</div>`);
      expect((await discover(page)).controls).toEqual([]);
      expect((await census(page)).provider_owned_surface_count).toBe(0);
    } finally { await page.close(); }
  });

  it('UC-BUI-03 rejects a named root without an open shadow tree', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<div id="usercentrics-root">${layer()}</div>`);
      expect((await discover(page)).controls).toEqual([]);
      expect(await census(page)).toMatchObject({ usercentrics_surface_topology: 'closed_shadow', provider_owned_surface_count: 0, browser_ui_shadow_open: false });
    } finally { await page.close(); }
  });

  it('UC-BUI-04 rejects a dialog with the wrong first-layer marker', async () => {
    await fixture(layer(deny, 'other-layer'), async (page) => {
      expect((await discover(page)).controls).toEqual([]);
      expect(await census(page)).toMatchObject({ first_layer_surface_count: 0, provider_owned_surface_count: 0 });
    });
  });

  it('UC-BUI-05 rejects the correct button outside the qualified first layer', async () => {
    await fixture(`${deny}${layer('')}`, async (page) => {
      const found = await discover(page);
      expect(found.controls).toEqual([]);
      expect(found.diagnostic.rejection_counts.outside_verified_consent_context).toBeGreaterThan(0);
      expect((await census(page)).provider_owned_reject_candidate_count).toBe(0);
    });
  });

  it('UC-BUI-06 rejects both directions of test-ID and label conflict', async () => {
    await fixture(layer('<button data-testid="uc-deny-all-button">Alles akzeptieren</button><button data-testid="uc-accept-all-button">Alles ablehnen</button>'), async (page) => {
      const found = await discover(page);
      expect(found.controls).toEqual([]);
      expect(found.diagnostic.semantic_identity_conflict_count).toBe(2);
      expect((await census(page)).browser_ui_identity_conflict_count).toBe(2);
    });
  });

  it('rejects matching descendant text when its button has a different accessible name', async () => {
    await fixture(layer('<button data-testid="uc-deny-all-button" aria-label="Continue"><span>Alles ablehnen</span></button>'), async (page) => {
      const found = await discover(page);
      expect(found.controls).toEqual([]);
      expect(found.diagnostic.rejection_counts.not_direct_actionable_target).toBe(1);
    });
  });

  it('UC-BUI-07 treats duplicate Reject controls as ambiguous', async () => {
    await fixture(layer(deny + deny), async (page) => {
      expect((await discover(page)).controls.find((item) => item.action === 'reject_all')).toBeUndefined();
      expect(await census(page)).toMatchObject({ usercentrics_surface_topology: 'ambiguous',
        reject_semantic_candidate_count: 2, provider_owned_reject_candidate_count: 0, ownership_reason: 'ambiguous_multiple_controls' });
    });
  });

  it('UC-BUI-08 treats duplicate roots as ambiguous', async () => {
    await fixture('', async (page) => {
      expect((await discover(page)).controls).toEqual([]);
      expect(await census(page)).toMatchObject({ usercentrics_surface_topology: 'ambiguous', browser_ui_root_count: 2,
        provider_owned_surface_count: 0, ownership_reason: 'ambiguous_multiple_roots' });
    }, 2);
  });

  it('UC-BUI-09 treats multiple visible first layers as ambiguous', async () => {
    await fixture(layer(deny) + '<div style="position:fixed;top:260px">' + layer(deny) + '</div>', async (page) => {
      expect((await discover(page)).controls).toEqual([]);
      expect(await census(page)).toMatchObject({ usercentrics_surface_topology: 'ambiguous',
        first_layer_surface_count: 2, ownership_reason: 'ambiguous_multiple_first_layers' });
    });
  });

  it('ignores a hidden stale first-layer template when one current layer is visible', async () => {
    const hidden = '<div style="display:none">' + layer(deny) + '</div>';
    await fixture(layer(deny) + hidden, async (page) => {
      expect((await discover(page)).controls.map((item) => item.action)).toContain('reject_all');
      expect((await census(page)).usercentrics_surface_topology).toBe('open_shadow_browser_ui');
    });
  });

  it('UC-BUI-10 excludes hidden and disabled controls', async () => {
    for (const control of ['<button data-testid="uc-deny-all-button" hidden>Alles ablehnen</button>', '<button data-testid="uc-deny-all-button" disabled>Alles ablehnen</button>']) {
      await fixture(layer(control), async (page) => {
        expect((await discover(page)).controls.find((item) => item.action === 'reject_all')).toBeUndefined();
        expect((await census(page)).semantic_control_inventory.reject_all.directly_actionable_count).toBe(0);
      });
    }
  });

  it('UC-BUI-11 gates Browser UI discovery on proven provider/runtime context', async () => {
    await fixture(layer(deny), async (page) => {
      expect((await discoverUsercentricsSemanticControls(page)).controls).toEqual([]);
    });
  });

  it('UC-BUI-12 re-discovers immediately before invocation and refuses changed identity', async () => {
    await fixture(layer(deny), async (page) => {
      await page.evaluate(() => { (window as any).activations = 0; document.querySelector('#usercentrics-root')!.shadowRoot!.querySelector('button')!.addEventListener('click', () => (window as any).activations++); });
      const found = await discover(page);
      await page.evaluate(() => { document.querySelector('#usercentrics-root')!.shadowRoot!.querySelector('button')!.textContent = 'Alles akzeptieren'; });
      expect(await found.invoke('usercentrics-semantic:reject_all')).toBe(false);
      expect(await page.evaluate(() => (window as any).activations)).toBe(0);
    });
  });

  it('rechecks root, first layer, uniqueness, and actionability before invocation', async () => {
    for (const mutation of ['duplicate_root', 'wrong_layer', 'outside_layer', 'wrong_test_id', 'disabled', 'hidden', 'duplicate_button']) {
      await fixture(layer(deny), async (page) => {
        await page.evaluate(() => { (window as any).activations = 0; document.querySelector('#usercentrics-root')!.shadowRoot!.querySelector('button')!.addEventListener('click', () => (window as any).activations++); });
        const found = await discover(page);
        await page.evaluate((change) => {
          const host = document.querySelector('#usercentrics-root')!;
          const shadow = host.shadowRoot!;
          const button = shadow.querySelector('button')!;
          const firstLayer = shadow.querySelector('#uc-center-container')!;
          if (change === 'duplicate_root') document.body.appendChild(host.cloneNode(false));
          if (change === 'wrong_layer') firstLayer.setAttribute('data-testid', 'other-layer');
          if (change === 'outside_layer') shadow.appendChild(button);
          if (change === 'wrong_test_id') button.setAttribute('data-testid', 'uc-accept-all-button');
          if (change === 'disabled') button.setAttribute('disabled', '');
          if (change === 'hidden') button.setAttribute('hidden', '');
          if (change === 'duplicate_button') firstLayer.appendChild(button.cloneNode(true));
        }, mutation);
        expect(await found.invoke('usercentrics-semantic:reject_all')).toBe(false);
        expect(await page.evaluate(() => (window as any).activations)).toBe(0);
      });
    }
  });

  it('UC-BUI-13 retains the existing legacy root contract', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<aside id="usercentrics-cmp-ui"></aside>');
      await page.evaluate(() => { document.querySelector('aside')!.attachShadow({ mode: 'open' }).innerHTML = '<button>Alles ablehnen</button>'; });
      expect((await discover(page)).controls.map((item) => item.action)).toContain('reject_all');
      expect((await census(page)).usercentrics_surface_topology).toBe('open_shadow_standard');
    } finally { await page.close(); }
  });
});
