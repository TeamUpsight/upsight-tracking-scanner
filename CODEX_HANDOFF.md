# Upsight Tracking Scanner V2 — engineering handoff

Updated: 2026-08-29

This file describes the actual V2 repository state. Use source, tests, stored evidence, and runtime traces as truth if this document diverges.

## Current state

The scanner is now organized around browser execution -> normalized evidence -> shared detectors -> resolvers -> consistency -> audit result -> quality/replay. `src/scanner.ts` is a compatibility facade; live behavior is in the modular `src/scanner/` tree.

Implemented:

- one GA4 parser and one Meta parser shared by all phases and offline replay, including classic Meta requests and Shopify Web Pixels Manager `facebook_pixel` configuration.
- exact Laird `pr1`/`view_item` fixture coverage.
- separate GA4 installation, collection, and ecommerce product findings.
- Browserless default-context reuse and one-session homepage/PDP behavior.
- listeners before PDP navigation and a 12-second post-load observation window.
- randomized two-level PDP candidates with comparison-route exclusion, hydration reassessment, and URL-scoped `view_item` override of out-of-stock signals.
- multi-signal OneTrust, Fides, TrustArc, and Shopify Privacy detection with known false-positive guardrails and real provider control interaction.
- verified consent rejection only; no DOM hiding or fake reject result.
- strict actual-collection classification for first-party/server-side findings.
- strict duplicate comparison within 1,500 ms; mixed collection alone is not misconfigured.
- bounded Decodo port/session/country rotation and correct rate-limit/access terminal semantics.
- bounded sanitized recovery for otherwise-unclassified homepage navigation exceptions and PDP tunnel failures; dead PDP sessions rotate before another candidate is attempted.
- round-robin concurrent port allocation, durable port health/quarantine, geo-aligned browser settings, and sanitized egress verification.
- ordered multi-signal bot/access classification, Retry-After capture, domain cooldowns, and manual-only BrowserQL/provider escalation.
- context-level request capture including service-worker requests.
- main-document commit navigation with soft `DOMContentLoaded` recovery.
- evidence-backed external storefront migration redirects with corrected first-party scope.
- exact-domain, document-only authorized access header injection for owned sites.
- explicit Browserless third-party-proxy plan detection with no misleading direct fallback or wasted proxy retries.
- one standard finalization guard with distinct cancellation and timeout states.
- ordered progress persistence so a slow interim update cannot overwrite a terminal result.
- timezone-aware audit timestamps and database-side stale selection.
- bounded local/HTTPS DNS preflight with `DNS_RESOLUTION_FAILED` classification.
- bounded, sanitized normal/diagnostic Evidence Bundles.
- per-finding confidence, reason codes, failure fingerprints, novelty and QA priority.
- cross-module consistency correction.
- diagnostic rerun, sanitized ZIP debug export, deterministic Audit Reviewer, API/CLI replay.
- QA feedback, persistent Mark as Correct resolution, Review Candidates with one latest-audit row per website and no older-feedback leakage, latest-unique-website accuracy/operational metrics, and proxy metrics.
- redesigned master/detail audit workspace with CMS visibility, explicit action semantics, per-finding QA verification, trace timelines, and structured reviewer/replay results.
- chart-ready quality analytics with trends, distributions, ranked failure clusters, improvement recommendations, QA coverage, and verified category outcomes.
- access/proxy dashboard with readiness, queue load, geo traffic, retry recovery, latency, quarantine, and per-port health rather than raw JSON.
- bounded single/bulk queue, CSV validation/deduplication/limits, internal API token.
- PostgreSQL fail-fast behavior; explicit local-only memory database.

Removed:

- `@google/genai`, Gemini initialization/prompts, and AI Studio configuration.
- runtime source modification and all Auto Fixer source/report artifacts.
- outreach/email generation fields, APIs, prompts, UI, and tests.
- unused Motion dependency and external font imports.

## Primary code map

- `server.ts`: internal API, queue adapter, auth, exports, QA/replay/debug endpoints.
- `src/db.ts`: PostgreSQL/memory storage and safe V2 schema extensions.
- `src/scanner/audit-runner.ts`: live audit lifecycle.
- `src/scanner/evidence/evidence-collector.ts`: bounded normalized evidence.
- `src/scanner/tracking/`: central vendor parsers.
- `src/scanner/consent/`: CMP and verified consent state.
- `src/scanner/server-side/`: collection and duplicate classification.
- `src/scanner/resolver/`: statuses and finalization guard.
- `src/scanner/quality/`: consistency, reviewer, replay, metrics, debug and fingerprints.
- `src/App.tsx`: replacement internal operations UI.
- `scripts/access-benchmark.ts`: controlled live access corpus and operational comparison report.
- `tests/fixtures/`: sanitized permanent regression inputs.

## Validation baseline and V2 result

Before V2 changes, dependency install, typecheck, 52 legacy Auto Fixer-centric tests, and production build passed. Those obsolete tests were removed with their production feature.

V2 deterministic validation commands are:

```powershell
npm run typecheck
npm test
npm run test:regression
npm run build
```

Most recent deterministic validation on 2026-08-29:

