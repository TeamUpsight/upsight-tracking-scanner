import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AuditModule, EvidenceBundle, StorefrontAudit, TrackingRequestEvidence } from '../../types';
import { EvidenceCollector } from '../evidence/evidence-collector';
import { replayEvidence } from './replay';
import { resolveOverallStatus } from '../resolver/status-resolver';
import { classifyCollection } from '../server-side/classify-collection';

const canonicalFields = [
  'consent_status', 'cmp_provider', 'product_payload_status', 'server_side_status', 'ss_collection_type',
  'site_ga4_detected', 'site_ga4_collection_hit_detected', 'site_meta_detected',
  'site_meta_collection_hit_detected', 'overall_status', 'overall_confidence', 'finding_confidence',
  'reason_codes', 'decision_summary'
] as const;

const request = (collector: TrackingRequestEvidence['collector'] = 'third_party', event = 'page_view', timestamp = 1): TrackingRequestEvidence => ({
  vendor: 'ga4', kind: 'collection', collector, host: collector === 'third_party' ? 'www.google-analytics.com' : 'collect.example.com',
  path: '/g/collect', method: 'GET', phase: 'product_pdp_load', timestamp, event, measurement_id: 'G-TEST',
  page_url: 'https://example.com/products/one', ...(event === 'view_item' ? { has_product: true, product_id: 'sku-1' } : {})
});

function bundle(selected_modules: AuditModule[] = ['consent', 'tracking', 'server_side']): EvidenceBundle {
  const evidence = new EvidenceCollector({ auditId: 'ln06', domain: 'example.com', geo: 'USA', selectedModules: selected_modules, startedAt: '2026-09-26T00:00:00.000Z' }).bundle;
  evidence.page.valid = true;
  evidence.page.status_code = 200;
  evidence.access.valid_storefront = true;
  evidence.access.http_status = 200;
  evidence.runtime.proxy_country_verified = true;
  Object.assign(evidence.network.observation!, {
    request_listener_active: true, request_capture_completed: true, data_layer_capture_completed: true, performance_capture_completed: true
  });
  evidence.product.observation!.minimum_observation_satisfied = true;
  evidence.product.applicability = 'applicable';
  evidence.server_side.passive_classification_completed = true;
  evidence.consent.executed = selected_modules.includes('consent');
  evidence.product.executed = selected_modules.includes('tracking');
  evidence.server_side.executed = selected_modules.includes('server_side');
  return evidence;
}

function pdp(e: EvidenceBundle) {
  e.product.pdp_url = 'https://example.com/products/one';
  e.product.final_pdp_url = e.product.pdp_url;
  e.product.pdp_candidates = [e.product.pdp_url];
  e.product.navigation_succeeded = true;
}

function add(e: EvidenceBundle, hit: TrackingRequestEvidence) {
  e.network.relevant_requests.push(hit);
  if (hit.event === 'view_item') e.product.ga4_view_item_hits.push(hit);
}

