# Quality system

## Principle

Quality work starts from captured facts, not from a final label. The rule pack in `src/scanner/` can run against live browser evidence or the same stored Evidence Bundle offline. Confirmed bugs should add a sanitized fixture before their detector or resolver is changed.

## Status and confidence

Major findings contain a machine-readable status, a reason code, confidence, and evidence labels. `overall_confidence` is a summary only; use `finding_confidence` to understand individual conclusions.

- `not_tested`: execution never happened or was deliberately skipped.
- `inconclusive`: execution happened, but the observation cannot support a positive or negative conclusion.
- `not_detected`: a valid observation completed and no qualifying evidence was found.

Access failures always dominate absence claims. For example, a rate-limited homepage resolves consent to `inconclusive`, product/server modules to `not_tested`, and the overall result to low-confidence `inconclusive`.

## Reason codes and fingerprints

Reason codes explain individual decisions; stable failure fingerprints support clustering. Current examples include:

```text
CMP_NOT_DETECTED
CMP_SCRIPT_ONLY
CMP_REJECT_NOT_VERIFIED
GA4_SCRIPT_ONLY
GA4_NO_VIEW_ITEM
GA4_VIEW_ITEM_VALID
PDP_NOT_FOUND
PDP_NAV_TIMEOUT
HTTP_RATE_LIMITED
BOT_CLOUDFLARE
PROXY_TUNNEL_FAILED
BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED
DNS_RESOLUTION_FAILED
SERVER_FP_COLLECTOR
SERVER_MIXED_NO_DUPLICATE
SCAN_FINALIZATION_MISSING
```

Novelty detection compares sanitized CMP, CMS, bot, endpoint, collector-path, and tracking-global signals with known patterns. Novel endpoints or unknown platforms increase `qa_priority` and surface the audit in Review Candidates.

## Cross-module consistency

Before persistence the checker enforces invariants, including:

- GA4 installation evidence cannot coexist with `product_payload_status=ga4_not_detected`.
- Meta collection seen in any phase cannot be summarized as absent.
- Collector-cookie persistence is not considered without a first-party collection request.
- Invalid storefront access cannot support confident CMP, product, or server-side absence.
- Lifecycle recovery cannot alter a normally finalized scan.

Violations are stored in `consistency_violations`, added to fingerprints where relevant, and raise review priority. The checker prefers an inconclusive result over an impossible one.

## QA feedback and metrics

The UI and `POST /api/v1/scans/:id/qa-feedback` accept `correct` or `incorrect`, a category, an expected/corrected value, and notes. Categories are CMP, Consent, GA4, Meta, view_item, PDP discovery, server-side, CMS, bot/access, and other.

`POST /api/v1/scans/:id/mark-correct` records that the latest audit was reviewed as accurate. It clears the audit's active QA priority, removes that latest website result from Review Candidates, and excludes its resolved fingerprints from Quality improvement clusters without deleting the underlying evidence.

Verified feedback is converted into true positive, false positive, true negative, false negative, inconclusive, not tested, or unscored outcomes. The quality endpoint reports:

- GA4 precision and recall.
- CMP exact-value accuracy.
- per-category verified outcome counts.
- completion, valid-storefront, proxy-failure, rate-limit, bot, access-block, inconclusive, retry, and retry-recovery rates.
- challenge-clear and accepted external-redirect rates.
- average and p95 duration.
- clustered failure fingerprints.

An expected value is required for metric scoring. A “correct” marker without an expected value is retained as feedback but is deliberately unscored.

## Review Candidates

`GET /api/v1/quality/review-candidates` prioritizes low confidence, contradictions, new patterns, lifecycle violations, unusual access behavior, unknown CMP/CMS, script-without-collection, and similar high-information scans. Review candidates should be sampled regularly during bulk runs, not only after obvious failures.

