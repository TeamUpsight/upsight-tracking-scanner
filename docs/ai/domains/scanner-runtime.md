# Domain: scanner runtime and access

## Responsibility

Owns a live audit from validated domain/job input through Browserless connection, geo/proxy setup, DNS and navigation, consent observation/action, PDP discovery, evidence capture phases, retry/cancellation/time budgets, and standard finalization. It does not own API scheduling, database implementation, or final rule semantics in isolation.

## Primary files

- `src/scanner/audit-runner.ts` — `runStorefrontAudit`, phase orchestration, listeners, trace, budgets, retries, finalization.
- `src/scanner/browser-session.ts` — reuse the provider-created context and align locale/timezone.
- `src/scanner/navigation.ts` — DNS consensus, Retry-After, ordered access/bot classification.
- `src/scanner/proxy/decodo.ts` — validation, country/session/port rotation, persistent-health events, safe trace summaries.
- `src/scanner/browserless-bql.ts` — opt-in BrowserQL solve/reconnect handoff.
- `src/scanner/authorized-access.ts` — exact-domain, top-level GET/HEAD authorization header injection.
- `src/scanner/evidence/evidence-collector.ts` — runtime capture sink; read the detection domain file before changing its contract.
- `src/scanner/resolver/lifecycle.ts` and `persistence/ordered-updates.ts` — finalize-once and non-regressing writes.
- `src/scanner/version.ts` — scanner/rule-pack versions and PDP observation constants.

## Flow and dependencies

`server.ts` creates an audit row and queues a job. The queue calls `runStorefrontAudit` with an update callback, abort signal, scan mode, bulk/manual flags, and proxy metric callback. The runner resolves the host, connects over Playwright CDP, reuses the Browserless context, attaches context-level observers before navigation, inspects homepage/consent, selects one valid PDP, observes tracking through hydration, classifies server-side evidence, and finalizes through the shared replay/consistency path.

It depends on configuration from `.env.example`, contracts in `src/types.ts`, decision modules in tracking/consent/server-side/resolver/quality, and external Browserless/Decodo/DNS behavior. It must remain storage-agnostic beyond the supplied update callback.

The homepage and PDP now form one shared evidence session: context observers attach before the first navigation, homepage capture and PDP discovery overlap, and PDP navigation preserves the unanswered consent state. After the bounded homepage settle, shared Consent capture runs as its own task against the validated storefront page; session replacement must settle that task, and an unproven replacement page cannot author a completed shared observation. Consent V2 Reject runs only after a confirmed PDP (or on the homepage when Tracking is not selected); an optional Accept comparison uses a clean context and the confirmed PDP URL. `audit-runtime-budget.ts` reserves PDP, passive server classification, and finalization time, so optional actions cannot starve required evidence. Positive events remain append-only, while absence decisions require explicit capture-completeness evidence.

### Shared homepage to fresh Consent transport

The canonical homepage connects to Browserless once through `connectOverCDP`. The connection URL is built with the selected Decodo external proxy and country/session parameters, or with Browserless Residential settings when that provider is selected. The runner reuses Browserless's supplied default context for canonical navigation. Consent V2 creates a new Playwright `BrowserContext` on that same connected `Browser` and navigates it independently without storage state. It does not reconnect Browserless, create a new Browserless session, or rebuild proxy parameters. The fresh context inherits the existing browser-session transport; context creation cannot change a browser-level proxy. It gets separate cookies/storage and is fresh for target state, but shares the Browserless browser session and proxy configuration.

Decodo country and port/session selection are made before Browserless connection. The canonical connection owns that transport for the audit; a proxy retry or provider fallback replaces the browser session before later phases. Browserless Residential uses its own sticky country-targeted transport and omits the external Decodo proxy. The fresh Consent context does not independently rotate that transport. A `PROXY_TUNNEL_FAILED` raised from `connectOverCDP` is a connection-boundary failure; the same browser network error from fresh `page.goto` is a target-navigation transport failure before an HTTP response. Neither establishes a target block. An HTTP response or detected challenge is classified through access validation separately. Provider-side tunnel transients and target-specific challenges remain possible and may vary by session.

Fresh Consent traces record only normalized provider, route, proxy mode/country/port, reuse flags, and expected geo. Fresh navigation failures record their lifecycle stage and known error family. They must leave previously completed shared Consent evidence intact, and an unavailable fresh observation must remain inconclusive.

Product candidates carry a bounded page role (`PDP`, `PRODUCT_LISTING`, `NON_PRODUCT`, or `UNKNOWN`) after navigation. Confirmed listings record their evidence, promote at most two strong child product links once, and never receive PDP hydration grace. A confirmed PDP always receives the minimum observation and capture checkpoint; it receives the remaining grace only when no meaningful alternate PDP is queued. Candidate counters are authoritative only at discovery, queue, navigation-start, promotion, and outcome boundaries; `product_runtime` records bounded allocation telemetry without changing canonical replay decisions.

## Common modification points

- Connection/plan errors: `classifyBrowserConnectionError` and bounded connection loop.
- DNS/access/HTTP ordering: `navigation.ts` first, then the caller phase in `audit-runner.ts`.
- Proxy selection, credentials, port health: `proxy/decodo.ts`; never assemble secrets in traces.
- CMP interaction: provider controls in runner plus verification in `consent/consent-state.ts`.
- PDP candidates/hydration/out-of-stock behavior: candidate helpers and product phase in the runner.
- Cancellation/timeout/finalization: abort checks, `FinalizeOnce`, ordered updates, and trace assertions together.
- Difficult-site behavior: `browserless-bql.ts` and manual rerun path; preserve bulk prohibition.

## Validation

Start with a name-filtered block in `src/scanner/scanner-core.test.ts`, then run:

```text
npm run test:regression
npm run typecheck
npm run validate
```

Use an offline replay whenever stored evidence can demonstrate the rule effect. A live scan or `npm run benchmark:access` is a separate, explicitly authorized check requiring configured accounts, cost awareness, and a non-production database.

## Pitfalls and invariants

- Do not create a new browser context when the provider already supplied one; it can lose proxy/profile launch configuration.
- Attach tracking observers before navigation and retain service-worker/context traffic.
- Main-document commit is authoritative; `DOMContentLoaded` is a soft readiness signal.
- Check proxy auth and rate limit before generic bot/access categories.
- Cross-domain redirects require bounded HTTPS server-redirect evidence and change first-party scope only when accepted.
- No valid storefront means no confident absence. Preserve completed module evidence when a later phase fails.
- Ordinary paths must emit one `scan_finalized`; stale recovery is an emergency server concern, not a second normal finalizer.
- Do not broaden authorized headers, log credentials, block trackers/service workers, or enable paid challenge/provider fallback by default.
