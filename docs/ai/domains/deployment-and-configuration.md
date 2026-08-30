# Domain: deployment and configuration

## Responsibility

Owns the environment contract, build artifacts, current Node production unit, operational secrets/bounds, and the planned migration toward a Cloudflare front/queue/container architecture. It does not authorize dependency upgrades, infrastructure changes, or paid integration enablement by itself.

## Primary files

- `.env.example` — complete documented environment surface and safe defaults.
- `package.json`, `package-lock.json` — scripts and dependency state.
- `tsconfig.json` — ES2022/bundler/no-emit TypeScript settings.
- `vite.config.ts`, `index.html`, `src/index.css` — frontend build and Tailwind integration.
- `server.ts` — development Vite middleware, production static serving, bind/port/bootstrap.
- `DEPLOYMENT.md` — current deployable unit and staged Cloudflare target.
- `ACCESS_RELIABILITY.md` — provider/authorization/cost-sensitive operational constraints.
- `README.md` — current setup and command surface.

## Configuration groups

- Runtime/API: `NODE_ENV`, `PORT`, `INTERNAL_API_TOKEN`.
- PostgreSQL: `DB_*`; explicit local `USE_MEMORY_DB`.
- Browserless: host/token/route/session timeout/proxy mode and opt-in difficult-site controls.
- Decodo: geo proxy URLs, bounded ports/country fallbacks, optional rotating gateway.
- Egress/health: probe URL/salt/quarantine thresholds.
- Authorized sites: exact domains and first-party document header name/value.
- Queue/scanner: concurrency, audit timeout, retry counts, DOM timeout, jitter/cooldowns, batch/upload/stale limits.

Use `src/shared/config.ts` and caller-specific minimum/maximum bounds when adding numeric settings. Use `.env.example` for names; never copy real `.env` values into code, docs, traces, queue messages, or build variables.

## Current build and runtime

`npm run build` runs Vite for frontend assets and esbuild for a CommonJS Node bundle at `dist/server.cjs` with external packages. `npm run start` serves `dist/` from Express, initializes PostgreSQL/proxy health/recovery, and connects externally to Browserless and Decodo as audits run. Production must not use memory storage and should be behind TLS, Cloudflare Access, and the internal API token.

`dist/` and `node_modules/` are generated/installed content. The archive has no CI, Dockerfile, Wrangler file, or infrastructure-as-code manifest.

## Documented target architecture

The intended migration separates a Worker/static UI/API/queue producer from a Cloudflare Queue and a Node scanner Container, preserving the tested Playwright CDP runtime. PostgreSQL remains initially, with Hyperdrive where appropriate; larger artifacts may move to R2. Queue delivery must be idempotent and timeout/visibility budgets must remain distinct.

Follow `DEPLOYMENT.md` sequence: extract the queue/job contract, containerize and prove one live audit, add the Worker/Queue boundary, then add idempotency, DLQ, database connectivity, artifact storage, and Git-triggered deployment. Confirm current Cloudflare product/account limits before implementation.

## Common modification points

- New environment variable: `.env.example`, bounded parser/caller, documentation, secret classification, deploy configuration.
- Build change: package script and Vite/esbuild config; regenerate/verify `dist` rather than editing it.
- Containerization: preserve Node/Playwright/Browserless behavior, graceful cancellation, 90-second-class budget, and secrets outside the image.
- Queue migration: extract a stable `AuditJob`/queue interface and terminal/idempotency semantics before changing providers.
- Production auth: enforce the intended token/perimeter posture and add a deployment check.

## Validation

```text
npm ci
npm run validate
npm run start
```

Use a production-like smoke for static UI, health, unauthorized/authorized API behavior, and startup failure behavior. Database/provider/container checks require non-production resources and explicit authorization. Confirm secret absence in artifacts and debug output.

## Pitfalls and invariants

- Keep Browserless session timeout at least as large as the audit timeout.
- Never silently bypass the selected geo proxy or fall back to memory in production.
- Queue messages should contain audit identity and non-sensitive options only.
- Do not place secrets in committed Wrangler variables, images, logs, traces, evidence, or artifact names.
- Worker execution is not a substitute for the long-lived Playwright/CDP scanner runtime.
- Align queue/container concurrency with Browserless, proxy, and database capacity.
- Do not combine queue, database, and detector redesign in one migration step.
