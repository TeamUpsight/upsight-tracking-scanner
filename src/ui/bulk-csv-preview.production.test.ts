import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let browser: Browser;
let server: Server;
let page: Page;
let root: string;
const fullHeader = 'domain,region,exact_country,mode,group_label,modules';
const allFields = ['Audit geo', 'Exact country', 'Scan mode', 'Group label'];

beforeAll(async () => {
  const bundled = await build({
    stdin: { contents: "import React from 'react'; import { createRoot } from 'react-dom/client'; import App from './src/App'; createRoot(document.getElementById('root')).render(React.createElement(App));", resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }
  });
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/app.js' ? bundled.outputFiles[0].text : '<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  root = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, headless: true });
}, 30_000);

beforeEach(async () => {
  page = await browser.newPage();
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: {
    items: [], pagination: { page: 1, page_size: 25, total: 0, total_pages: 0, has_next: false, has_previous: false }
  } }));
  await page.goto(root);
  await page.getByRole('button', { name: 'Run audit', exact: true }).waitFor();
});
afterEach(async () => { await page.close(); });
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function selectCsv(csv: string, name = 'fixture.csv') {
  await page.getByRole('button', { name: 'Bulk CSV', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
}
async function settlePreview() {
  await page.waitForFunction(() => {
    const text = document.querySelector('[role="status"]')?.textContent;
    return text && !text.includes('Reading CSV');
  });
}
async function controlState() {
  return page.evaluate(() => ({
    region: (document.querySelector('[aria-label="Audit geo"]') as HTMLSelectElement).value,
    mode: (document.querySelector('[aria-label="Scan mode"]') as HTMLSelectElement).value,
    group: (document.querySelector('[aria-label="Group label"]') as HTMLInputElement).value,
    country: (document.querySelector('[aria-label="Exact country"]') as HTMLSelectElement)?.value,
    modules: Array.from(document.querySelectorAll('fieldset input')).map((input: HTMLInputElement) => input.checked)
  }));
}
async function captureBulkSubmission() {
  await page.route('**/api/v1/scan/bulk', (route) => route.fulfill({ json: { count: 1, duplicates_removed: 0, audits: [] }, status: 202 }));
  await page.evaluate(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith('/api/v1/scan/bulk')) {
        (window as any).submittedFallbacks = Object.fromEntries(Array.from((init.body as FormData).entries()).filter(([key]) => key !== 'file'));
      }
      return original(input, init);
    };
  });
  await page.getByRole('button', { name: 'Run audit', exact: true }).click();
  await page.waitForFunction(() => Boolean((window as any).submittedFallbacks));
  return page.evaluate(() => (window as any).submittedFallbacks);
}

