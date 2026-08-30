# ChatGPT and Codex session strategy

The repository is compact enough that a session per tiny fix would waste continuity, but its scanner, queue/data, quality, UI, and deployment concerns are different enough that one permanent mega-session would accumulate irrelevant history. Use durable files for repository memory and focused sessions for active work.

## Persistent architecture and context session

Use for cross-domain design, architectural decisions, context-document maintenance, and prioritizing risks. Read `AGENTS.md`, `PROJECT_CONTEXT.md`, `ARCHITECTURAL_RISKS.md`, and only the domain files touched by the decision.

Do not use it for ordinary implementation logs or repeated small UI/parser fixes. Retire or fork a clean session after a major architecture milestone, when the active history is dominated by completed work, or when assumptions in the session predate the context documents.

## Domain sessions

Maintain a focused session while a stream of related work is active:

| Session | Typical work | Context |
| --- | --- | --- |
| Scanner runtime and access | Browserless, DNS, navigation, PDP discovery, proxy retries, lifecycle | `domains/scanner-runtime.md`; add `ACCESS_RELIABILITY.md` for operational changes |
| Detection and evidence | GA4/Meta/CMP, Evidence Bundle, product/server-side status | `domains/detection-and-evidence.md`; add one fixture/test |
| Quality and replay | consistency, QA scoring, metrics, debug/reviewer, corpus | `domains/quality-and-replay.md`, `QUALITY_SYSTEM.md` when needed |
| API, queue, and persistence | endpoints, scheduling, recovery, PostgreSQL/memory | `domains/api-queue-and-persistence.md` |
| Operations UI | audit workspace, dashboards, forms, styling | `domains/operations-ui.md` |
| Deployment and configuration | build/runtime config, container/Cloudflare migration | `domains/deployment-and-configuration.md`, `DEPLOYMENT.md` |

A domain session should not become the default place for unrelated work. Retire it after the workstream ships, its remaining context is stale, or a new task changes the domain architecture enough to deserve a clean baseline.

## Feature sessions

Create a temporary feature session for a moderately large deliverable that crosses two or more domains but has a clear acceptance boundary—for example, durable queue extraction plus API/UI status. Begin with `AGENTS.md`, `PROJECT_CONTEXT.md`, the affected domain files, and a written impact/validation plan.

Keep unrelated maintenance out. Close the session when acceptance criteria pass and durable decisions are reflected in `docs/ai/`; do not retain it as a second architecture session.

## Maintenance and bug-fix sessions

Keep a small bug in an existing domain session when its context is current, the same subsystem is already active, and the new issue will not be buried by history. Start a clean bug-fix session when the issue is unrelated, security-sensitive, based on a new evidence package, or the prior session contains multiple abandoned hypotheses.

For a fresh bug session, provide the symptom, audit/trace/reason code, likely files, one relevant domain context file, and the acceptance criteria. Avoid pasting entire logs or debug packages; provide the smallest sanitized evidence needed to reproduce.

## Session hygiene

- Repository knowledge belongs in `AGENTS.md` and `docs/ai/`, not only in chat history.
- At the end of meaningful work, update durable context only for facts that future tasks need.
- Start a new session when context is stale or noisy; do not ask a new session to reconstruct history that belongs in a context file.
- Do not paste `.env`, credentials, raw cookie values, complete debug archives, or unnecessary full source files into a conversation.