- `npm run typecheck`: passed.
- `npm test`: passed, 70 deterministic tests including Jabra/Peloton QA fixtures, Fides precedence, TrustArc controls, PDP hydration/out-of-stock behavior, navigation failure classification, and latest-audit-only Review Queue feedback.
- `npm run build`: passed after the operations UI redesign.
- `npm run validate`: passed after the latest QA/PDP/Quality changes (typecheck, 70 tests, production UI/server build).
- `npm run test:regression`: covered by the same 70-test deterministic scanner corpus, including the named Laird/MeUndies/Lakanto/MATW/Morphe/Jabra/Peloton cases and Browserless/Decodo failure semantics.
- `npm run replay -- tests/fixtures/laird-evidence.json`: passed; the exact Laird payload resolved to `product_payload_status=pass` with measurement ID `G-EQKQBN73B3` and the expected product values.
- authenticated built-server smoke test: passed health, 401 without token, authorized scans, and quality metrics.
- rendered UI smoke test: passed Audits, Quality, Review Candidates, and Proxy views with no browser console errors.
- `npm audit --omit=dev`: 0 vulnerabilities after lockfile-safe transitive updates.

Re-run `npm run validate` on the target machine because Browserless/proxy integration cannot be proven by offline tests.

## Known limitations

- The queue is process-local. A process restart relies on emergency stale recovery for unfinished rows until Cloudflare Queues/Workflows are adopted.
- The regression corpus validates deterministic evidence classification, not a complete mocked Browserless CDP transport.
- Quality precision/recall becomes meaningful only after reviewers submit category-specific expected values.
- Screenshots are stored inline in diagnostic Evidence Bundles; move large artifacts to R2 if volume becomes material.
- Google Ads has a persisted finding field but does not yet have the same depth of collection parsing as GA4/Meta.
- CMP reject automation intentionally covers only known, verifiable provider controls. Unknown/custom CMPs resolve conservatively.
- One PDP per site improves throughput but cannot prove catalog-wide consistency.
- No Git metadata was present in this handoff directory, so no commit or push was performed.
- Browserless third-party-proxy plan restrictions are detected explicitly as `BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED`. The currently configured token now accepts `externalProxyServer` sessions; retain the guardrail for future token or plan changes.
- BrowserQL challenge solving and Browserless residential 429 fallback are implemented but disabled by default because they require explicit plan/cost authorization. They are never used for bulk scans.
- `matwproject.com` currently has no A/AAAA response from the local resolver; it cannot produce a tracking audit until its origin resolves. The scanner records DNS/origin-unreachable evidence rather than fabricating absence findings.

## 2026-08-28 live access validation

Updated-code audits were run as group `access-fix-validation-2026-08-28`:

- audit 190, `lumee.com`: completed after a verified redirect to `case-mate.com`; slow DOMContentLoaded was retained as a soft timing fact.
- audit 191, `www.mizzenandmain.com`: completed after one bounded 429/session rotation.
- audit 192, `listenlively.com`: completed after a verified redirect to `www.jabraenhance.com` and successfully selected a PDP there.
- audit 193, `www.meundies.com`: correctly remained failed/inconclusive after repeated 429 responses; no false negative tracking conclusions were emitted.
- audit 189, `matwproject.com`: origin did not resolve/reach through otherwise working proxy egress. The subsequent code refinement labels this DNS/origin-unreachable instead of a generic proxy failure.

## 2026-08-29 QA validation

- audit 226, `www.onepeloton.com`: completed with Fides detected instead of the compatibility `OptanonWrapper`, verified consent enablement, GA4 detected, and `product_payload_status=pass` on a Bike+ PDP.
- audit 234, `listenlively.com`: recovered from an initial homepage tunnel failure by rotating from Decodo port 10001 to 10002, completed the verified redirect to Jabra Enhance, excluded comparison routes, and selected a hydrated M1 PDP. TrustArc acceptance could not be affirmatively changed under the Browserless GPC session, so product tracking remained `inconclusive` rather than being mislabeled absent. The QA-confirmed M3 request is retained as a sanitized parser regression fixture and resolves to pass offline.
- live Quality API verification reported 42 stored audits and 12 unique websites, with distributions and Review Candidates based on one latest audit per normalized website. The latest rows for ListenLively (234) and Peloton (226) contain no feedback copied from their older audits.

## Next engineering step

First extract the queue contract from `server.ts`, then containerize the current Node scanner without changing its evidence/detector API. Prove one live audit in the container before adding the Worker/Queue boundary described in `DEPLOYMENT.md`.

## Manual validation checklist

1. Configure a non-production PostgreSQL database, Browserless, and real Decodo proxy URLs.
2. Start with `SCAN_CONCURRENCY=1`.
3. Run one normal audit and one diagnostic audit.
4. Confirm one `scan_finalized` event in each trace.
5. Test a known rate-limited or blocked fixture/site and confirm no confident absence conclusions.
6. Export and inspect a debug ZIP for credential/cookie-value leakage.
7. Submit QA feedback and confirm Quality and Review Candidates update.
8. Replay the exported evidence and compare the result before increasing concurrency.
