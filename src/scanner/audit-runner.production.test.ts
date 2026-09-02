import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStorefrontAudit } from './audit-runner';

const resolvedFixtureHost = async () => ({ status: 'resolved' as const, sources: { fixture: 'resolved' as const } });

async function fixtureServer(status: number, html: string) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Full-runner fixture server did not expose a TCP port.');
  return { server, url: `http://fixture.example:${address.port}/` };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function auditFixture(status: number, html: string, consentV2Enabled = true) {
  vi.stubEnv('BROWSER_PROVIDER', 'local');
  vi.stubEnv('CONSENT_V2_ENABLED', consentV2Enabled ? 'true' : 'false');
  const fixture = await fixtureServer(status, html);
  const updates: Array<Record<string, unknown>> = [];
  try {
    await runStorefrontAudit({
      audit_id: `runner-${status}-${consentV2Enabled}`,
      domain: 'fixture.example',
      tested_geos: 'EU',
      selected_modules: ['consent']
    }, async (update) => { updates.push(update as Record<string, unknown>); }, {
      storefrontUrl: fixture.url,
      resolveHostname: resolvedFixtureHost,
      consentGeoVerified: true,
      launchBrowser: () => chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        args: ['--host-resolver-rules=MAP fixture.example 127.0.0.1'],
        headless: true
      })
    });
  } finally {
    await closeServer(fixture.server);
  }
  return updates.at(-1) || {};
}

afterEach(() => vi.unstubAllEnvs());

describe('runStorefrontAudit production browser wiring', () => {
  const oneTrust = `<script>window.OneTrust={RejectAll(){ window.__rejectCalled = true; }};</script><script src="/otSDKStub.js"></script><div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler">Reject all</button></div>`;

  it('RUNNER-V2-01 finalizes Consent V2 compatibility fields from the real runner', async () => {
    const result = await auditFixture(200, oneTrust);
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'pass', scan_status: 'completed' });
    expect(JSON.parse(String(result.trace_steps))).toEqual(expect.arrayContaining([
      expect.objectContaining({ step: 'cmp_provider_detected' }),
      expect.objectContaining({ step: 'consent_context_started', source: 'consent_v2' }),
      expect.objectContaining({ step: 'scan_finalized' })
    ]));
    expect((result.runtime_metrics as { consent_v2?: { enabled: boolean } }).consent_v2?.enabled).toBe(true);
  }, 30_000);

  it('RUNNER-V2-02 maps pre-choice tracking to the final consent status', async () => {
    const result = await auditFixture(200, `<head><script>new Image().src='https://www.google-analytics.com/g/collect?en=page_view';</script></head>${oneTrust}`);
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', consent_status: 'prior_consent_violation', scan_status: 'completed' });
  }, 30_000);

  it('RUNNER-DISABLED-01 keeps the full runner on the legacy detector without an interaction', async () => {
    const result = await auditFixture(200, oneTrust, false);
    const trace = JSON.parse(String(result.trace_steps));
    expect(result).toMatchObject({ cmp_provider: 'OneTrust', scan_status: 'completed' });
    expect(trace).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'consent_v2_disabled_legacy_fallback' })]));
    expect(trace).not.toEqual(expect.arrayContaining([expect.objectContaining({ source: 'consent_v2' })]));
    expect((result.runtime_metrics as { consent_v2?: unknown }).consent_v2).toBeUndefined();
  }, 30_000);

  it('RUNNER-BLOCKED-01 persists a blocked final state without a no-CMP finding', async () => {
    const result = await auditFixture(451, '<title>Access blocked</title><body>challenge/access blocked fixture</body>');
    expect(result).toMatchObject({ scan_status: 'failed', overall_status: 'inconclusive' });
    expect(result.cmp_provider).not.toBe('Not Found');
    expect(result.consent_status).not.toBe('not_detected');
    expect(JSON.parse(String(result.trace_steps))).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'page_validity_failed' })]));
  }, 30_000);
});
