# Reusable session-start prompts

Replace bracketed placeholders. Attach or mention only the smallest relevant evidence.

## A. General development task

```text
Work on this repository with minimal context and a minimal patch.

Read AGENTS.md first. Then read only docs/ai/domains/[DOMAIN FILE].md and any context file AGENTS.md explicitly requires for this task. Inspect the files I name before searching. Do not broadly inventory the repository, read node_modules/dist/.env, refactor unrelated code, upgrade dependencies, or edit generated output.

TASK:
[TASK]

DOMAIN:
[DOMAIN]

LIKELY RELEVANT FILES:
[FILES OR SYMBOLS]

ACCEPTANCE CRITERIA:
[OBSERVABLE DONE CONDITIONS]

Make the smallest change necessary, preserve existing architectural invariants, run the narrowest relevant tests/typecheck/build, and report both completed and omitted validation.
```

## B. Bug fix

```text
Diagnose and fix this bug with bounded exploration.

Read AGENTS.md and docs/ai/domains/[DOMAIN FILE].md. Start with the named trace/evidence, likely files, and matching test or fixture. Do not search the whole repository unless those files show the bug crosses a boundary.

BUG / OBSERVED RESULT:
[SYMPTOM, ERROR, REASON CODE, OR TRACE STEP]

EXPECTED RESULT:
[EXPECTED BEHAVIOR]

LIKELY FILES / EVIDENCE:
[FILES, AUDIT ID, SANITIZED FIXTURE, OR SYMBOL]

Workflow: (1) inspect likely files, (2) identify and explain the root cause and responsible layer, (3) state the minimal fix, (4) implement it without unrelated refactoring, and (5) run targeted validation. For a classification bug, prefer a sanitized regression fixture and confirm live/replay rules remain shared.
```

## C. Feature development

```text
Implement this feature without loading unrelated project context.

Read AGENTS.md, docs/ai/PROJECT_CONTEXT.md, and only the affected domain file(s). Identify existing extension points and persisted/API contract effects before editing. Ask or report before adding dependencies, changing schemas broadly, widening access, or enabling paid/live integration behavior.

FEATURE:
[FEATURE]

AFFECTED DOMAINS:
[DOMAINS]

LIKELY ENTRY POINTS:
[FILES / ENDPOINTS / COMPONENTS]

ACCEPTANCE CRITERIA:
[CRITERIA]

Propose a short scoped plan, implement the smallest coherent change, add focused coverage, and validate proportionally. Update durable AI context only if architecture, commands, or boundaries changed.
```

## D. Architecture change

```text
Analyze this potential cross-domain architecture change before implementation.

Read AGENTS.md, docs/ai/PROJECT_CONTEXT.md, docs/ai/ARCHITECTURAL_RISKS.md, the affected domain files, and the relevant existing architecture/deployment document. Broader exploration is allowed only across affected boundaries.

PROPOSED CHANGE:
[CHANGE]

DRIVER / PROBLEM:
[WHY]

CONSTRAINTS:
[COMPATIBILITY, SECURITY, COST, DELIVERY]

DONE WHEN:
[DECISION OR IMPLEMENTATION CRITERIA]

Map the current flow, affected contracts/data, failure and rollback behavior, migration sequence, security/cost impact, and validation. Separate confirmed repository facts from recommendations. Do not implement until the impact and scope are explicit.
```

## E. UI tweak

```text
Make this small UI change with aggressively limited context.

Read AGENTS.md and docs/ai/domains/operations-ui.md. Inspect only the named component/section, its nearest helper, and src/index.css if theme behavior is involved. Do not inspect scanner internals, database code, fixtures, node_modules, or dist unless the UI contract proves they are relevant.

UI CHANGE:
[CHANGE]

LOCATION:
[COMPONENT / VIEW / LINE OR SCREEN AREA]

ACCEPTANCE CRITERIA:
[VISUAL AND INTERACTION CRITERIA]

Preserve existing Tailwind/theme patterns and accessibility behavior. Avoid redesigning adjacent UI. Run npm run typecheck and npm run build unless a narrower justified check is available, and state whether visual smoke testing was performed.
```
