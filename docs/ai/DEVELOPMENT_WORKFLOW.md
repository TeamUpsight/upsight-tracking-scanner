# AI-assisted development workflow

## 1. Frame the task

Record four things before exploring:

- **Goal:** the behavior or artifact to change.
- **Likely context:** user-named files, endpoint, trace code, UI view, or failing test.
- **Constraints:** security, evidence semantics, cost/live-access limits, compatibility.
- **Done when:** observable acceptance criteria and validation.

Choose one primary domain from `docs/ai/README.md`. Read `AGENTS.md`, that domain file, and the user-named files. Add `PROJECT_CONTEXT.md` only for unfamiliar or cross-domain work.

## 2. Use a bounded discovery pass

Start with no more than the likely entry point, its nearest dependency, its nearest caller, and the relevant test/fixture. Search for a symbol, endpoint, reason code, or trace step before opening a large file.

Expand only when evidence shows that the behavior crosses a boundary. Typical paths are:

```text
UI action -> src/App.tsx -> server.ts route -> queue/db/scanner call
scan symptom -> stored trace/evidence -> runner phase -> detector/resolver -> test fixture
replay mismatch -> quality/replay.ts -> detector/resolver -> consistency/fingerprint
database issue -> server route/queue -> AuditDatabase method -> table contract in src/types.ts
```

Do not read all root documents, all fixtures, or all of `audit-runner.ts` merely to become familiar with the project.

## 3. Diagnose before editing

For a bug, state the observed failure, the responsible boundary, and why the current test or invariant did not prevent it. Prefer a sanitized evidence fixture that reproduces the issue offline. Confirm whether the problem is capture, normalization, detection, resolution, consistency, persistence, API presentation, or UI display; fixing the wrong layer commonly creates live/replay divergence.

For a feature, identify the smallest existing extension points and any persisted/API contract impact. Ask or report before a new dependency, broad schema change, new paid integration behavior, widened authorization, or cross-domain redesign.

## 4. Implement a narrow patch

- Edit only files required by the acceptance criteria.
- Reuse the shared parser/resolver/collector rather than adding a phase-specific rule.
- Keep production rules site-agnostic and put site-specific evidence in sanitized fixtures.
- Preserve conservative access/failure semantics and finalize-once behavior.
- Keep secrets and raw sensitive observations out of source, traces, evidence, exports, and tests.
- Do not update generated output directly. Build after source changes when needed.

## 5. Validate proportionally

| Change area | First validation | Add when relevant |
| --- | --- | --- |
| Pure formatter/UI helper | targeted test if present, `npm run typecheck` | `npm run build` for rendered/bundle impact |
| React view or API call | `npm run typecheck`, `npm run build` | manual UI smoke against a safe local API |
| Detector/resolver/evidence/quality rule | targeted Vitest test, `npm run test:regression`, `npm run typecheck` | `npm run replay -- <fixture>` |
| Runner/navigation/proxy/lifecycle | targeted test, regression suite, typecheck | full `npm run validate`; authorized live scan only when explicitly approved |
| API/queue/db/schema | typecheck and relevant deterministic tests | build, local API smoke, non-production PostgreSQL integration |
| Dependency/build/deployment/cross-domain | `npm run validate` | production-like smoke and manual checklist |

Use:

```text
npm test -- src/scanner/scanner-core.test.ts -t "<matching behavior>"
npm run test:regression
npm run typecheck
npm run build
npm run validate
```

Run the full validation command when a change affects multiple domains, shared contracts, persistence, queue/lifecycle, build dependencies, or release readiness. Offline success does not establish live Browserless/Decodo/storefront behavior. Live scans and `benchmark:access` require explicit authorization, configured credentials, and awareness of provider cost/rate limits.

## 6. Handoff cleanly

Report:

- root cause or design decision;
- files changed and why;
- validation run and result;
- validation not run and why;
- remaining operational risk or manual check.

Update the smallest relevant `docs/ai/` file when commands, boundaries, invariants, or risks changed. Do not turn a task handoff into a full repository rewrite.

## Architecture changes

Before implementation, produce a short impact note covering current flow, proposed boundary, affected persisted/API contracts, migration/rollback approach, failure semantics, security/cost effects, and validation. Read all affected domain files plus `ARCHITECTURAL_RISKS.md`. For queue/container/Cloudflare work, also read `DEPLOYMENT.md`; for access changes, read `ACCESS_RELIABILITY.md`.
