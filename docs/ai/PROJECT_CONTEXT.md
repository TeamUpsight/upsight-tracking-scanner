# Project context

## System overview

Upsight Tracking Scanner V2 is an internal, evidence-based ecommerce tracking audit application. It visits a submitted storefront in a selected geo (`USA`, `UK`, or `EU`), captures bounded browser/network/consent/product evidence, and deterministically reports CMP/consent, GA4, Meta, ecommerce `view_item`, CMS, and likely first-party/server-side collection findings. It deliberately makes no legal-compliance claim.

The repository is one TypeScript application rather than a monorepo. Development uses a Vite React UI and an Express server in the same process. In production, Express serves the built SPA. The server owns a bounded process-local queue, persists audit state through `AuditDatabase`, and delegates one audit to the scanner runtime. PostgreSQL is the durable store; memory storage exists only behind explicit local `USE_MEMORY_DB=true`.

## Runtime architecture

```text
React operations UI
  -> Express REST API + optional internal token
  -> process-local domain-aware queue
  -> runStorefrontAudit()
  -> Browserless CDP session using configured Decodo geo proxy
  -> bounded normalized Evidence Bundle
  -> shared detectors and status resolvers
  -> consistency/fingerprint/QA-priority finalization
  -> PostgreSQL audit, feedback, and proxy-health records
  -> UI, CSV/debug export, deterministic reviewer, or offline replay
```

The UI does not use a routing or global-state library. `src/App.tsx` owns view selection, filters, selected audit, polling, forms, and API state with React hooks. `src/ui/api.ts` is the fetch wrapper. The four logical views are Audits, Quality, Review Queue, and Access/Proxy Health.

## Core architectural boundaries

1. **Capture facts before conclusions.** Browser/page code records normalized facts in an `EvidenceBundle`. It must not invent final detection labels.
2. **One decision rule pack.** GA4, Meta, CMP, collection, status, and consistency logic is shared by live scans, deterministic tests, API replay, and CLI replay.
3. **Conservative failure semantics.** Invalid access, blocking, timeout, or incomplete modules resolve to `inconclusive` or `not_tested`, never a confident negative finding.
4. **Finalize once.** Ordinary paths pass through `FinalizeOnce`, merge evidence, run replay/consistency/fingerprints, persist ordered updates, and emit one `scan_finalized` trace event.
5. **Bounded and sanitized evidence.** Normal mode is lean; diagnostic mode retains more bounded request/CMP/timing/screenshot evidence. Secrets, cookie values, raw authorization headers, raw proxy IPs, and full sensitive URLs are excluded.
6. **Access escalation is constrained.** BrowserQL challenge solving and Browserless provider fallbacks are manual, opt-in, plan/cost-sensitive, and never used for bulk scans.

## Major domains

- **Scanner runtime and access:** Browserless connection, context reuse, DNS/access classification, redirects, consent interaction, PDP discovery, proxy rotation, time budgets, cancellation, and ordered finalization.
- **Detection and evidence:** normalized evidence types/collector; GA4, Meta, CMP, consent-state, product, collection, status, and consistency rules.
- **Quality and replay:** offline rule execution, difference reporting, fingerprints, priority scoring, sanitized debug packages, deterministic reviewer, metrics, and human QA feedback.
- **API, queue, and persistence:** request validation/auth, queue/cooldown behavior, audit lifecycle endpoints, PostgreSQL/memory implementations, startup recovery, exports.
- **Operations UI:** audit creation and detail, QA correction, review candidates, quality analytics, proxy readiness, and debug/replay controls.
- **Deployment and configuration:** environment bounds, Vite/esbuild packaging, current Node deployable, and the documented future Cloudflare Worker/Queue/Container split.

Load the corresponding file in `docs/ai/domains/` for modification points and focused validation.

## Data model and persistence

`src/types.ts` is the shared contract. Important types are `StorefrontAudit`, `EvidenceBundle`, `TrackingRequestEvidence`, `QaFeedback`, and the status unions. Evidence is split into `page`, `network`, `consent`, `product`, `server_side`, and `runtime` sections.

