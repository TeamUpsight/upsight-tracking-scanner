import type { EvidenceBundle, StorefrontAudit } from '../../types';
import { sanitizeValue } from './sanitize';
import { qaPrioritySignals } from './fingerprints';

function sanitizeCandidateUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return null;
  }
}

export function buildDebugPackageFiles(audit: StorefrontAudit) {
  const trace = (() => {
    try {
      return audit.trace_steps ? JSON.parse(audit.trace_steps) : [];
    } catch {
      return [];
    }
  })();
  const evidence = audit.evidence_bundle;
  const screenshots = evidence?.runtime.screenshots || [];
  const withoutScreenshots: EvidenceBundle | null = evidence
    ? { ...evidence, runtime: { ...evidence.runtime, screenshots: [] } }
    : null;
  const observation = evidence?.network.observation;
  const productCandidates = evidence?.product.candidate_outcomes || [];
  const candidateCounters = {
    discovered: evidence?.product.candidate_discovered_count ?? 0,
    queued: evidence?.product.candidate_queued_count ?? 0,
    promoted: evidence?.product.candidate_promoted_count ?? 0,
    attempted: evidence?.product.candidate_attempted_count ?? 0,
    completed: evidence?.product.candidate_completed_count ?? 0
  };
  const sanitizedProductCandidates = productCandidates.map((candidate) => ({ rank: candidate.rank ?? null, source: candidate.source || 'unknown', sources: candidate.sources || [], score: candidate.score ?? null, promoted_from: sanitizeCandidateUrl(candidate.promoted_from), page_role: candidate.page_role || 'UNKNOWN', sanitized_url: sanitizeCandidateUrl(candidate.final_url || candidate.url), outcome: candidate.outcome, reason_code: candidate.reason_code || null, observation_complete: candidate.observation_complete ?? null, view_item_detected: candidate.view_item_detected ?? null, navigation_elapsed_ms: candidate.navigation_elapsed_ms ?? null, minimum_observation_ms: candidate.minimum_observation_ms ?? null, extended_observation_ms: candidate.extended_observation_ms ?? null, diagnostic_overhead_ms: candidate.diagnostic_overhead_ms ?? null, extended_observation_used: candidate.extended_observation_used ?? false }));
  const legacyDecisions = [
    ['consent', audit.consent_status, audit.finding_confidence?.consent, evidence?.consent.executed, evidence?.consent.post_reject_observation_completed],
    ['cmp', audit.cmp_provider, audit.finding_confidence?.cmp, evidence?.consent.executed, evidence?.consent.executed],
    ['product_payload', audit.product_payload_status, audit.finding_confidence?.product, evidence?.product.applicability === 'applicable', productCandidates.every((candidate) => candidate.observation_complete === true)],
    ['ga4', audit.site_ga4_detected, audit.finding_confidence?.ga4, true, observation?.request_capture_completed === true && observation?.data_layer_capture_completed === true && observation?.performance_capture_completed === true],
    ['meta', audit.site_meta_detected, audit.finding_confidence?.meta, true, observation?.request_capture_completed === true && observation?.data_layer_capture_completed === true && observation?.performance_capture_completed === true],
    ['server_side', audit.server_side_status, audit.finding_confidence?.server_side, true, evidence?.server_side.passive_classification_completed === true && observation?.request_capture_completed === true]
  ].map(([decision_name, value, finding, applicable, observation_complete]) => ({
    decision_name, status: value ?? null, confidence: (finding as any)?.confidence || 'low', reason_code: (finding as any)?.reason_code || null,
    observation_complete, applicable, evidence_codes: (finding as any)?.evidence || [], evidence_counts: { retained: ((finding as any)?.evidence || []).length },
    supporting_phases: [], blocking_uncertainty: observation_complete === true ? [] : ['observation_incomplete']
  }));
  // New bundles carry the exact canonical replay projection. Legacy bundles
  // retain this bounded compatibility fallback only.
  const decisions = (evidence?.decision_summary || legacyDecisions) as Array<{ decision_name: string; status: unknown; confidence?: unknown; reason_code?: unknown; blocking_uncertainty?: string[] }>;
  const canonicalDecision = (name: string) => decisions.find((decision) => decision.decision_name === name) || null;
  const decisionStatus = (name: string, fallback: unknown) => {
    const decision = canonicalDecision(name);
    return decision ? decision.status : fallback;
  };
  const normalizedErrors = [
    ...(evidence?.access.proxy_attempts || []).filter((attempt) => attempt.failure_classification).map((attempt) => ({
      phase: 'access', component: 'proxy', error_family: attempt.failure_classification, reason_code: attempt.failure_classification,
      recoverable: evidence?.access.proxy_fallback_used === true, recovered: evidence?.access.proxy_fallback_recovered === true,
      candidate_index: null, elapsed_ms: attempt.connect_duration_ms, effect_on_decision: 'Access evidence was degraded.'
    })),
    ...((evidence?.runtime.proxy_attempts || []).filter((attempt) => attempt.failure_reason).map((attempt) => ({
      phase: 'access', component: 'proxy', error_family: attempt.failure_reason || 'PROXY_FAILURE', reason_code: attempt.failure_reason || null,
      recoverable: evidence?.runtime.proxy_fallback_used === true, recovered: evidence?.runtime.proxy_fallback_recovered === true,
      candidate_index: null, elapsed_ms: attempt.connection_ms || null, effect_on_decision: 'Runtime proxy attempt failed.'
    }))),
    ...((observation?.capture_channel_errors || []).map((reason_code) => ({
      phase: 'tracking', component: 'capture', error_family: 'CAPTURE_CHANNEL_ERROR', reason_code,
      recoverable: false, recovered: false, candidate_index: null, elapsed_ms: null, effect_on_decision: 'Tracking absence conclusions are limited.'
    }))),
    ...productCandidates.filter((candidate) => ['TRANSPORT_FAILED', 'OBSERVATION_INCOMPLETE', 'TIMEOUT'].includes(candidate.outcome)).map((candidate, index) => ({
      phase: 'product', component: 'pdp_candidate', error_family: candidate.outcome, reason_code: candidate.reason_code || candidate.outcome,
      recoverable: false, recovered: false, candidate_index: index, elapsed_ms: candidate.observation_elapsed_ms || null, effect_on_decision: 'Product result may be inconclusive.'
    }))
  ];
  const timeline = (trace as any[]).map((item, index) => ({
    timestamp: item?.timestamp || null, elapsed_ms: item?.elapsed_ms ?? null, phase: item?.phase || item?.step || 'runtime', module: item?.module || (/consent/i.test(String(item?.step)) ? 'consent' : /pdp|product/i.test(String(item?.step)) ? 'product' : /server|collector/i.test(String(item?.step)) ? 'server' : 'tracking'),
    event: item?.step || `event_${index + 1}`, status: item?.status || null,
    severity: item?.severity || (/failed|error|timeout/i.test(String(item?.step)) ? 'error' : /incomplete|rejected|skipped/i.test(String(item?.step)) ? 'warning' : /completed|detected|selected|validated/i.test(String(item?.step)) ? 'success' : 'info'),
    reason_code: item?.reason_code || null, summary: String(item?.reason || item?.step || 'Audit event').slice(0, 240), duration_ms: item?.duration_ms || null, candidate_index: item?.candidate_attempt || null
  }));
  const files: Record<string, string | Buffer> = {
    'audit-result.json': JSON.stringify(sanitizeValue({ ...audit, trace_steps: undefined, evidence_bundle: undefined }), null, 2),
    'trace.jsonl': (sanitizeValue(trace) as unknown[]).map((line) => JSON.stringify(line)).join('\n'),
    'evidence.json': JSON.stringify(sanitizeValue(withoutScreenshots), null, 2),
    'normalized-evidence.json': JSON.stringify(sanitizeValue(withoutScreenshots), null, 2),
    'network-summary.json': JSON.stringify(sanitizeValue(evidence?.network || {}), null, 2),
    'cmp-evidence.json': JSON.stringify(sanitizeValue(evidence?.consent || {}), null, 2),
    'product-evidence.json': JSON.stringify(sanitizeValue(evidence?.product || {}), null, 2),
    'quality-summary.json': JSON.stringify(sanitizeValue({
      selected_modules: evidence?.selected_modules || audit.selected_modules || ['consent', 'tracking', 'server_side'],
      qa_priority: audit.qa_priority ?? null,
      qa_priority_signals: evidence ? qaPrioritySignals(audit, evidence, audit.consistency_violations || []) : [],
      failure_fingerprints: audit.failure_fingerprints || [],
      consistency_violations: audit.consistency_violations || [],
      candidate_pdp_url: evidence?.product.candidate_url || null,
      final_pdp_url: evidence?.product.final_pdp_url || evidence?.product.pdp_url || null
    }), null, 2),
    'access-summary.json': JSON.stringify(sanitizeValue({
      access: evidence?.access || null,
      page: evidence ? {
        valid: evidence.page.valid,
        status_code: evidence.page.status_code,
        final_url: evidence.page.final_url,
        access_category: evidence.page.access_category,
        bot_provider: evidence.page.bot_provider,
        challenge_cleared: evidence.page.challenge_cleared,
        retry_after_ms: evidence.page.retry_after_ms
      } : null,
      failure_fingerprints: (audit.failure_fingerprints || []).filter((code) => /PROXY|FALLBACK|CHALLENGE|WAF|HTTP_RATE|STOREFRONT/.test(code)),
      access_consistency_violations: (audit.consistency_violations || []).filter((code) => code.startsWith('ACCESS_'))
    }), null, 2),
    'proxy-attempt-summary.json': JSON.stringify(sanitizeValue({
      initial_provider: evidence?.access?.initial_provider || evidence?.runtime.proxy_initial_provider || null,
      final_provider: evidence?.access?.final_provider || evidence?.runtime.proxy_final_provider || null,
      fallback_used: evidence?.access?.proxy_fallback_used ?? evidence?.runtime.proxy_fallback_used ?? false,
      fallback_recovered: evidence?.access?.proxy_fallback_recovered ?? evidence?.runtime.proxy_fallback_recovered ?? false,
      fallback_candidate: evidence?.runtime.proxy_fallback_candidate || false,
      attempts: evidence?.access?.proxy_attempts || evidence?.runtime.proxy_attempts || []
    }), null, 2),
    'build-metadata.json': JSON.stringify({
      scanner_version: evidence?.scanner_version || 'unknown',
      build_commit: evidence?.build_commit || null,
      build_dirty: evidence?.build_dirty ?? null,
      build_timestamp: evidence?.build_timestamp || 'unknown',
      rule_pack_version: evidence?.rule_pack_version || 'unknown'
    }, null, 2),
    'manifest.json': JSON.stringify(sanitizeValue({ debug_schema_version: 2, scanner_version: evidence?.scanner_version || 'unknown', build_commit: evidence?.build_commit || null, build_dirty: evidence?.build_dirty ?? null, build_timestamp: evidence?.build_timestamp || null, environment_mode: evidence?.mode || null, selected_modules: evidence?.selected_modules || audit.selected_modules || [], audit_start: audit.scan_started_at, audit_end: audit.scan_completed_at }), null, 2),
    'summary.json': JSON.stringify(sanitizeValue({ audit_id: audit.audit_id, domain: audit.domain, build_commit: evidence?.build_commit || null, build_dirty: evidence?.build_dirty ?? null, geo: audit.tested_geos, selected_modules: evidence?.selected_modules || audit.selected_modules || [], scan_status: audit.scan_status, total_duration_ms: evidence?.runtime.total_duration_ms || null, final: { overall: audit.overall_status, consent: decisionStatus('consent', audit.consent_status), product: decisionStatus('product_payload', audit.product_payload_status), ga4: decisionStatus('ga4', audit.site_ga4_detected), meta: decisionStatus('meta', audit.site_meta_detected), server_side: decisionStatus('server_side', audit.server_side_status) }, product_discovery: { homepage_candidate_count: evidence?.product.homepage_candidate_count ?? 0, sitemap_candidate_count: evidence?.product.sitemap_candidate_count ?? 0, sitemap_enrichment_status: evidence?.product.sitemap_enrichment_status || 'not_attempted', candidate_counters: candidateCounters }, product_runtime: evidence?.product.product_runtime || null, major_warnings: audit.qa_priority_signals || [], major_errors: (audit.failure_fingerprints || []), consistency_violations: audit.consistency_violations || [] }), null, 2),
    'decisions.json': JSON.stringify(sanitizeValue(decisions), null, 2),
    'product-candidates.json': JSON.stringify(sanitizeValue({ candidate_counters: candidateCounters, candidates: sanitizedProductCandidates }), null, 2),
    'tracking-summary.json': JSON.stringify(sanitizeValue({ vendors: ['ga4', 'meta'].map((vendor) => { const events = (evidence?.network.relevant_requests || []).filter((event) => event.vendor === vendor); return { vendor, final_decision: canonicalDecision(vendor), installation_observed: events.some((event) => event.kind === 'script') || events.some((event) => event.kind === 'collection'), collection_observed: events.some((event) => event.kind === 'collection'), collection_count: events.filter((event) => event.kind === 'collection').length, pre_accept_count: events.filter((event) => event.phase.includes('consent_initial')).length, post_accept_count: events.filter((event) => event.phase.includes('post_accept')).length, pre_reject_count: events.filter((event) => event.phase.includes('pre_reject')).length, post_reject_count: events.filter((event) => event.phase.includes('post_reject')).length, observation_complete: observation?.request_capture_completed === true, capture_channels: observation || {}, limited_consent_measurement_count: events.filter((event) => event.consent_measurement === 'limited_measurement').length, full_measurement_count: events.filter((event) => event.consent_measurement === 'full_measurement').length, first_party_count: events.filter((event) => event.collector !== 'third_party').length, third_party_count: events.filter((event) => event.collector === 'third_party').length }; }) }), null, 2),
    'consent-summary.json': JSON.stringify(sanitizeValue({ provider_candidates: evidence?.consent.provider_evidence || [], selected_provider: decisionStatus('cmp', audit.cmp_provider), provider_confidence: canonicalDecision('cmp')?.confidence || null, banner_visible: evidence?.consent.banner_visible ?? null, actions_available: { accept: evidence?.consent.accept_action_available ?? false, reject: evidence?.consent.reject_action_available ?? false, preferences: evidence?.consent.preferences_action_available ?? false }, actions_rollout_enabled: evidence?.consent.actions_rollout_enabled ?? false, action_attempted: evidence?.consent.interaction_attempted ?? false, verification_status: evidence?.consent.rejection_verified ?? false, post_reject_observation_complete: evidence?.consent.post_reject_observation_completed ?? false, pre_choice_measurement: evidence?.consent.pre_choice_measurement ?? false, limited_measurement_count: (evidence?.network.relevant_requests || []).filter((event) => event.phase.includes('consent_initial') && event.consent_measurement === 'limited_measurement').length, full_measurement_count: (evidence?.network.relevant_requests || []).filter((event) => event.phase.includes('consent_initial') && event.consent_measurement === 'full_measurement').length, unknown_measurement_count: (evidence?.network.relevant_requests || []).filter((event) => event.phase.includes('consent_initial') && event.consent_measurement === 'unknown').length, final_decision: canonicalDecision('consent') }), null, 2),
    'server-summary.json': JSON.stringify(sanitizeValue({ passive_classification_complete: evidence?.server_side.passive_classification_completed ?? false, first_party_count: evidence?.server_side.first_party_collection_count ?? 0, same_origin_count: evidence?.server_side.same_origin_collection_count ?? 0, third_party_count: evidence?.server_side.third_party_collection_count ?? 0, duplicate_count: evidence?.server_side.strict_duplicate_count ?? 0, collector_cookie_detected: (evidence?.server_side.collector_cookie_names || []).length > 0, persistence_checked: evidence?.server_side.collector_cookie_persistence_checked ?? false, persistence_result: evidence?.server_side.collector_cookie_persisted ?? false, final_decision: canonicalDecision('server_side'), blocking_uncertainty: canonicalDecision('server_side')?.blocking_uncertainty || [] }), null, 2),
    'timeline.json': JSON.stringify(sanitizeValue(timeline), null, 2),
    'errors.json': JSON.stringify(sanitizeValue(normalizedErrors), null, 2)
  };
  for (const screenshot of screenshots) {
    files[`screenshots/${screenshot.name.replace(/[^a-z0-9_.-]/gi, '_')}`] = Buffer.from(screenshot.content_base64, 'base64');
  }
  return files;
}
