# Domain: quality, replay, and review

## Responsibility

Turns stored evidence and human feedback into reproducible rule evaluation, consistency checks, failure clusters, review priority, operational/accuracy metrics, sanitized debug exports, and deterministic diagnosis. It must remain read-only with respect to source code and must not visit storefronts during replay/review.

## Primary files

- `src/scanner/quality/replay.ts` — run current rules on Evidence Bundles and compare major fields.
- `consistency.ts` — enforce cross-module invariants before final persistence.
- `fingerprints.ts` — stable failure codes and transparent QA-priority signals.
- `metrics.ts` — latest-unique-website operational/verified metrics.
- `review-queue.ts` — latest audit per normalized site, feedback attachment, resolved removal.
- `audit-reviewer.ts` — deterministic guardrail diagnosis and patch/test suggestions.
- `sanitize.ts` and `debug-package.ts` — safe trace/evidence/export handling.
- `scripts/replay.ts` — CLI entry point.
- `src/scanner/scanner-core.test.ts`, `tests/fixtures/` — parser, guardrail, resolver, proxy/lifecycle, and replay corpus.
- `QUALITY_SYSTEM.md` — deeper status, scoring, debug, and fixture semantics.

## Flow and dependencies

Live finalization calls the same replay/consistency/fingerprint functions used offline. API replay loads stored evidence and compares previous/current results without mutation. Access-quality metrics consume bounded `evidence.access` facts (provider attempts, challenge outcome, geo, port, and time-to-valid-storefront); they never trigger browser actions or reinterpret access observations as tracking findings. QA feedback persists separately and metrics classify verified outcomes only when an expected value permits scoring. Review candidates are recalculated from the current rule pack, use one latest audit per normalized website, attach feedback only from that audit, and omit rows marked correct.

Consent provider projection (P0.2B, rule pack `2026.09.29.10`) keeps identity separate from earned absence. `consent/provider-projection.ts` preserves an authoritative stored `Not Found` with `NO_CMP_DETECTED` and its existing confidence through later providerless merges. Named or generic/custom identity replaces absence and removes the stale absence code; provider conflict clears absence conservatively with `PROVIDER_CONFLICT`. Projection never earns new absence. Replay retains its existing valid-access, ready-render, technical-blocker, and AdRoll bootstrap gates; the Audit-619-shaped local runner regression checks live/persisted/replay agreement and repeat replay in normal and diagnostic modes. P0.2A browser-error access remains invalid and inconclusive.

The reviewer consumes an audit, evidence, and parsed trace, then returns violations, likely root cause, patch guidance, and regression suggestions. The sanitized chronological trace remains a separate UI concept from derived reviewer output.

Consent diagnostic UI action evidence (P0.2C) requires a matching semantic action plus visible, enabled, actionable DOM controls. Capability-only synthetic rows remain non-visible, including direct and API-only availability. Identified Didomi with a visible banner projects bounded semantic controls from the existing `#didomi-host` / `#didomi-notice` facts before generic rows; the shared multilingual classifier, canonical action inventory, and control-extraction-gap requirements remain unchanged.

Debug package summaries consume `EvidenceBundle.decision_summary` whenever it is available. Module-specific summaries may add descriptive counts, but they must not recalculate status, reason, confidence, or blocking uncertainty. Build metadata includes the commit and build-time dirty state so a controlled audit can be tied to a clean tested commit.

## Related endpoints and data

- `POST /api/v1/scans/:id/qa-feedback`
- `POST /api/v1/scans/:id/mark-correct`
- `GET /api/v1/quality/metrics`
- `GET /api/v1/quality/review-candidates`
- `POST /api/v1/scans/:id/review`
- `POST /api/v1/scans/:id/replay` and `POST /api/v1/replay`
- `GET /api/v1/scans/:id/debug-package`

Important fields are `qa_priority`, `qa_priority_signals`, `qa_review_status`, `qa_feedback`, `reason_codes`, `failure_fingerprints`, `consistency_violations`, and `finding_confidence`.

## Common modification points

- Classification regression: sanitized fixture -> shared detector/resolver -> replay result -> expected test.
- Impossible combination: `consistency.ts` plus a targeted invariant test.
- Review ranking: `qaPrioritySignals` and latest-audit queue behavior; keep point labels transparent.
- New quality metric: define denominator/ground truth, update `metrics.ts`, shared response type/UI, and edge-case tests.
- Debug package content: update builder and sanitization together; review binary/secret exposure.

## Validation

Run a name-filtered test, the regression suite, and a representative replay:

```text
npm test -- src/scanner/scanner-core.test.ts -t "<behavior>"
npm run test:regression
npm run replay -- tests/fixtures/laird-evidence.json
npm run typecheck
```

Add `npm run build` when API response shape or UI presentation changes.

## Pitfalls and invariants

- Replay and reviewer never browse or mutate stored audits/source.
- “Correct” without an expected value is feedback but intentionally unscored.
- Metrics and review distributions use the latest audit per unique normalized site while total stored-audit count remains separate.
- Feedback from an older audit must not appear on a newer site row.
- Marking correct resolves priority without deleting evidence or historical feedback.
- Keep observed trace facts distinct from derived diagnosis.
- Canonical access rejects strong browser-generated error documents as `access_blocked` / `BROWSER_ERROR_PAGE`, even after HTTP 2xx/3xx. Shared and fresh page validity must consume that access decision; stored invalid page/access facts keep replay and module absence conservative.
- Sanitization is defense in depth; debug packages still require review before sharing.
