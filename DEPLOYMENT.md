# Deployment

## Current deployable unit

Today the repository builds a Vite frontend and a bundled Node/Express server. The Node process owns the temporary in-memory queue adapter and connects externally to PostgreSQL, Browserless CDP, and Decodo.

```powershell
npm ci
npm run validate
$env:NODE_ENV='production'
npm run start
```

Required production values are documented in `.env.example`. Do not set `USE_MEMORY_DB=true` in production. Put the service behind TLS and Cloudflare Access, set `INTERNAL_API_TOKEN`, and use a platform secret store for database, Browserless, and proxy credentials.

Deploy source plus `package.json` and `package-lock.json`, never `node_modules/`, `dist/`, or `.env`. Run `npm ci` on the Linux/Cloudflare target so optional native binaries match that platform, then run `npm run build` (or `npm run start`, which rebuilds first). A source handoff created with `git archive` honors `.gitattributes` and excludes `.env`, `node_modules`, and `dist`.

Each build records `scanner_version`, `build_commit` when CI or Git makes it available, and `build_timestamp`. `/api/health`, `scan_started` traces, Evidence Bundles, and debug packages expose that provenance without exposing secrets.

For storefronts owned by the team, use the narrowly scoped authorization pattern in `ACCESS_RELIABILITY.md`. Do not create broad WAF bypasses and do not send audit credentials to third-party storefronts.

The production build emits:

```text
dist/index.html and frontend assets
dist/server.cjs
```

## Target Cloudflare architecture

```text
GitHub main
  -> Cloudflare Workers Builds
  -> Worker: static UI, internal auth, API, queue producer
  -> Cloudflare Queue (bounded concurrency, retry, DLQ)
  -> scanner Container: Node + Playwright CDP orchestration
  -> Browserless /stealth -> Decodo residential proxy -> storefront

Worker or internal result callback
  -> existing PostgreSQL through Hyperdrive where appropriate
  -> optional R2 for larger diagnostic artifacts/screenshots
```

This split preserves the tested Node/CDP runtime. Do not move the live Playwright session into a Worker merely to reduce components.

Cloudflare currently documents [Git-triggered Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [Queues with push or HTTP pull consumers](https://developers.cloudflare.com/queues/reference/how-queues-works/), [Containers controlled by Workers](https://developers.cloudflare.com/containers/), [durable Workflows](https://developers.cloudflare.com/workflows/), and [Hyperdrive for existing PostgreSQL](https://developers.cloudflare.com/hyperdrive/). Confirm account availability and current limits before implementation.

## Recommended migration sequence

1. Extract the current domain-aware `AuditJob` contract and queue interface into their own modules; keep `runStorefrontAudit()` unchanged and preserve cooldown/idempotency semantics.
2. Containerize the existing production Node scanner and prove one manual Browserless/Decodo audit with graceful cancellation and a 90-second budget.
3. Add a small Worker that serves the UI, enforces Cloudflare Access plus the internal API token, validates requests, and publishes audit IDs to a Queue.
4. Choose the consumer model after a load test:
   - Queue consumer Worker invoking a scanner Container; or
   - an HTTP pull consumer in the scanner runtime when explicit backpressure is preferable for long jobs.
5. Make queue delivery idempotent. Cloudflare Queues use at-least-once delivery, so an audit ID must not start or finalize twice.
6. Keep PostgreSQL initially. Put Worker-originated queries behind Hyperdrive; avoid a database migration during scanner stabilization.
7. Store large debug screenshots/packages in R2 only when database evidence size becomes operationally uncomfortable.
8. Add a dead-letter queue and surface failed job IDs as Review Candidates.
9. Connect the single `main` branch to Workers Builds. For a Worker using Containers, production must use a full `wrangler deploy` so changed images roll out; preview version uploads do not update container images.

## Concurrency and timeouts

Begin with scanner concurrency 3, one PDP per audit, one proxy retry for bulk jobs, CAPTCHA disabled for bulk jobs, and a 90-second audit budget. Queue concurrency and container concurrency must agree; otherwise a rapidly scaling queue can overload Browserless, proxies, or PostgreSQL even when the scanner itself is bounded.

Treat the queue visibility/retry budget separately from the scanner timeout. A timed-out audit must finalize as `scan_timeout`; a redelivered job must see that terminal database state and acknowledge without rescanning.

## Secrets and data boundaries

- Worker secrets: internal API token, database/Hyperdrive binding configuration, internal container callback secret.
- Container secrets: Browserless token and Decodo proxy URLs.
- Never place secrets in Wrangler variables committed to Git, queue message bodies, traces, Evidence Bundles, or debug ZIP filenames.
- Queue messages should contain the audit ID and non-sensitive execution options only.

## Git deployment workflow

The intended internal workflow stays simple:

```text
edit
  -> npm run validate
  -> one manual validation audit
  -> commit
  -> push main
  -> Workers Builds runs the configured production deploy
```

No staging/main branch system is required. A manual local validation remains important because deterministic replay cannot validate Browserless, proxy, storefront, or consent-interaction behavior.