function assertCanonicalConsistency(result: Partial<StorefrontAudit>) {
  const decisions = new Map(result.evidence_bundle?.decision_summary?.map((entry) => [entry.decision_name, entry]));
  const statuses = [
    ['consent', result.consent_status, result.finding_confidence?.consent?.status],
    ['product_payload', result.product_payload_status, result.finding_confidence?.product?.status],
    ['server_side', result.server_side_status, result.finding_confidence?.server_side?.status],
    ['ga4', result.site_ga4_detected, result.finding_confidence?.ga4?.detected],
    ['meta', result.site_meta_detected, result.finding_confidence?.meta?.detected],
    ['cmp', result.cmp_provider, undefined]
  ] as const;
  for (const [name, status, finding] of statuses) {
    expect(decisions.get(name)?.status, name).toBe(status ?? null);
    if (finding !== undefined) expect(finding, name).toBe(status);
  }
  for (const [name, finding] of Object.entries(result.finding_confidence || {})) {
    const module = ['cmp', 'consent'].includes(name) ? 'consent' : ['ga4', 'meta', 'product'].includes(name) ? 'tracking' : 'server_side';
    if (result.selected_modules?.includes(module as AuditModule)) expect(result.reason_codes).toContain(finding.reason_code);
    else expect(result.reason_codes).not.toContain(finding.reason_code);
  }
  expect(result.overall_status).toBe(resolveOverallStatus({
    consent_status: result.consent_status ?? null, product_status: result.product_payload_status ?? null,
    server_status: result.server_side_status ?? null, collection_type: result.ss_collection_type ?? null,
    error_category: result.error_category || 'none', selected_modules: result.selected_modules
  }).status);
  if (result.overall_status === 'pass') {
    for (const module of result.selected_modules || []) {
      const status = module === 'consent' ? result.consent_status : module === 'tracking' ? result.product_payload_status : result.server_side_status;
      expect(status).not.toBe('inconclusive');
      expect(status).not.toBe('not_tested');
    }
  }
  if (result.server_side_status === 'not_detected') expect(result.ss_collection_type).not.toBe('inconclusive');
  if (result.product_payload_status === 'pass') expect(result.finding_confidence?.product?.reason_code).toBe('GA4_VIEW_ITEM_VALID');
}

type Case = { name: string; selected: AuditModule[]; change: (e: EvidenceBundle) => void; expected: Partial<StorefrontAudit> };
const cases: Case[] = [
  { name: 'valid clean positive tracking', selected: ['tracking'], change: (e) => { pdp(e); add(e, request('third_party', 'view_item')); }, expected: { product_payload_status: 'pass', site_ga4_collection_hit_detected: true } },
  { name: 'dataLayer-only product event', selected: ['tracking'], change: (e) => { pdp(e); e.product.data_layer_view_item_hits = [{ ...request('third_party', 'view_item'), kind: 'data_layer' }]; }, expected: { product_payload_status: 'ga4_not_detected', site_ga4_collection_hit_detected: false } },
  { name: 'complete GA4 negative', selected: ['tracking'], change: pdp, expected: { product_payload_status: 'ga4_not_detected', site_ga4_detected: false } },
  { name: 'gated Tracking negative', selected: ['tracking'], change: (e) => { pdp(e); e.consent.tracking_enablement = 'inconclusive'; }, expected: { product_payload_status: 'inconclusive', site_ga4_detected: null } },
  { name: 'sold-out valid PDP', selected: ['tracking'], change: (e) => { pdp(e); add(e, request('third_party', 'view_item')); }, expected: { product_payload_status: 'pass' } },
  { name: 'consent violation', selected: ['consent'], change: (e) => { e.geo = 'EU'; e.consent.resolved_provider = 'Cookiebot'; e.consent.pre_choice_measurement = 'full_measurement'; }, expected: { consent_status: 'prior_consent_violation', overall_status: 'fail' } },
  { name: 'consent interaction inconclusive', selected: ['consent'], change: (e) => { e.geo = 'EU'; e.consent.resolved_provider = 'Cookiebot'; e.consent.interaction_attempted = true; }, expected: { consent_status: 'inconclusive' } },
  { name: 'third-party-only Server collection', selected: ['server_side'], change: (e) => add(e, request()), expected: { server_side_status: 'not_detected', ss_collection_type: 'third_party' } },
  { name: 'first-party Server collection', selected: ['server_side'], change: (e) => add(e, request('first_party')), expected: { server_side_status: 'first_party_collection_detected' } },
  { name: 'mixed duplicate Server collection', selected: ['server_side'], change: (e) => { add(e, request('first_party')); add(e, request('third_party', 'page_view', 2)); }, expected: { server_side_status: 'first_party_collection_detected', ss_collection_type: 'mixed' } },
  { name: 'generic first-party Server candidate', selected: ['server_side'], change: (e) => { e.server_side.measurement_candidates = [{ host: 'collect.example.com', path: '/event', origin: 'https://collect.example.com', method: 'POST', relationship: 'first_party', strength: 'strong', provider_hint: 'unknown', semantic_groups: ['event', 'identity', 'page'], evidence_codes: ['EVENT_NAME'], phase: 'homepage', timestamp: 1 }]; }, expected: { server_side_status: 'first_party_collection_detected' } },
  { name: 'ambiguous generic Server candidate', selected: ['server_side'], change: (e) => { e.server_side.measurement_candidates = [{ host: 'collect.example.com', path: '/event', origin: 'https://collect.example.com', method: 'POST', relationship: 'first_party', strength: 'medium', provider_hint: 'unknown', semantic_groups: ['event', 'page'], evidence_codes: ['EVENT_NAME'], phase: 'homepage', timestamp: 1 }]; }, expected: { server_side_status: 'inconclusive' } },
  { name: 'candidate truncation', selected: ['server_side'], change: (e) => { e.server_side.candidate_truncated = true; }, expected: { server_side_status: 'inconclusive' } },
  { name: 'relevant-request truncation', selected: ['tracking', 'server_side'], change: (e) => { pdp(e); e.network.relevant_requests_truncated = true; }, expected: { site_ga4_detected: null, server_side_status: 'inconclusive' } },
  { name: 'incomplete request capture', selected: ['tracking', 'server_side'], change: (e) => { pdp(e); e.network.observation!.request_capture_completed = false; }, expected: { site_ga4_detected: null, server_side_status: 'inconclusive' } },
  { name: 'blocked storefront', selected: ['consent', 'tracking', 'server_side'], change: (e) => { e.page.valid = false; e.access.valid_storefront = false; e.page.access_category = 'access_blocked'; }, expected: { scan_status: 'failed', overall_status: 'inconclusive', site_ga4_detected: null } },
  { name: 'navigation timeout', selected: ['tracking'], change: (e) => { e.page.valid = false; e.access.valid_storefront = false; e.page.access_category = 'navigation_timeout'; }, expected: { scan_status: 'failed', overall_status: 'inconclusive' } },
  { name: 'module-scoped audit', selected: ['tracking'], change: (e) => { pdp(e); add(e, request('third_party', 'view_item')); e.consent.resolved_provider = 'Cookiebot'; e.server_side.candidate_truncated = true; }, expected: { consent_status: 'not_tested', product_payload_status: 'pass', server_side_status: 'not_tested', overall_status: 'pass' } }
];

