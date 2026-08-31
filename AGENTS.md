# Upsight Tracking Scanner: agent instructions

## Start here

- Read this file, then load only the context needed for the task:
  - system overview: `docs/ai/PROJECT_CONTEXT.md`
  - path lookup: `docs/ai/REPO_MAP.md`
  - task procedure and validation: `docs/ai/DEVELOPMENT_WORKFLOW.md`
  - domain detail: `docs/ai/domains/`
- Inspect user-named and domain-map files before searching elsewhere. Use narrow symbol or path searches; do not inventory the whole repository by default.
- Treat source, tests, stored evidence, and runtime traces as truth when older prose differs.

## Product and stack

This internal tool audits ecommerce storefront tracking from bounded browser evidence. A React 19/Vite/Tailwind UI calls an Express API. The Node scanner connects to Browserless over CDP through configured Decodo proxies, stores normalized evidence and results in PostgreSQL, and reuses deterministic detectors/resolvers for live runs, tests, and offline replay. Explicit `USE_MEMORY_DB=true` is local-only.

## High-value paths

- `server.ts`: API, optional shared-token auth, process-local queue, recovery, exports, static serving.
- `src/db.ts`: PostgreSQL/memory persistence and startup-time schema creation/extensions.
- `src/scanner/audit-runner.ts`: browser lifecycle and live orchestration; highest-risk file.
- `src/scanner/evidence/`, `tracking/`, `consent/`, `server-side/`, `resolver/`: evidence-to-decision pipeline.
- `src/scanner/quality/`: replay, consistency, QA priority, metrics, sanitization, debug export, reviewer.
- `src/types.ts`: persisted and API-facing contracts.
- `src/App.tsx`, `src/ui/`, `src/index.css`: operations UI and local view state.
- `src/scanner/scanner-core.test.ts`, `tests/fixtures/`: deterministic regression coverage.

## Working rules

- Make the smallest change necessary. Do not refactor unrelated code, rename files, upgrade dependencies, or alter architecture unless the task requires it.
- Reuse existing abstractions and central parsers/resolvers before adding another path. Production rules must be generic; site names belong in sanitized fixture descriptions, not detector logic.
- Preserve the core boundary: browser code captures facts; shared detectors/resolvers produce conclusions. Live scan and replay must not develop different decision rules.
- Access failure, blocking, timeout, or incomplete evidence must never become a confident absence finding. Prefer `inconclusive` or `not_tested` according to existing semantics.
- Preserve one ordinary finalization path through `FinalizeOnce`, ordered persistence, and exactly one `scan_finalized` trace event.
- Keep evidence bounded and sanitized. Never persist or log tokens, proxy credentials, authorization headers, cookie values, raw proxy IPs, or unnecessarily complete sensitive URLs.
- Keep difficult-site escalation manual and opt-in. Do not enable challenge solving or paid provider fallbacks for bulk scans.
- Maintain exact-domain, top-level-document-only behavior for authorized access headers. Never broaden it to third-party assets or redirects.
- Ask or report before broad architectural changes, schema redesigns, new production dependencies, paid live scans, or changes to security/access boundaries.

## Configuration and generated content

- Use `.env.example` for configuration names and safe defaults. Do not read, print, copy into documentation, commit, or edit `.env` values unless the user explicitly requests configuration work.
- Do not manually edit `node_modules/`, `dist/`, debug ZIP contents, generated benchmark outputs, or other runtime exports.
- Treat `package-lock.json` as generated dependency state; change it only through an intentional dependency operation.
- `dist/` contains the Vite assets and bundled `dist/server.cjs`; regenerate it with `npm run build`.

## Commands and validation

Requires Node.js 20+ and npm.

```text
npm run dev
npm run typecheck
npm test -- src/scanner/scanner-core.test.ts -t "<test name>"
npm run test:regression
npm run replay -- <evidence-file-or-folder>
npm run build
npm run validate
```

- Prefer the narrowest relevant test, then `npm run typecheck` for TypeScript changes.
- Run `npm run test:regression` for detector, resolver, evidence, access-classification, proxy, lifecycle, or quality-rule changes.
- Add or update a sanitized regression fixture before fixing a confirmed classification bug.
- Run `npm run build` for UI, server bootstrap, build configuration, or production-bundle changes.
- Use `npm run validate` for cross-domain, release, dependency, schema, queue, or high-risk changes. Do not run live Browserless/Decodo scans or access benchmarks without explicit authorization and suitable credentials/cost approval.
- Report what was and was not validated. Offline tests cannot prove Browserless, proxy, storefront, consent-interaction, or PostgreSQL integration behavior.

## Context economy

- Normally exclude `node_modules/`, `dist/`, `package-lock.json`, `.env`, and binary/debug artifacts from searches.
- Do not read all of `src/scanner/audit-runner.ts`, `src/App.tsx`, `server.ts`, `src/db.ts`, the regression test, or fixture corpus unless the task spans those files. Search for the relevant symbol/phase/endpoint first and inspect a bounded region.
- Do not reread every root document. Use `docs/ai/README.md` to select the authoritative context file, then consult historical handoff or deployment prose only when relevant.

## Documentation maintenance

When architecture, commands, domain ownership, invariants, or known risks change, update the smallest relevant file under `docs/ai/`. Keep this root file concise; add a nested `AGENTS.md` only when a subtree develops genuinely different commands or safety rules.

## Git delivery

- After completing a code change, inspect the diff, run the proportionate validation above, and create a Git commit before handoff unless the user explicitly asks not to commit.
- Stage only files changed for the current task; never include pre-existing or unrelated working-tree changes. Use `git diff --check` before staging.
- Format every commit with a summary (the subject line) that names the affected domain(s) or the Codex task/chat name, followed by a short description in the commit body explaining the change and its purpose. Keep the summary concise and imperative.
- Push the new commit to the configured upstream after committing when remote access is available. If a push fails, keep the local commit intact and report the exact blocker plus the command needed to retry.
- Never amend, rebase, force-push, or commit secrets, generated artifacts, `.env` files, or credentials unless the user explicitly authorizes that action.
