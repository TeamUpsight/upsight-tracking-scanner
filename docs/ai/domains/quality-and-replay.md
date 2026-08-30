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

Live finalization calls the same replay/consistency/fingerprint functions used offline. API replay loads stored evidence and compares previous/current results without mutation. QA feedback persists separately and metrics classify verified outcomes only when an expected value permits scoring. Review candidates are recalculated from the current rule pack, use one latest audit per normalized website, attach feedback only from that audit, and omit rows marked correct.

The reviewer consumes an audit, evidence, and parsed trace, then returns violations, likely root cause, patch guidance, and regression suggestions. The sanitized chronological trace remains a separate UI concept from derived reviewer output.

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
- Sanitization is defense in depth; debug packages still require review before sharing.
