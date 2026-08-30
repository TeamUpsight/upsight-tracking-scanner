# AI context index

Use progressive disclosure. Do not load this entire directory for every task.

1. `../../AGENTS.md` — always-read operational rules.
2. `PROJECT_CONTEXT.md` — architecture and system-wide invariants; read for unfamiliar or cross-domain work.
3. `REPO_MAP.md` — compact path and critical-file lookup.
4. One file under `domains/` — read only for the area being changed.
5. `DEVELOPMENT_WORKFLOW.md` — scope and validation procedure.
6. `SESSION_STRATEGY.md` and `SESSION_PROMPTS.md` — conversation organization and reusable task prompts.
7. `TOKEN_EFFICIENCY.md` — repository-specific context and credit controls.
8. `ARCHITECTURAL_RISKS.md` — prioritized constraints and improvement candidates; these are findings, not authorization to refactor.

## Domain routing

| Task area | Read |
| --- | --- |
| Browser execution, PDP navigation, DNS, proxies, retries, authorized access | `domains/scanner-runtime.md` |
| GA4/Meta/CMP/product/server-side evidence and result semantics | `domains/detection-and-evidence.md` |
| Replay, consistency, QA metrics, reviewer, fixtures | `domains/quality-and-replay.md` |
| REST endpoints, queue scheduling, PostgreSQL/memory storage | `domains/api-queue-and-persistence.md` |
| React workspace, dashboards, API calls, styling | `domains/operations-ui.md` |
| Environment, build, runtime deployment, Cloudflare migration | `domains/deployment-and-configuration.md` |

Root product documentation remains useful for human readers. `ARCHITECTURE.md`, `QUALITY_SYSTEM.md`, `ACCESS_RELIABILITY.md`, `DEPLOYMENT.md`, and `CODEX_HANDOFF.md` provide deeper operational or historical detail; load them only when the task requires that detail.
