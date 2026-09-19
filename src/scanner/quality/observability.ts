import type { EvidenceBundle, StorefrontAudit } from '../../types';

type Check = { code: string; status: 'pass' | 'mismatch' | 'not_applicable'; values: Record<string, unknown> };

function provider(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || /^(not found|unknown|null)$/i.test(value)) return null;
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mismatch(code: string, values: Record<string, unknown>, compared: unknown[]) : Check {
  const known = compared.filter((value) => value !== null && value !== undefined && value !== 'unknown');
  return { code, status: known.length < 2 ? 'not_applicable' : new Set(known.map((value) => String(value))).size > 1 ? 'mismatch' : 'pass', values };
}

export function buildObservabilityConsistency(audit: Partial<StorefrontAudit>, evidence: EvidenceBundle) {
  const runtime = evidence.runtime.consent_v2;
  const snapshots = evidence.diagnostic_observability?.consent_observations || [];
  const shared = snapshots.find((item) => item.context === 'shared');
  const fresh = snapshots.find((item) => item.context === 'fresh');
  const canonical = evidence.decision_summary?.find((item) => item.decision_name === 'cmp')?.status ?? audit.cmp_provider ?? null;
  const runtimeProvider = runtime?.provider ?? null;
  const normalizedProviders = [provider(runtimeProvider), provider(evidence.consent.resolved_provider), provider(audit.cmp_provider), provider(canonical)];
  const providerCheck: Check = {
    code: 'OBS_CONSENT_PROVIDER_MISMATCH',
    status: normalizedProviders.every((value) => value === null) ? 'not_applicable' :
      normalizedProviders.some((value) => value !== null) && new Set(normalizedProviders).size > 1 ? 'mismatch' : 'pass',
    values: { runtime: runtimeProvider, persisted: evidence.consent.resolved_provider ?? null, audit: audit.cmp_provider ?? null, canonical }
  };
  const runtimeBanner = runtime?.banner_visibility ?? 'unknown';
  const persistedBanner = evidence.consent.banner_visible === true ? 'visible' : evidence.consent.banner_visible === false ? 'not_visible' : 'unknown';
  const sharedBanner = shared?.banner.visibility ?? runtime?.shared_observation?.banner_visibility ?? 'unknown';
  const bannerValues = [runtimeBanner, persistedBanner, sharedBanner].filter((value) => value !== 'unknown');
  const bannerCheck: Check = { code: 'OBS_CONSENT_BANNER_MISMATCH', status: bannerValues.length < 2 ? 'not_applicable' : new Set(bannerValues).size > 1 ? 'mismatch' : 'pass', values: { runtime: runtimeBanner, persisted: persistedBanner, shared: sharedBanner } };
  const actionRows = ['accept', 'reject', 'preferences'].map((name) => {
    const semantic = name === 'accept' ? 'accept_all' : name === 'reject' ? 'reject_all' : 'open_preferences';
    const snapshotHas = (snapshot: typeof shared) => snapshot?.visible_controls.some((control) => control.semantic_action === semantic && control.actionable) || false;
    const persisted = name === 'accept' ? evidence.consent.accept_action_available : name === 'reject' ? evidence.consent.reject_action_available : evidence.consent.preferences_action_available;
    return { action: name, shared: snapshotHas(shared), fresh: snapshotHas(fresh), persisted: persisted ?? false };
  });
  const actionMismatch = actionRows.some((row) => (row.shared || row.fresh) && !row.persisted);
  const actionCheck: Check = { code: 'OBS_CONSENT_ACTION_MISMATCH', status: !shared && !fresh ? 'not_applicable' : actionMismatch ? 'mismatch' : 'pass', values: { actions: actionRows } };
  const measurement = runtime?.measurement?.state ?? null;
  const measurementCheck = mismatch('OBS_CONSENT_MEASUREMENT_MISMATCH', { runtime: measurement, persisted: evidence.consent.pre_choice_measurement ?? null }, [measurement, evidence.consent.pre_choice_measurement ?? null]);
  const pdp = [evidence.product.final_pdp_url, evidence.product.pdp_url, audit.pdp_url_tested].filter(Boolean).map((value) => safeUrl(value));
  const productCheck: Check = { code: 'OBS_PRODUCT_PDP_MISMATCH', status: pdp.length < 2 ? 'not_applicable' : new Set(pdp).size > 1 ? 'mismatch' : 'pass', values: { final_pdp_url: safeUrl(evidence.product.final_pdp_url), pdp_url: safeUrl(evidence.product.pdp_url), audit_pdp_url_tested: safeUrl(audit.pdp_url_tested) } };
  const checks = [providerCheck, bannerCheck, actionCheck, measurementCheck, productCheck];
  return { status: checks.some((check) => check.status === 'mismatch') ? 'mismatch' as const : 'consistent' as const, checks };
}

function safeUrl(raw: unknown) {
  if (typeof raw !== 'string') return null;
  try { const value = new URL(raw); return `${value.protocol}//${value.host}${value.pathname}`; } catch { return null; }
}

export function buildDecisionProvenance(audit: Partial<StorefrontAudit>, evidence: EvidenceBundle) {
  const network = evidence.network.observation;
  const decisions = evidence.decision_summary || [];
  return decisions.map((decision) => ({
    decision_name: decision.decision_name,
    status: decision.status,
    confidence: decision.confidence,
    reason_code: decision.reason_code,
    applicable: decision.applicable,
    observation_complete: decision.observation_complete,
    evidence_used: decision.evidence_codes.slice(0, 20),
    blocking_uncertainty: decision.blocking_uncertainty.slice(0, 20),
    relevant_runtime_phase: decision.decision_name === 'consent' || decision.decision_name === 'cmp' ? 'consent_v2' : decision.decision_name === 'product_payload' ? 'product' : decision.decision_name === 'server_side' ? 'server_side' : 'tracking',
    relevant_observation_state: {
      request_capture_completed: network?.request_capture_completed ?? false,
      data_layer_capture_completed: network?.data_layer_capture_completed ?? false,
      performance_capture_completed: network?.performance_capture_completed ?? false,
      consent_shared_observation_complete: evidence.diagnostic_observability?.consent_observations.find((item) => item.context === 'shared')?.observation_complete ?? false,
      fresh_consent_session_status: evidence.runtime.consent_v2?.session_status ?? 'not_recorded',
      product_observation_complete: evidence.product.observation?.minimum_observation_satisfied ?? false,
      server_passive_classification_complete: evidence.server_side.passive_classification_completed ?? false,
      evidence_truncated: evidence.network.relevant_requests_truncated
    },
    source: 'canonical_replay',
    ignored_evidence: 'not_recorded'
  }));
}
