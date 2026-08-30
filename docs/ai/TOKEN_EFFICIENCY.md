# Token and credit efficiency

## Repository-specific waste risks

| Source of waste | Why it is expensive or misleading | Handling rule |
| --- | --- | --- |
| `node_modules/` | Thousands of vendor files dominate file search and duplicate public package code. | Exclude it from every normal search. Read package docs/types only for a dependency-specific issue. |
| `dist/` | Minified frontend, bundled server, and source maps duplicate source at high volume. | Never inspect or edit it for source behavior. Rebuild with `npm run build`. |
| `package-lock.json` | Large generated dependency graph; low value for normal product work. | Read only the relevant package entry during dependency resolution/security work. |
| `.env` | Potential secrets plus many values that do not explain architecture. | Use `.env.example` for names/defaults. Never load or quote `.env` values without explicit need and authorization. |
| `src/scanner/audit-runner.ts` | About 1,808 lines and many browser phases; reading it whole crowds out the relevant detector or trace path. | Search by exported function, trace step, phase, reason code, or helper; inspect bounded regions and direct imports. |
| `src/App.tsx` | Dense, multi-view component with forms, polling, actions, and large JSX sections. | Search by view name, endpoint, action handler, or visible copy and inspect the adjacent state/effect/JSX only. |
| `server.ts` | Combines queue, auth, validation, many routes, exports, recovery, and serving. | Start from the endpoint or queue method named by the task; follow only its direct calls. |
| `src/db.ts` | Combines startup DDL, PostgreSQL, and memory behavior. | Start from the specific `AuditDatabase` method and relevant table columns; avoid rereading all DDL. |
| `src/scanner/scanner-core.test.ts` | A large central suite covering unrelated detector, access, proxy, lifecycle, and replay behavior. | Search the matching `describe` or fixture name; run a name-filtered test before the full corpus. |
| `tests/fixtures/` | Mixed URLs, JSON, JSONL, CSV, and binary debug data for unrelated regressions. | Open only the fixture referenced by a test/symptom. Inspect the regression corpus case by name, not the entire history. |
| Debug ZIPs/screenshots/traces | Binary/base64 data and chronological noise can overwhelm the actual failure signal. | Prefer `evidence.json`, selected trace steps, reason codes, and sanitized summaries. Render/open a screenshot only for a visual question. |
| Root documentation overlap | README, architecture, quality, access, deployment, and dated handoff repeat some concepts at different depths/times. | Use `docs/ai/README.md` to pick one authority. Read `CODEX_HANDOFF.md` only for dated operational history/limitations. |
| Live scans/benchmarks | Consume external provider units, wait time, and large evidence; nondeterministic storefronts can produce noisy hypotheses. | Reproduce offline first. Run a targeted authorized live scan only when deterministic evidence cannot answer the task. |

## Default exploration budget

For a scoped task, begin with `AGENTS.md`, one domain file, and roughly three to five likely source/test files. Expand when a direct dependency or failing validation proves another boundary is involved. Do not perform a repository-wide content dump for orientation; `PROJECT_CONTEXT.md` and `REPO_MAP.md` exist to replace that work.

Use high-information searches:

- endpoint or UI copy for API/UI work;
- trace step, failure fingerprint, reason code, or status for scanner work;
- exported function/type for rule changes;
- fixture/test name for regressions;
- `AuditDatabase` method or column for persistence.

## Validation economy

Run a name-filtered deterministic test first, then the domain suite and typecheck. Reserve `npm run validate` for shared contracts, lifecycle/queue/schema/build/dependency changes, cross-domain features, and release readiness. Do not use a live audit merely to confirm code that a replay fixture can prove.