describe('bulk CSV ownership in the actual React audit form (mocked API)', () => {
  it('disables only CSV-controlled fields with visible and accessible reasons', async () => {
    await selectCsv(`${fullHeader}\nexample.com,EU,DE,diagnostic,canary,consent`);
    await settlePreview();
    expect(await page.getByRole('status').textContent()).toBe('CSV overrides detected: Region, Exact Country, Mode, Group Label, Modules');
    for (const label of allFields) {
      const control = page.getByLabel(label, { exact: true });
      expect(await control.isDisabled()).toBe(true);
      expect(await control.getAttribute('title')).toMatch(/Blank CSV values use the current fallback value/);
      const describedBy = await control.getAttribute('aria-describedby');
      expect(await page.locator(`[id="${describedBy}"]`).textContent()).toMatch(/Configured per row/);
    }
    expect(await page.getByText('CSV override', { exact: true }).count()).toBe(5);
    expect(await controlState()).toEqual({ region: 'USA', mode: 'normal', group: '', country: '', modules: [true, true, true] });
    expect(await page.locator('fieldset').getAttribute('disabled')).not.toBeNull();
    for (const checkbox of await page.locator('fieldset input').all()) expect(await checkbox.isDisabled()).toBe(true);
  });
  it('shows an editable exact-country fallback for partial CSV region/modules ownership', async () => {
    await selectCsv('domain,region,modules\nexample.com,EU,consent');
    await settlePreview();
    expect(await page.getByRole('status').textContent()).toBe('CSV overrides detected: Region, Modules');
    expect(await page.getByLabel('Audit geo', { exact: true }).isDisabled()).toBe(true);
    for (const label of ['Exact country', 'Scan mode', 'Group label']) expect(await page.getByLabel(label, { exact: true }).isEnabled()).toBe(true);
    await page.getByLabel('Exact country', { exact: true }).selectOption('GB');
    expect((await captureBulkSubmission()).tested_country).toBe('GB');
  });
  it('preserves all disabled fallback states and sends them without extra preview metadata', async () => {
    await page.getByLabel('Audit geo', { exact: true }).selectOption('EU');
    await page.getByLabel('Exact country', { exact: true }).selectOption('DE');
    await page.getByLabel('Scan mode', { exact: true }).selectOption('diagnostic');
    await page.getByLabel('Group label', { exact: true }).fill('default-group');
    await page.getByRole('checkbox', { name: 'Server-side', exact: true }).uncheck();
    const before = await controlState();
    await selectCsv(`${fullHeader}\nexample.com,,,,,`);
    await settlePreview();
    expect(await controlState()).toEqual(before);
    expect(await captureBulkSubmission()).toEqual({
      tested_geos: 'EU', tested_country: 'DE', mode: 'diagnostic', group_label: 'default-group', selected_modules: '["consent","tracking"]'
    });
  });
  it('does not drop an existing country when CSV owns region/modules while the UI would normally hide it', async () => {
    await page.getByLabel('Audit geo', { exact: true }).selectOption('EU');
    await page.getByLabel('Exact country', { exact: true }).selectOption('DE');
    await page.getByLabel('Audit geo', { exact: true }).selectOption('USA');
    await page.getByRole('checkbox', { name: 'Consent', exact: true }).uncheck();
    await selectCsv('domain,region,exact_country,modules\nexample.com,EU,DE,consent');
    await settlePreview();
    expect(await page.getByLabel('Exact country', { exact: true }).isDisabled()).toBe(true);
    expect(await page.getByLabel('Exact country', { exact: true }).inputValue()).toBe('DE');
    const submitted = await captureBulkSubmission();
    expect(submitted).toMatchObject({ tested_geos: 'USA', tested_country: 'DE', selected_modules: '["tracking","server_side"]' });
  });
  it('clears ownership on replacement and removal while keeping fallback values', async () => {
    await selectCsv(`${fullHeader}\nexample.com,,,,,`);
    await settlePreview();
    await selectCsv('domain,mode\nexample.com,diagnostic', 'replacement.csv');
    await settlePreview();
    expect(await page.getByLabel('Audit geo', { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByLabel('Group label', { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByLabel('Scan mode', { exact: true }).isDisabled()).toBe(true);
    for (const checkbox of await page.locator('fieldset input').all()) expect(await checkbox.isEnabled()).toBe(true);
    await page.getByRole('button', { name: 'Remove CSV file' }).click();
    expect(await page.getByLabel('Scan mode', { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByText('CSV override', { exact: true }).count()).toBe(0);
    expect(await page.getByRole('button', { name: 'Run audit', exact: true }).isDisabled()).toBe(true);
  });
  it('keeps Single Audit behavior and restores the same CSV ownership when returning to Bulk', async () => {
    await selectCsv(`${fullHeader}\nexample.com,EU,DE,normal,row,consent`);
    await settlePreview();
    await page.getByRole('button', { name: 'Single', exact: true }).click();
    for (const label of ['Audit geo', 'Scan mode', 'Group label']) expect(await page.getByLabel(label, { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByLabel('Exact country', { exact: true }).count()).toBe(0);
    for (const checkbox of await page.locator('fieldset input').all()) expect(await checkbox.isEnabled()).toBe(true);
    await page.getByLabel('Audit geo', { exact: true }).selectOption('EU');
    expect(await page.getByLabel('Exact country', { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByLabel('Exact country', { exact: true }).locator('option[value="US"]').count()).toBe(0);
    await page.getByRole('checkbox', { name: 'Consent', exact: true }).uncheck();
    expect(await page.getByLabel('Exact country', { exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Bulk CSV', exact: true }).click();
    for (const label of allFields) expect(await page.getByLabel(label, { exact: true }).isDisabled()).toBe(true);
  });
  it('keeps domain-only controls editable and available guidance compact', async () => {
    await selectCsv('domain\nexample.com');
    await settlePreview();
    expect(await page.getByRole('status').textContent()).toMatch(/No CSV configuration overrides detected/);
    for (const label of ['Audit geo', 'Scan mode', 'Group label']) expect(await page.getByLabel(label, { exact: true }).isEnabled()).toBe(true);
    expect(await page.locator('details').filter({ has: page.getByText('CSV columns and example', { exact: true }) }).getAttribute('open')).toBeNull();
    await page.getByText('CSV columns and example', { exact: true }).click();
    expect(await page.locator('details pre').textContent()).toContain('"consent,tracking,serverside"');
  });
  it('preserves legacy omission of a hidden country for a domain-only bulk request', async () => {
    await page.getByLabel('Audit geo', { exact: true }).selectOption('EU');
    await page.getByLabel('Exact country', { exact: true }).selectOption('DE');
    await page.getByLabel('Audit geo', { exact: true }).selectOption('USA');
    await selectCsv('domain\nexample.com');
    await settlePreview();
    expect(await page.getByLabel('Exact country', { exact: true }).count()).toBe(0);
    expect((await captureBulkSubmission()).tested_country).toBe('');
  });
  it('leaves malformed previews editable and still allows authoritative API submission', async () => {
    await selectCsv('domain,"mode\nexample.com,normal');
    await settlePreview();
    expect(await page.getByRole('status').textContent()).toMatch(/could not be previewed/);
    for (const label of ['Audit geo', 'Scan mode', 'Group label']) expect(await page.getByLabel(label, { exact: true }).isEnabled()).toBe(true);
    expect(await captureBulkSubmission()).toMatchObject({ tested_geos: 'USA', mode: 'normal' });
  });
  it('defers module validation to the API when CSV owns modules and the preserved fallback is empty', async () => {
    for (const checkbox of await page.locator('fieldset input').all()) await checkbox.uncheck();
    await selectCsv('domain,modules\nexample.com,consent');
    await settlePreview();
    for (const checkbox of await page.locator('fieldset input').all()) {
      expect(await checkbox.isDisabled()).toBe(true);
      expect(await checkbox.isChecked()).toBe(false);
    }
    expect((await captureBulkSubmission()).selected_modules).toBe('[]');
  });
  it('ignores stale file reads after replacement or removal', async () => {
    await page.evaluate(() => {
      const slice = File.prototype.slice;
      File.prototype.slice = function (...args) {
        const blob = slice.apply(this, args);
        if (this.name === 'slow.csv') {
          const read = blob.arrayBuffer.bind(blob);
          blob.arrayBuffer = () => new Promise<ArrayBuffer>((resolve) => { (window as any).releaseSlowRead = () => read().then(resolve); });
        }
        return blob;
      };
    });
    await selectCsv(`${fullHeader}\nexample.com,,,,,`, 'slow.csv');
    await page.waitForFunction(() => Boolean((window as any).releaseSlowRead));
    await selectCsv('domain,region\nexample.com,EU', 'fast.csv');
    await settlePreview();
    await page.evaluate(() => (window as any).releaseSlowRead());
    expect(await page.getByRole('status').textContent()).toBe('CSV overrides detected: Region');
    expect(await page.getByLabel('Scan mode', { exact: true }).isEnabled()).toBe(true);
    await page.evaluate(() => { (window as any).releaseSlowRead = undefined; });
    await selectCsv(`${fullHeader}\nexample.com,,,,,`, 'slow.csv');
    await page.waitForFunction(() => Boolean((window as any).releaseSlowRead));
    await page.getByRole('button', { name: 'Remove CSV file' }).click();
    await page.evaluate(() => (window as any).releaseSlowRead());
    expect(await page.getByLabel('Audit geo', { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByLabel('Scan mode', { exact: true }).isEnabled()).toBe(true);
    expect(await page.getByText('CSV override', { exact: true }).count()).toBe(0);
  });
  it('handles a failed file read without disabling controls', async () => {
    await page.evaluate(() => { Blob.prototype.arrayBuffer = () => Promise.reject(new Error('fixture read failure')); });
    await selectCsv(`${fullHeader}\nexample.com,,,,,`);
    await settlePreview();
    expect(await page.getByRole('status').textContent()).toMatch(/could not be previewed/);
    for (const label of ['Audit geo', 'Scan mode', 'Group label']) expect(await page.getByLabel(label, { exact: true }).isEnabled()).toBe(true);
  });
});
