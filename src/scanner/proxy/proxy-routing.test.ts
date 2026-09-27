import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProxyAttemptPlan, initialProxyProvider, nextNonConsentProvider, shouldProbeProxyEgress } from './provider';
import { BrowserlessSessionAccounting } from './session-accounting';
import { finalizeRequestCaptureChannel } from '../audit-runner';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { replayEvidence } from '../quality/replay';

afterEach(() => vi.unstubAllEnvs());

describe('Proxy Routing Optimization V1', () => {
  it.each([
    [['tracking'], 'browserless_direct'],
    [['server_side'], 'browserless_direct'],
    [['tracking', 'server_side'], 'browserless_direct'],
    [['consent'], 'decodo'],
    [['consent', 'tracking'], 'decodo'],
    [['consent', 'tracking', 'server_side'], 'decodo']
  ] as const)('selects %s for %s', (modules, expected) => {
    expect(initialProxyProvider([...modules])).toBe(expected);
  });

  it('keeps a successful direct scan on direct transport and escalates only access failures', () => {
    const provider = initialProxyProvider(['tracking', 'server_side']);
    expect(provider).toBe('browserless_direct');
    expect(nextNonConsentProvider(provider, false)).toBe('browserless_datacenter');
    // The runner calls nextNonConsentProvider only at access/transport failure boundaries.
    expect(nextNonConsentProvider('browserless_datacenter', false)).toBe('decodo');
    expect(nextNonConsentProvider('decodo', false)).toBeNull();
    expect(nextNonConsentProvider('decodo', true)).toBe('browserless_residential');
    expect(nextNonConsentProvider('decodo', true, true)).toBeNull();
    expect(nextNonConsentProvider('browserless_residential', true)).toBeNull();
  });

  it('keeps Consent on Decodo and its configured residential fallback without a direct step', () => {
    const initial = initialProxyProvider(['consent', 'tracking', 'server_side']);
    expect(initial).toBe('decodo');
    expect(nextNonConsentProvider(initial, true)).toBe('browserless_residential');
  });

  it('propagates the configured timeout through direct, Decodo, datacenter, and residential CDP URLs', () => {
    vi.stubEnv('DECODO_PROXY_UK', 'http://opaque-user:opaque-password@uk.decodo.com:10001');
    for (const provider of ['browserless_direct', 'decodo', 'browserless_datacenter', 'browserless_residential'] as const) {
      const plan = buildProxyAttemptPlan({ provider, geo: 'UK', attempt: 0, browserlessHost: 'host.example',
        browserlessToken: 'opaque-token', sessionTimeoutMs: 180_000 });
      const url = new URL(plan.cdpUrl);
      expect(url.searchParams.get('timeout'), provider).toBe('180000');
      expect(url.searchParams.get('proxy'), provider).toBe(provider === 'browserless_datacenter' ? 'datacenter'
        : provider === 'browserless_residential' ? 'residential' : null);
      expect(url.searchParams.has('externalProxyServer'), provider).toBe(provider === 'decodo');
      expect(JSON.stringify({ provider: plan.provider, country: plan.country, port: plan.port })).not.toContain('opaque-token');
    }
  });

  it('skips the geo probe for direct non-Consent scans even in diagnostic mode', () => {
    expect(shouldProbeProxyEgress({ provider: 'browserless_direct', consentSelected: false,
      diagnostic: true, configured: true, neutral: false })).toBe(false);
    expect(shouldProbeProxyEgress({ provider: 'decodo', consentSelected: true,
      diagnostic: false, configured: false, neutral: false })).toBe(true);
  });

  it('accumulates every Browserless session and rounds each one for estimated units', () => {
    const sessions = new BrowserlessSessionAccounting();
    const first = sessions.start(1_000);
    sessions.finish(first, 30_999);
    const second = sessions.start(40_000);
    sessions.finish(second, 70_001);
    const third = sessions.start(80_000);
    sessions.finish(third, 81_000);
    expect(sessions.snapshot()).toEqual({
      browserless_session_ms: 1_000,
      browserless_session_count: 3,
      browserless_session_total_ms: 61_000,
      browserless_session_durations_ms: [29_999, 30_001, 1_000],
      browserless_estimated_time_units: 4
    });
    expect(JSON.stringify(sessions.snapshot())).not.toMatch(/opaque-token|wss:\/\//);
    sessions.finish(third, 82_000);
    expect(sessions.snapshot().browserless_session_count).toBe(3);
  });

  it('accounts for concurrent Browserless experiment sessions separately from the canonical session', () => {
    const sessions = new BrowserlessSessionAccounting();
    const canonical = sessions.start(0);
    const experiment = sessions.start(10_000);
    sessions.finish(experiment, 20_000);
    sessions.finish(canonical, 61_000);
    expect(sessions.snapshot()).toMatchObject({ browserless_session_count: 2,
      browserless_session_total_ms: 71_000, browserless_session_durations_ms: [10_000, 61_000],
      browserless_estimated_time_units: 4 });
  });

  it('records an explicit incomplete-channel reason on disconnect and preserves positive evidence', () => {
    const collector = new EvidenceCollector({ auditId: 'routing-fixture', domain: 'fixture.example', geo: 'UK',
      mode: 'normal', selectedModules: ['tracking', 'server_side'] });
    const evidence = collector.bundle;
    evidence.page.valid = true;
    evidence.network.observation!.request_listener_active = true;
    finalizeRequestCaptureChannel(evidence.network.observation, false, false);
    expect(evidence.network.observation).toMatchObject({ request_capture_completed: false,
      capture_channel_errors: ['BROWSER_DISCONNECTED_BEFORE_FINALIZATION'] });
    const replayed = replayEvidence(collector.complete(Date.now()));
    expect(replayed.consent_status).toBe('not_tested');
    expect(replayed.site_ga4_detected).not.toBe(false);
    expect(replayed.server_side_status).not.toBe('not_detected');
  });

  it('keeps positive Tracking and Server evidence across a transport replacement', () => {
    const collector = new EvidenceCollector({ auditId: 'replacement-fixture', domain: 'fixture.example', geo: 'UK',
      mode: 'normal', selectedModules: ['tracking', 'server_side'] });
    collector.setPage({ valid: true, accessCategory: 'none', finalUrl: 'https://fixture.example/' });
    collector.bundle.server_side.executed = true;
    collector.captureRequest({ url: 'https://fixture.example/g/collect?v=2&tid=G-FIXTURE&en=page_view',
      phase: 'consent_initial_load', observed_page_url: 'https://fixture.example/' });
    collector.recordAccessProxyAttempt({ provider: 'browserless_direct', geo: 'UK', port: null, attempt: 1,
      connect_duration_ms: 10, egress_result: 'not_tested', neutral_https_result: 'not_tested',
      target_result: 'failed', failure_classification: 'BROWSER_CONNECTION_FAILED' });
    collector.recordAccessProxyAttempt({ provider: 'browserless_datacenter', geo: 'UK', port: null, attempt: 2,
      connect_duration_ms: 10, egress_result: 'not_tested', neutral_https_result: 'not_tested',
      target_result: 'valid_storefront', failure_classification: null });
    finalizeRequestCaptureChannel(collector.bundle.network.observation, false, false);
    const replayed = replayEvidence(collector.complete(Date.now()));
    expect(replayed.site_ga4_detected).toBe(true);
    expect(replayed.server_side_status).toBe('first_party_collection_detected');
  });
});
