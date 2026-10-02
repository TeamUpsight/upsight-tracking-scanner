# Domain: API, queue, and persistence

## Responsibility

Owns the REST boundary, optional internal authentication, request/file validation, audit creation and lifecycle actions, process-local scheduling/cooldowns, emergency stale recovery, result/CSV/debug exports, and PostgreSQL-or-explicit-memory storage.

## Primary files

- `server.ts` — Express composition root, `InMemoryAuditQueue`, route handlers, recovery, static production serving.
- `src/db.ts` — `AuditDatabase`, startup DDL, PostgreSQL queries, local memory behavior, proxy-health persistence.
- `src/types.ts` — audit/evidence/feedback contracts shared with scanner and UI.
- `src/shared/config.ts` — bounded integer environment parsing.
- `.env.example` — auth, database, queue/size/timeout bounds.
- `src/scanner/audit-runner.ts` — execution dependency called by the queue; do not move decision logic into the queue.

## API groups

- Scan lifecycle: create single/bulk, bulk rerun, diagnostic/difficult rerun, paginated summary list/detail, cancel, bulk delete.
- Results and QA: CSV export, debug package, QA feedback, mark correct.
- Quality: metrics, review candidates, deterministic review, replay.
- Operations: proxy metrics/readiness and queue state.
- `/api/health` is public and exposes build provenance and queue counts without audit-domain details. `/api/v1` requires `INTERNAL_API_TOKEN` in production. Production startup also requires Browserless/Decodo configuration and refuses memory/local-browser mode. Bulk debug ZIP reads at most 25 full audit rows per request.

The UI sends Bearer authentication through `src/ui/api.ts`. The server also accepts `X-Internal-API-Token`. Input controls include JSON byte limits, in-memory Multer upload, CSV parsing/deduplication, allowed geo/mode, maximum batch size, and bounded environment values.

Bulk upload mounts `src/bulk-upload.ts` behind the existing `/api/v1` auth. `src/bulk-csv.ts` parses quoted cells and builds one deterministic header map, resolves each row using CSV > multipart/UI > existing defaults, and validates the complete upload before creation. Optional columns are `region` (`geo`, `tested_geos`, `tested_geo`), `exact_country` (`tested_country`, `country`), `mode`, `group_label` (`group label`, `group`), and `modules`; domain-only and legacy first-column files remain supported. Multi-module cells must be quoted, e.g. `"consent,tracking,serverside"`; Server-side aliases normalize through the strict canonical module normalizer. Countries use shared region definitions and `validateExactCountryRequest()` retains the Consent requirement. Mixed-region audits work in one file. First valid duplicate wins; later configurations are never merged. Invalid non-duplicates create/queue zero audits and return at most 50 safe row errors. Success keeps `{ count, duplicates_removed, audits }`. See the README bulk CSV section for examples and public contract.

`GET /api/v1/scans` is a server-paginated summary endpoint: it defaults to `page=1&page_size=25`, caps page size at 100, accepts the existing `filter` and `search` parameters, and never selects audit evidence, trace, or runtime/debug blobs. It returns `{ items, pagination }`, ordered by `scan_started_at DESC, audit_id DESC`. `GET /api/v1/scans/:id` is the explicit on-demand full-detail route; the browser caches an opened audit for the session and deduplicates concurrent detail requests. CSV exports also select only their declared CSV fields.

## Queue and lifecycle

`InMemoryAuditQueue` stores pending jobs, active IDs/domains, and per-domain cooldowns. It enforces global concurrency and one active job per domain, adds bulk jitter, runs `runStorefrontAudit` with an abort timeout, persists proxy metrics, applies cooldowns after rate-limit/bot/access outcomes, and performs a guarded fallback failure write if execution escapes the runner finalizer.

On startup and every minute, persisted pending rows are requeued and stale orphaned scanning rows are safely reset to restart from the audit start. Atomic pending claims prevent concurrent workers from running the same audit; active browser sessions are never resumed mid-page.

Bulk rows persist mode/modules/queue options through `createAudit()` and region/group on the audit. `queueJobForAudit()` reconstructs exact country from `queue_options.tested_country`, mode and modules; execution reads region/group from the claimed audit. Pending and stale projections retain all these fields. `src/bulk-upload.test.ts` verifies this path with in-memory persistence and a mocked queue, without running scanners.

## Persistence model

`AuditDatabase.initialize` manages `storefront_audits_v2`, `audit_qa_feedback`, and `scanner_proxy_health`. Allowed audit update columns are whitelisted. PostgreSQL is required unless `USE_MEMORY_DB=true`; production failure does not silently fall back to memory. Proxy health is durable, but queue/circuit state is not.

## Common modification points

- Request/response change: route validation/handler, shared type, UI caller, and endpoint test/smoke.
- Scheduling/cooldown change: queue methods, environment bound, lifecycle/failure semantics, metrics presentation.
- New stored field: type, audit whitelist, startup schema/migration plan, create/read/update paths, replay/API/UI consumers.
- Schema evolution: assess concurrency, rollback, and deployment ordering before modifying startup DDL.
- Authentication: `internalAuth`, UI fetch wrapper, `.env.example`, README/deployment guidance; fail closed for production intent.

## Validation

```text
npm run typecheck
npm test
npm run build
```

Use `npm run validate` for queue, lifecycle, schema, auth, or cross-domain changes. Add a local API smoke for affected endpoints. PostgreSQL changes require a non-production database check; memory mode cannot establish SQL correctness. Do not run queued live audits without explicit authorization.

## Pitfalls and invariants

- Queue state is process-local and not at-least-once safe by itself; preserve audit IDs and terminal-state checks when extracting a durable queue contract.
- Never allow slow interim writes to overwrite terminal results.
- Keep `/api/health` free of secrets/audit data and keep generic error responses.
- CSV exports protect against spreadsheet formula injection; preserve the leading-character guard.
- Bulk challenge solving remains disabled, and input/concurrency/timeout bounds remain enforced.
- Deletion cascades QA feedback; treat delete endpoints as destructive and keep explicit IDs/validation.
- Do not rely on `USE_MEMORY_DB` behavior to validate PostgreSQL schema or transaction semantics.