describe('LN-06 canonical launch matrix', () => {
  it.each(cases)('$name: replay is deterministic, immutable and internally consistent', ({ selected, change, expected }) => {
    const source = bundle(selected);
    change(source);
    const before = structuredClone(source);
    const first = replayEvidence(source);
    const second = replayEvidence(source);
    expect(first).toMatchObject(expected);
    for (const field of canonicalFields) {
      const value = field === 'decision_summary' ? first.evidence_bundle?.decision_summary : first[field];
      const repeated = field === 'decision_summary' ? second.evidence_bundle?.decision_summary : second[field];
      expect(repeated, field).toEqual(value);
    }
    expect(source).toEqual(before);
    assertCanonicalConsistency(first);
  });

  it.each(([['consent'], ['tracking'], ['server_side'], ['consent', 'tracking'], ['tracking', 'server_side'], ['consent', 'server_side'], ['consent', 'tracking', 'server_side']] as AuditModule[][]).map((selected) => ({ selected })))('unselected evidence cannot affect $selected', ({ selected }) => {
    const source = bundle(selected);
    const before = replayEvidence(source);
    if (!selected.includes('server_side') && !selected.includes('tracking')) source.network.relevant_requests.push(request('first_party'));
    if (!selected.includes('consent')) {
      source.consent.resolved_provider = 'Cookiebot';
      source.consent.pre_choice_measurement = 'full_measurement';
    }
    if (!selected.includes('tracking')) source.product.data_layer_view_item_hits = [{ ...request('third_party', 'view_item'), kind: 'data_layer' }];
    const after = replayEvidence(source);
    for (const module of ['consent', 'tracking', 'server_side'] as const) {
      if (selected.includes(module)) continue;
      const field = module === 'consent' ? 'consent_status' : module === 'tracking' ? 'product_payload_status' : 'server_side_status';
      expect(after[field]).toBe('not_tested');
      const decisions = after.evidence_bundle?.decision_summary?.filter((entry) => module === 'tracking' ? ['ga4', 'meta', 'product_payload'].includes(entry.decision_name) : module === 'consent' ? ['consent', 'cmp'].includes(entry.decision_name) : entry.decision_name === 'server_side');
      expect(decisions?.every((entry) => entry.observation_complete === null), JSON.stringify({ selected, module, decisions })).toBe(true);
      expect(decisions?.every((entry) => entry.evidence_codes.length === 0 && entry.blocking_uncertainty.length === 0)).toBe(true);
    }
    expect(after.overall_status).toBe(before.overall_status);
    assertCanonicalConsistency(after);
  });

  it.each([
    ['prior_consent_violation', 'inconclusive', 'not_tested'],
    ['consent_leakage', 'inconclusive', 'not_tested'],
    ['not_tested', 'missing_view_item', 'inconclusive'],
    ['not_tested', 'incomplete_view_item', 'inconclusive']
  ] as const)('preserves definitive failure with unrelated uncertainty: %s / %s / %s', (consent, product, server) => {
    expect(resolveOverallStatus({ consent_status: consent, product_status: product, server_status: server, collection_type: 'inconclusive', error_category: 'none', selected_modules: ['consent', 'tracking', 'server_side'] }))
      .toEqual({ status: 'fail', confidence: 'high' });
  });

  it('distinguishes unselected from selected but untestable', () => {
    const input = { consent_status: 'pass' as const, product_status: 'not_tested' as const, server_status: 'not_tested' as const, collection_type: 'not_tested' as const, error_category: 'none' };
    expect(resolveOverallStatus({ ...input, selected_modules: ['consent'] }).status).toBe('pass');
    expect(resolveOverallStatus({ ...input, selected_modules: ['consent', 'tracking'] }).status).toBe('inconclusive');
  });

  it.each(['rate_limited', 'access_blocked', 'bot_protection', 'proxy_error', 'navigation_timeout', 'scan_timeout', 'cancelled'] as const)('suppresses absence on %s', (category) => {
    const source = bundle();
    source.page.valid = false;
    source.access.valid_storefront = false;
    source.page.access_category = category;
    const result = replayEvidence(source);
    expect(result.scan_status).toBe(category === 'cancelled' ? 'cancelled' : 'failed');
    expect(result.error_category).toBe(category);
    expect(result.overall_status).toBe('inconclusive');
    expect(result.overall_confidence).toBe('low');
    expect(result.consent_status).not.toBe('not_detected');
    expect(result.product_payload_status).not.toBe('missing_view_item');
    expect(result.server_side_status).not.toBe('not_detected');
    expect(result.site_ga4_detected).toBeNull();
    expect(result.site_meta_detected).toBeNull();
    assertCanonicalConsistency(result);
  });

  it('preserves observed product and collection positives after later candidate failure and request truncation', () => {
    const source = bundle(['tracking', 'server_side']);
    pdp(source);
    source.product.candidate_outcomes = [
      { url: source.product.pdp_url!, final_url: source.product.pdp_url, semantic_result: 'VALID_PRODUCT', page_role: 'PDP', navigation_complete: true, observation_complete: true, outcome: 'VALID_PRODUCT_WITH_VIEW_ITEM' },
      { url: 'https://example.com/products/two', navigation_complete: false, observation_complete: false, outcome: 'TIMEOUT' }
    ];
    source.product.navigation_succeeded = false;
    add(source, request('first_party', 'view_item'));
    source.network.relevant_requests_truncated = true;
    expect(replayEvidence(source)).toMatchObject({ product_payload_status: 'pass', site_ga4_collection_hit_detected: true, server_side_status: 'first_party_collection_detected' });
  });

  it('keeps GA4 and Meta collection facts after capture interruption while withholding negatives', () => {
    const source = bundle(['tracking']);
    pdp(source);
    add(source, request('third_party', 'page_view'));
    source.network.relevant_requests.push({ ...request('third_party', 'ViewContent'), vendor: 'meta', pixel_id: '123', measurement_id: undefined });
    source.network.observation!.request_capture_completed = false;
    source.product.observation!.transport_failure = true;
    const result = replayEvidence(source);
    expect(result).toMatchObject({ site_ga4_detected: true, site_ga4_collection_hit_detected: true, site_meta_detected: true, site_meta_collection_hit_detected: true, product_payload_status: 'inconclusive' });
  });

  it('keeps pre-choice full-measurement violation after failed Reject verification', () => {
    const source = bundle(['consent']);
    source.geo = 'EU';
    source.consent.resolved_provider = 'Cookiebot';
    source.consent.pre_choice_measurement = 'full_measurement';
    source.consent.interaction_attempted = true;
    source.consent.rejection_verified = false;
    expect(replayEvidence(source)).toMatchObject({ consent_status: 'prior_consent_violation', overall_status: 'fail' });
  });

  it('requires complete PDP candidates for a missing view_item conclusion', () => {
    const source = bundle(['tracking']);
    pdp(source);
    add(source, request('third_party', 'page_view'));
    source.product.candidate_outcomes = [{ url: source.product.pdp_url!, semantic_result: 'VALID_PRODUCT', page_role: 'PDP', navigation_complete: true, observation_complete: false, outcome: 'OBSERVATION_INCOMPLETE' }];
    expect(replayEvidence(source).product_payload_status).toBe('inconclusive');
  });

  it('keeps live finalization tied to the canonical replay function', () => {
    const runner = readFileSync(new URL('../audit-runner.ts', import.meta.url), 'utf8');
    const finalizer = runner.slice(runner.indexOf('const finalizeScanOnce ='), runner.indexOf('const attachContextObservers ='));
    expect(finalizer).toContain('const replayed = replayEvidence(completedEvidence);');
    expect(finalizer).toContain('...replayed,');
    expect(finalizer).not.toMatch(/resolveOverallStatus\(|resolveProductPayloadStatus\(|classifyCollection\(/);
  });

  it('caps all new Server positives below unobservable legacy assertions', () => {
    const baseline = { executed: true, page_valid: true, observation_complete: true, requests: [request('first_party')] };
    for (const requests of [baseline.requests, Array.from({ length: 10 }, (_, i) => request('first_party', 'page_view', i + 1)), [request('first_party'), request('third_party', 'page_view', 2)]]) {
      for (const cookie of [false, true]) {
        const result = classifyCollection({ ...baseline, requests, collector_cookie_detected: cookie, collector_cookie_persisted: cookie });
        expect(result.status).toBe('first_party_collection_detected');
        expect(['likely_server_side', 'strong_server_side_evidence', 'partial_or_misconfigured']).not.toContain(result.status);
      }
    }
  });

  it('guards against Server-specific active runtime operations', () => {
    const runner = readFileSync(new URL('../audit-runner.ts', import.meta.url), 'utf8');
    const serverBlock = runner.slice(runner.indexOf('const serverStarted = Date.now();'), runner.indexOf('evidence.runtime.module_durations_ms.server_side =', runner.indexOf('const serverStarted = Date.now();')));
    expect(serverBlock).not.toMatch(/\.reload\(|\.goto\(|waitForTimeout\(|newContext\(|\bfetch\(|\bsetTimeout\(/);
    expect(serverBlock).toContain('classifyCollection(');
  });
});
