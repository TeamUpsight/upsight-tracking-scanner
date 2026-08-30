# Architecture

## Runtime flow

```text
Bounded queue
  -> Browserless CDP session (stealth route + configured Decodo proxy)
  -> evidence capture
  -> normalized Evidence Bundle
  -> shared detectors
  -> status resolvers
  -> cross-module consistency checker
  -> finalized audit result
  -> QA, reviewer, debug export, and offline replay
```

The browser layer records facts. It does not independently write final conclusions. The same detector/resolver functions are used by live scans, tests, API replay, and CLI replay.

## Entry points

- `server.ts`: Express API, internal authentication, bounded queue adapter, emergency stale recovery, static production UI.
- `src/scanner.ts`: compatibility facade for the scanner runner and parsers.
- `src/scanner/audit-runner.ts`: live orchestration and the only standard finalization path.
- `src/App.tsx`: internal operations UI.
- `scripts/replay.ts`: offline rule-pack execution.

## Scanner modules

```text
src/scanner/
  audit-runner.ts                 live audit orchestration
  browser-session.ts              default Browserless context reuse
  browserless-bql.ts              opt-in solve/reconnect session handoff
  authorized-access.ts            first-party document-only authorization
  navigation.ts                   DNS consensus and ordered access classification
  evidence/evidence-collector.ts  bounded normalized capture
  tracking/ga4.ts                 one GA4 parser
  tracking/meta.ts                one Meta parser
  consent/detect-cmp.ts           multi-signal CMP detector
  consent/consent-state.ts        verified consent-state transitions
  server-side/classify-collection.ts
  proxy/decodo.ts                 validated proxy/session/port rotation
  resolver/status-resolver.ts     product, consent, and overall semantics
  resolver/lifecycle.ts           finalize-once guard
  quality/                        consistency, replay, fingerprints,
                                  sanitization, metrics, debug, reviewer
```

## Browser and page lifecycle

The runner connects with `chromium.connectOverCDP()` and reuses `browser.contexts()[0]` when Browserless provides it. Homepage consent and PDP work share that context. Request/response observers are attached to the context before navigation, include service-worker traffic, and stay active through hydration, consent callbacks, PDP navigation, and the bounded post-load window. The PDP phase observes for at least 5 seconds so slower consent-gated tags can initialize, up to 12 seconds when valid product evidence has not yet appeared.

Target navigation waits for main-document commit and treats `DOMContentLoaded` as a soft readiness signal. This preserves a valid response on storefronts whose scripts delay that event. Language, timezone, and Accept-Language are aligned to the configured/observed proxy country before target navigation.

The runner audits one confirmed PDP. Discovery first collects the established product-shaped paths (`/products/`, `/product/`, `/item/`, `/p/`, and `/shop/`) from homepage links and product sitemaps and randomizes that pool. It rejects comparison routes when the second path segment contains `-vs-` or `compare`. Only when the established pool is empty does it fall back to safe internal URLs with exactly two pathname levels. Product signals are assessed after initial readiness and reassessed after the bounded hydration window. The runner may try up to six candidates, but retains one PDP as the audit target. Out-of-stock evidence rejects a candidate only when no valid URL-matched GA4 `view_item` was captured for that candidate.

## HTTP and proxy behavior

`429`, `403`, `407`, `408`, `423`, `425`, `451`, and `5xx` responses are invalid storefront observations. Classification checks 407 and 429 before bot challenge evidence, then generic blocked statuses. A `429`, homepage browser-navigation exception, or proxy tunnel failure receives a bounded retry with a new Decodo session and, when configured, the next port. PDP tunnel failures use the same bounded retry budget and reconnect before another candidate is attempted. Bulk audits allow one proxy retry; manual audits allow two by default. Retry-After is retained and bounded. EU sessions rotate only through configured real country codes (`de,nl,fr,it,es` by default). Rotating gateway and Browserless-provider fallbacks are opt-in.

Concurrent sessions receive round-robin starting ports. Transport errors update durable per-port health; repeatedly failing ports are quarantined. Queue scheduling prevents the same domain from running concurrently and applies jitter/cooldowns after 429, bot, or access failures.

Cross-domain storefront migrations are accepted only from a bounded, HTTPS, server-redirect chain with a valid final response. The final host becomes the effective first-party collection scope and the decision is retained for QA.

Proxy usernames retain configured parameters and `sessionduration`; credentials are never synthesized or written to trace/evidence.

## Evidence Bundle

Every V2 audit stores versioned, bounded facts in:

```text
page        DNS/access evidence, redirects, observed URL/domain, CMS signals
network     parsed tracking requests, error statuses, novel endpoints
consent     DOM/script/network/cookie/global/iframe signals and interaction facts
product     PDP candidates, tested URL, navigation, GA4/Meta product hits
server_side collection counts, strict duplicates, collector-cookie facts
runtime     module/session duration, geo/egress, retry/port/request/evidence metrics, screenshots
```

Normal mode retains compact detector inputs. Diagnostic mode raises bounded retention limits and captures homepage/PDP screenshots. Query strings are parsed into a minimal field set; raw authorization headers, API tokens, proxy credentials, cookie values, and full sensitive URLs are not persisted.

## Detection boundaries

- GA4 installation, collection, and ecommerce `view_item` are separate findings.
- `GTM-*` alone is not GA4. Generic `/collect` alone is not GA4.
- Meta collection from any phase remains global evidence.
- OneTrust requires provider-specific evidence; `eupubconsent-v2` is only generic IAB TCF evidence.
- Fides is identified from provider-specific DOM, script, cookie, or global evidence before compatibility globals such as `OptanonWrapper` are considered. TrustArc enablement uses its actual Cookie Preferences and Accept All controls and verifies the resulting provider cookie state.
- Shopify Privacy requires combined evidence; `Shopify.trackingConsent` alone is insufficient.
- First-party script hosting is not collection. A qualifying first-party collector must actually receive a parsed tracking request.
- Mixed first- and third-party collection is not a misconfiguration by itself.
- Duplicate collection requires matching vendor, event, measurement/pixel ID, page context and available client/session IDs within 1,500 ms.

## Lifecycle invariants

All ordinary paths reach one `scan_finalized` event through `FinalizeOnce`.

- Manual abort -> `scan_status=cancelled`, `error_category=cancelled`.
- Timeout -> `scan_status=failed`, `error_category=scan_timeout`.
- Invalid access -> failed/inconclusive; absence findings remain inconclusive or not tested.
- A later failure does not erase already completed module evidence.
- `stale_scan_recovered` is only an emergency process-restart recovery and never mutates a finalized audit.

The consistency checker corrects impossible combinations before persistence and raises QA priority.

## Storage and queue boundaries

`AuditDatabase` owns persistence; detector code has no database dependency. PostgreSQL is the default durable store. In-memory storage exists only when `USE_MEMORY_DB=true` is explicitly configured.

`InMemoryAuditQueue` currently owns bounded, domain-aware scheduling, not detection. Jobs carry audit identity and execution options, so it can later be replaced by Cloudflare Queues or Workflows without changing scanner-core functions. Per-domain cooldowns are process-local; durable proxy health is stored separately.

## API security

When `INTERNAL_API_TOKEN` is configured, all `/api/v1` data and mutation endpoints require the token. `/api/health` exposes only service and queue health. API error responses are generic; secrets and debug contents are sanitized. Production should additionally be placed behind Cloudflare Access.