`src/db.ts` creates or extends three PostgreSQL tables at startup:

- `storefront_audits_v2`: lifecycle, findings, trace, evidence, confidence, reason/fingerprint/consistency data, QA state, runtime metrics.
- `audit_qa_feedback`: per-audit reviewer verdict, category, expected value, notes, timestamp; cascades on audit deletion.
- `scanner_proxy_health`: per-geo/port counters, latency, consecutive errors, quarantine, and success state.

The same class has a process-local memory implementation for explicit disposable development. Runtime DDL is the current schema mechanism; there is no separate migrations directory.

## API and authentication

`server.ts` exposes `/api/health` without data access and applies `internalAuth` to all `/api/v1` routes. When `INTERNAL_API_TOKEN` is configured, callers use `Authorization: Bearer ...` or `X-Internal-API-Token`. Production is also expected to sit behind TLS and Cloudflare Access.

Endpoint groups include scan creation/bulk creation/reruns/cancel/delete/list/detail, CSV and debug-package exports, QA feedback/mark-correct, quality metrics/review candidates, deterministic reviewer/replay, proxy readiness/metrics, and queue statistics.

## External integrations

- **Browserless:** remote Chromium via Playwright CDP; the existing provider default context is reused. Optional BrowserQL solve/reconnect is manual only.
- **Decodo:** configured residential proxy URLs and bounded geo/port/session rotation; credentials remain opaque.
- **PostgreSQL:** durable audits, feedback, evidence JSONB, and proxy health.
- **DNS-over-HTTPS:** bounded fallback/consensus when local DNS is unavailable; inspect `src/scanner/navigation.ts` before changing provider semantics.
- **Cloudflare:** currently an operational perimeter and documented target architecture, not implemented repository infrastructure. Future design keeps the live scanner in a Node container and introduces Worker/Queue boundaries.

There is no LLM runtime integration. The Audit Reviewer is deterministic and read-only.

## Build, test, and deploy

- TypeScript targets ES2022 with bundler resolution and no emit. `strict` is not enabled; JavaScript is allowed.
- Vite builds the React/Tailwind frontend. esbuild bundles `server.ts` to CommonJS while leaving packages external.
- Vitest runs the deterministic scanner suite in `src/scanner/scanner-core.test.ts` against sanitized fixtures under `tests/fixtures/`.
- `npm run validate` runs typecheck, full tests, and production build.
- Production starts `dist/server.cjs`; the process listens on `0.0.0.0`, serves `dist/`, and connects to PostgreSQL/Browserless/Decodo.
- No checked-in CI workflow, container definition, Wrangler configuration, or deploy manifest is present in this archive.

## Naming and organization patterns

- Files and non-component modules use kebab-case (`audit-runner.ts`, `status-resolver.ts`); React component files use PascalCase (`Analytics.tsx`).
- Domain types are explicit status unions and interfaces in `src/types.ts`; domain decisions return structured status/confidence/reason data.
- Machine-readable reason and failure codes are uppercase underscore identifiers.
- API paths are versioned under `/api/v1`; database columns use snake_case; TypeScript variables and functions use camelCase.
- Tests group behavior with `describe` blocks; confirmed site-specific observations are sanitized into fixtures while production rules stay site-agnostic.

## Known constraints

- Queue jobs and per-domain cooldowns are process-local; only audit rows and proxy health are durable. Startup recovery marks orphaned active rows failed rather than resuming work.
- Deterministic tests do not model a complete Browserless CDP transport, live storefront behavior, or PostgreSQL integration.
- One confirmed PDP is audited per site, so results are not catalog-wide proof.
- Diagnostic screenshots are stored inline in evidence JSONB and may become expensive at scale.
- Google Ads has a persisted finding field but less parsing depth than GA4/Meta.
- CMP interaction support is intentionally limited to known controls that can be verified.

See `ARCHITECTURAL_RISKS.md` for prioritization; do not treat that list as permission for unrelated refactoring.
