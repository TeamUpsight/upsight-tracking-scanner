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

Capture inputs are reduced to a versioned bundle with `page`, `network`, `consent`, `product`, `server_side`, and `runtime` sections. Vendor parsers recognize qualifying requests or data-layer events; the collector stores bounded normalized fields. CMP and collection classifiers interpret their fact sets. Status resolvers choose conservative findings. Replay composes those results, runs consistency, and returns the fields used by live finalization and offline comparison.

Key distinctions must remain explicit: installation versus actual collection; generic Google collection versus GA4; third-party versus first/same-origin collection; CMP presence versus a verified consent transition; PDP discovery versus a valid URL-matched product event.

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
