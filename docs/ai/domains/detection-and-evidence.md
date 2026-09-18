# Domain: detection and evidence

## Responsibility

Owns the normalized Evidence Bundle and deterministic conversion of captured facts into GA4, Meta, CMP/consent, product `view_item`, CMS, collection, confidence, reason, and overall statuses. The same rules must serve live finalization, tests, and replay.

## Primary files

- `src/types.ts` — status unions, `TrackingRequestEvidence`, `EvidenceBundle`, `StorefrontAudit`, feedback contracts.
- `src/scanner/evidence/evidence-collector.ts` — bounded capture, installation and request normalization.
- `src/scanner/tracking/ga4.ts` and `meta.ts` — central vendor parsers and normalized evidence conversion.
- `src/scanner/consent/detect-cmp.ts` — multi-signal provider detection and confidence.
- `src/scanner/consent/consent-state.ts` — verified rejection/acceptance transitions.
- `src/scanner/server-side/classify-collection.ts` — actual collection scope and strict duplicate classification.
- `src/scanner/resolver/status-resolver.ts` — consent, product payload, and overall status semantics.
- `src/scanner/quality/consistency.ts` — correction of impossible cross-module combinations.
- `src/scanner/quality/replay.ts` — canonical evidence-to-result composition.
- `src/scanner.ts` — compatibility facade; keep old public names backed by shared V2 logic.

## Evidence and decision flow

Capture inputs are reduced to a versioned bundle with `page`, `network`, `consent`, `product`, `server_side`, and `runtime` sections. Consent V2 enriches the consent facts in that bundle before it is completed; it must not overwrite replayed decision fields afterward. Vendor parsers recognize qualifying requests or data-layer events; the collector stores bounded normalized fields. CMP and collection classifiers interpret their fact sets. Status resolvers choose conservative findings. Replay composes those results, runs consistency, writes the canonical `decision_summary`, and returns the fields used by live finalization, debug exports, UI, and offline comparison.

Key distinctions must remain explicit: installation versus actual collection; generic Google collection versus GA4; third-party versus first/same-origin collection; CMP presence versus a verified consent transition; PDP discovery versus a valid URL-matched product event.

### Consent V2 pre-choice provenance (WP08)

`tracking-consistency.ts` normalizes Consent request facts and owns reconciliation. Shared requests use only `consent_initial_load`, `product_discovery`, and `product_pdp_load`; fresh requests use that session's choice timestamp. Each normalized record retains context, phase, timestamp, timing, evidence type, signal kind, and measurement facts. The unchanged GA4 parser supplies the existing wire classification. Event presence alone never establishes full measurement. The GCM observer can add a denied analytics-storage fact from commands in the same context at or before the request; later commands and shared/fresh cross-context commands cannot classify it. Opaque `gcd` and GPP encodings are not decoded.

Within a source, positive full and limited facts are monotonic; both yield `unknown` with `contradiction: true`. Across contexts, agreeing positive states retain that state; disagreement or an unknown measurement window yields `unknown`. An empty/script-only window supplies no contradictory positive fact. No evidence is `false` (not observed), not a compliance finding. A truncated window without positive evidence is unknown.

`runtime_metrics.consent_v2.measurement` stores the bounded source records, state, contradiction/truncation flags, and counters. Compatibility, replay, and `consent-summary.json` consume this same provenance. `tracking_requests_observed` counts supported requests captured in the scoped source, including overflow; `tracking_requests_retained` counts the bounded records. `tracking_signals_classified` and the pre-choice event/conversion/script counters count those retained records, so they are lower bounds when truncated. Event hits include recognized GA4 collections without an event name; script loads are always distinct. Full/limited counters count pre-choice records containing each positive fact (a conflicting record can contribute to both). Unknown counts count records with unknown classification. GCM network/command counts count the owning observer's retained observations, not tracking events. Source counts add without deduplicating separate browser contexts.

Consent buffers retain at most 100 requests per context and preserve examples of both explicit positive classes on overflow. This Consent-only buffer also preserves provenance when the shared tracking bundle reaches its independent cap; it does not change tracking capture, product budgets, or browser timing. Production remains observation-only; action rollout and provider flags are unchanged. `GPP_US_SEMANTIC_RESOLVER_PENDING` remains deferred.

Regression entry points: `measurement-consistency.test.ts` (CMP-MEASURE-01 through 10 and Morphe serialization), `v2-session.production.test.ts` (routed head-ping capture), and `audit-runner.production.test.ts` (both-context finalization and debug projection).

## Decision hardening invariants

All persisted correlated findings are resolved in replay before final persistence and then checked by `consistency.ts`. A negative requires explicit `true` completeness for every required capture channel; missing or incomplete state maps to `null`/`inconclusive`, never an absence. CMP provider identity remains available when behavioral verification is inconclusive. Product negatives require applicable commerce context plus complete candidate-local observation, while server-side `not_detected` requires completed passive request capture. Debug exports derive their decision summaries from this same resolved record.

## Important models and APIs

Persisted result fields and UI/API contracts are defined by `StorefrontAudit`. Evidence is persisted as JSONB through `src/db.ts`. Replay is exposed through `POST /api/v1/scans/:id/replay`, `POST /api/v1/replay`, and `scripts/replay.ts`; those consumers must agree.

## Common modification points

- New/changed GA4 or Meta wire shape: update the one central parser, normalized evidence, sanitized fixture, and parser/replay tests.
- CMP signature or precedence: `detect-cmp.ts`; interaction verification belongs in `consent-state.ts`, not detection.
- Product completeness/status: parser facts plus `resolveProductPayloadStatus`; keep PDP URL matching explicit.
- First-party/server-side conclusions: `classify-collection.ts`; actual parsed collection is required.
- New persisted status/field: update `src/types.ts`, replay/resolver/consistency, database columns, API/UI consumers, tests, and versioning.

## Validation

Add or update the smallest sanitized fixture, run its name-filtered test, then:

```text
npm run test:regression
npm run replay -- <fixture-or-evidence>
npm run typecheck
```

Use `npm run validate` for shared contract or cross-domain changes. When detector/resolver behavior changes intentionally, assess whether `RULE_PACK_VERSION` in `src/scanner/version.ts` must be updated.

## Pitfalls and invariants

- Production rules must be generic; never add a domain allow/deny special case to make one fixture pass.
- A GTM container alone and a generic `/collect` endpoint are not GA4 evidence.
- Meta collection seen in any phase cannot later be summarized as absent.
- First-party script hosting is not first-party collection; collector traffic must be parsed.
- Mixed collection is not a duplicate/misconfiguration by itself; strict duplicates match vendor/event/IDs/page context and available client/session identity within the defined window.
- Generic compatibility signals must not outrank provider-specific CMP evidence.
- Access failures dominate negative findings. Prefer an honest inconclusive result to a precise-looking unsupported label.
- Never retain raw secrets, cookie values, authorization headers, or unbounded URLs/base64 outside the established bounded evidence rules.