Review priority is recalculated from the current rule pack whenever audits are read; it is not a permanently stale score copied from the original scan. The API exposes `qa_priority_signals` so the UI can show the exact rule and point contribution. Current weights are deliberately finding-oriented: consistency contradictions (40), failed execution (35), verified incorrect feedback (50), serious Consent/view-item/server-side findings (25), incomplete completed modules (20), PDP discovery failure or GA4 script without collection (15), and lower-confidence novelty or unknown-platform signals (5–10). The score is capped at 100. A recovered access retry and already-known Google campaign-measurement endpoints do not create review priority by themselves.

The endpoint returns one row per normalized website using its latest audit. QA feedback is attached only when its `audit_id` matches that latest audit; feedback from an older audit is retained in the ground-truth dataset but is not shown as if it belongs to the current result. Audits marked correct are resolved and omitted. Quality distributions, rates, trends, durations, and improvement priorities use the same latest-unique-website basis, while the API also reports the total stored audit count.

The Audit detail Evidence Summary separates four kinds of tags instead of presenting one undifferentiated warning list:

- **Decision Reasons** explain why detector/resolver statuses were chosen.
- **Review Triggers** explain why the result needs human attention and mirror `qa_priority_signals`.
- **Failure Fingerprints** are stable clustering codes for recurring scanner and site behaviors.
- **Consistency Issues** identify impossible or contradictory cross-module conclusions.

Tag labels are human-readable in the UI while the original machine code remains available as hover text and in exported evidence.

## Deterministic Audit Reviewer

The Audit Reviewer is read-only. It parses JSON arrays or JSONL traces, detects guardrail violations, explains the likely root cause, suggests which shared detector/resolver to inspect, and suggests regression fixtures. It never calls an LLM and never changes source code. Changes are made through the normal Git/Codex workflow.

The reviewer response intentionally does not include the sanitized trace. The two tools have separate responsibilities:

- the sanitized trace is a chronological evidence timeline used to inspect what the scanner executed;
- the Audit Reviewer is a derived diagnosis containing classification, guardrail violations, likely root cause, patch guidance, and regression-test suggestions.

Keeping the trace out of the reviewer response prevents duplicated UI output and makes it clear which content is observed fact versus deterministic interpretation.

## Diagnostic mode and debug package

Normal mode is the bulk default. Diagnostic mode retains additional bounded request summaries, CMP signals, cookie names (never values), DOM/global/iframe evidence, response errors, timing, and screenshots.

`Re-run Diagnostic` creates a new diagnostic audit without challenge escalation. `Re-run Difficult Site` creates a manual diagnostic audit with the configured CAPTCHA/challenge retry enabled. Replay is different from both: it never opens the website and only re-runs the current rule pack against stored evidence.

**Export Debug Package** creates a sanitized ZIP containing:

```text
audit-result.json
trace.jsonl
evidence.json
network-summary.json
cmp-evidence.json
product-evidence.json
build-metadata.json
screenshots/
```

Review the package before sharing it outside the internal team. Sanitization is defense in depth, not permission to publish scan evidence.

## Offline replay

```powershell
npm run replay -- .\path\to\evidence.json
npm run replay -- .\path\to\exported-debug-folder
```

The same capability is available per audit at `POST /api/v1/scans/:id/replay` and in bulk at `POST /api/v1/replay`. Replay does not browse a website or mutate the stored audit. It reports changed decision fields and their old/new values.

## Regression corpus

`tests/fixtures/` includes the exact Laird Superfood GA4 `view_item` request and a sanitized corpus for MeUndies 429 behavior, Lakanto delayed `view_item` and Shopify Privacy controls, MATW, Morphe Meta configuration traffic and Shopify Web Pixels Manager `facebook_pixel` configuration, Jabra Enhance network and `dataLayer` product events from verified QA feedback, TrustArc custom-preference submission, Peloton product requests, Mizzen out-of-stock PDP handling, Fides/OneTrust detection, third-party-only GA4, mixed collection, strict duplicate collection, proxy failure, bot protection, PDP timeout/not found, timeout, cancellation, and module budget skip.

Run:

```powershell
npm run test:regression
```

Production detector fixes must be generic. Domain names belong in fixture descriptions, never in production rules.
