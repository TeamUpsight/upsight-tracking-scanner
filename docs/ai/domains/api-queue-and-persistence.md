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

- Scan lifecycle: create single/bulk, bulk rerun, diagnostic/difficult rerun, list/detail, cancel, bulk delete.
- Results and QA: CSV export, debug package, QA feedback, mark correct.
- Quality: metrics, review candidates, deterministic review, replay.
- Operations: proxy metrics/readiness and queue state.
- `/api/health` is public and intentionally minimal; `/api/v1` is protected when `INTERNAL_API_TOKEN` is set.

The UI sends Bearer authentication through `src/ui/api.ts`. The server also accepts `X-Internal-API-Token`. Input controls include JSON byte limits, in-memory Multer upload, CSV parsing/deduplication, allowed geo/mode, maximum batch size, and bounded environment values.

## Queue and lifecycle

`InMemoryAuditQueue` stores pending jobs, active IDs/domains, and per-domain cooldowns. It enforces global concurrency and one active job per domain, adds bulk jitter, runs `runStorefrontAudit` with an abort timeout, persists proxy metrics, applies cooldowns after rate-limit/bot/access outcomes, and performs a guarded fallback failure write if execution escapes the runner finalizer.

On startup and every minute, `recoverStaleAudits` marks orphaned pending/scanning rows terminal and high priority when no worker/queue entry exists. It does not resume work.

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
