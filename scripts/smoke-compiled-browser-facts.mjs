import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { captureBrowserConsentFacts, captureUsercentricsMainFrameCensus, discoverUsercentricsSemanticControls, buildMetadata } = require(resolve(root, 'dist/browser-facts-smoke.cjs'));
assert.equal(buildMetadata.scanner_execution_mode, 'compiled_bundle');
assert.match(buildMetadata.build_commit || '', /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i);
if (!buildMetadata.build_dirty) assert.equal(buildMetadata.certification_eligible, true);

// The production server uses the same esbuild options and browser callback source.
// This check is diagnostic; the actual Playwright boundary below is decisive.
const serverBundle = readFileSync(resolve(root, 'dist/server.cjs'), 'utf8');
const smokeBundle = readFileSync(resolve(root, 'dist/browser-facts-smoke.cjs'), 'utf8');
for (const [label, bundle] of [['server', serverBundle], ['smoke', smokeBundle]]) {
  assert.ok(bundle.includes('generic_surface_enumeration'), `${label} bundle must contain browser facts`);
  assert.ok(!/__name\s*\(/.test(bundle), `${label} bundle leaks TSX named-function helper`);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<div role="dialog" style="position:fixed;width:320px;height:120px">Cookie consent <button>Accept all</button><button>Reject all</button></div>');
  const facts = await captureBrowserConsentFacts(page);
  assert.ok(facts.generic.surfaces.some((surface) => surface.visible && surface.privacy_or_cookie_semantics));
  assert.ok(facts.generic.controls.some((control) => control.accessible_name === 'Reject all'));
  const census = await captureUsercentricsMainFrameCensus(page, facts, true);
  assert.equal(census.usercentrics_surface_topology, 'main_frame_unowned');
  assert.equal(census.reject_semantic_candidate_count, 1);
  assert.equal(census.provider_owned_reject_candidate_count, 0);
  await page.setContent('<div id="usercentrics-root" style="position:absolute;width:0;height:0"></div>');
  await page.evaluate(() => {
    document.querySelector('#usercentrics-root').attachShadow({ mode: 'open' }).innerHTML =
      '<div id="uc-center-container" role="dialog" aria-modal="true" data-testid="uc-tcf-first-layer" style="position:fixed;top:20px;left:20px;width:420px;height:220px"><button data-testid="uc-deny-all-button">Alles ablehnen</button></div>';
  });
  const browserUiFacts = await captureBrowserConsentFacts(page);
  const browserUiCensus = await captureUsercentricsMainFrameCensus(page, browserUiFacts, true);
  assert.equal(browserUiCensus.usercentrics_surface_topology, 'open_shadow_browser_ui');
  const discovered = await discoverUsercentricsSemanticControls(page, { browserUiEligible: true });
  assert.ok(discovered.controls.some((control) => control.action === 'reject_all'));
  console.log('Compiled browser facts smoke passed: generic facts and Browser UI ownership callbacks completed across page.evaluate.');
} finally {
  await browser.close();
}
