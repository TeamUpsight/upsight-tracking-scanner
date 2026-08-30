# Architectural risks

These findings describe the inspected archive as of 2026-08-29. They are not authorization to refactor. Reassess against source and runtime evidence before acting.

## P0 — urgent or dangerous

### The distributed archive contains a root `.env`

The ZIP includes `.env` even though the repository ignores `.env*` and the documentation says it contains database, Browserless, proxy, and internal-token credentials. Values were deliberately not inspected. Treat the file as secret-bearing: do not share the archive externally, remove secret configuration from future handoff archives, and rotate credentials if this archive has crossed an untrusted boundary.

## P1 — important

### Queue execution and domain circuits are process-local

`InMemoryAuditQueue` owns pending/active jobs and cooldowns. A restart loses that state; startup recovery marks orphaned rows failed but does not resume work. This also leaves future at-least-once delivery/idempotency behavior undefined until the queue contract is extracted. The documented next step—extract the job/queue boundary before introducing Cloudflare Queues/Containers—is well aligned with the risk.

### Live orchestration is concentrated in one 1,808-line runner

`src/scanner/audit-runner.ts` couples connection, DNS/access, capture listeners, consent interaction, PDP discovery, retries, time budgets, evidence, trace, and finalization. It has valuable helper coverage, but changes can cross lifecycle boundaries unexpectedly. Prefer targeted extraction only as part of an explicit architecture task, and protect each step with replay/guardrail tests and finalize-once assertions.

### Persistence uses startup DDL instead of versioned migrations

`src/db.ts` creates tables and applies `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` during application startup. There is no separate migration ledger, rollback procedure, or deployment-time schema gate. This is convenient for the current unit but becomes risky with multiple instances, destructive changes, or independent deploy cadence. Introduce a migration strategy before material schema evolution.

### Integration coverage stops short of the highest-risk boundaries

The deterministic Vitest suite covers parsers, resolvers, access classification, proxy/lifecycle guardrails, quality logic, and replay, but there is no complete mocked Browserless CDP transport, automated Express endpoint suite, PostgreSQL integration suite, or UI component/e2e suite in the archive. Keep manual non-production checks for live/access/database/UI changes; add focused boundary tests when those areas begin changing frequently.

### Production access control is configuration-dependent

The server listens on `0.0.0.0`; `/api/v1` authentication is enforced only when `INTERNAL_API_TOKEN` is non-empty, and the production perimeter relies on TLS/Cloudflare Access being configured outside this repository. A missing environment value or perimeter rule could expose internal audit data/actions. Deployment validation should fail closed on the intended production authentication posture before broader use.

### Diagnostic screenshots live inline in PostgreSQL evidence

Diagnostic `EvidenceBundle.runtime.screenshots` stores base64 content inside JSONB. This simplifies debug export but amplifies row size, backup cost, list/detail transfer, and database growth. Track evidence size and move large artifacts to object storage before diagnostic volume becomes material.

## P2 — worthwhile improvements

### API, queue, exports, recovery, and serving share `server.ts`

The file is the only composition root but also owns many operational details. The planned queue-contract extraction is the first useful seam. Future decomposition should follow stable responsibilities and preserve endpoint behavior rather than creating a broad rewrite.

### UI contracts are weakly typed and the main component is dense

`src/App.tsx` owns four views and most client state in one component, while quality/proxy/replay responses use `any` in several places. Server response drift can reach runtime without compile-time protection. Add shared response interfaces and extract view-level components incrementally when those areas are modified, not as an unrelated cleanup.

### TypeScript safety is intentionally permissive

`tsconfig.json` does not enable `strict` and allows JavaScript; browser-evaluation and UI/metrics paths contain numerous `any` values. A whole-repository strict-mode switch would be disruptive. Improve types at touched boundaries first and plan strictness as a separate staged change.

### Authentication documentation has one header-name mismatch

The server and README use `X-Internal-API-Token`, while `.env.example` comments say `X-Internal-Token`. This can confuse API clients and support work. Correct the comment in a documentation/configuration task and keep the implemented header as the source of truth unless an intentional compatibility change is designed.

### Current deployment architecture is documented but not codified

The archive has no CI workflow, container definition, Wrangler configuration, or infrastructure manifest. Production repeatability therefore depends on external setup and prose. Add executable deployment configuration during the planned migration, with secrets remaining outside version control.

### Scanner depth is uneven across findings

Google Ads has persisted representation but not GA4/Meta-level parsing depth; one PDP per site cannot establish catalog-wide consistency; unknown/custom CMP interaction remains conservative. These are product limitations, not immediate defects. Prioritize only with explicit accuracy/coverage goals and verified fixtures.

## P3 — optional cleanup

### Regression coverage is centralized in one large test file

The single scanner test is easy to run but increasingly costly to navigate. Split by stable domain only when test growth makes focused ownership materially better; retain shared fixtures and one regression command.

### Documentation can drift through duplication

README, architecture, quality, access, deployment, handoff, and AI context intentionally serve different readers but overlap. Keep `AGENTS.md` operational, use this AI directory for durable navigation, and update the smallest authoritative document rather than copying detailed behavior everywhere.

### The handoff archive has no Git metadata

Without commit history or branch state, provenance and change comparison are limited. Future project handoffs should include a clean Git repository or a commit identifier plus a source-only archive, while excluding credentials and installed/build artifacts.
