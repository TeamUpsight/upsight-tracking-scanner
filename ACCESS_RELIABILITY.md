# Access reliability

The scanner aims for high coverage of public storefronts and explicitly authorized sites. It does not promise universal access and does not disguise access failures as tracking absence. A terminal 429, challenge, DNS failure, or inaccessible origin remains an inconclusive audit.

## Implemented access ladder

1. Resolve A and AAAA records locally. If local DNS is unavailable, Cloudflare and Google DNS-over-HTTPS must independently agree before the scanner concludes NXDOMAIN.
2. Allocate configured Decodo ports across concurrent scans, generate a fresh bounded session, and align language/timezone to the proxy country before target navigation.
3. Reuse Browserless's default CDP context, preserve service workers, and capture network evidence at context level.
4. Verify egress in diagnostic mode. The scanner retains country and, only when a salt is configured, a truncated IP hash—never the raw IP.
5. Navigate to main-document commit, then wait softly for `DOMContentLoaded`. A slow subresource or document event cannot erase a valid committed 200 response.
6. Classify access in strict order: proxy authentication, 429, known challenge evidence, then other blocked HTTP status.
7. Observe a challenge for up to 12 seconds. Manual difficult-site reruns may use the opt-in BrowserQL `solve` + `reconnect` handoff. Bulk scans never solve challenges.
8. On a confirmed Decodo tunnel failure only, retry once with a fresh sticky session and alternate configured port. Individual and diagnostic scans then reconnect through a fresh Browserless Residential `/stealth` CDP session; bulk scans finalize as `proxy_error` and retain a fallback-candidate flag. HTTP 403/429 and bot challenges do not enter this fallback ladder.
9. Accept a cross-domain migration only when an HTTPS redirect chain starts at the submitted domain, consists of redirect statuses, ends in a valid storefront response, and avoids login/challenge paths. The observed domain becomes the collection-classification scope.
10. Persist port health, quarantine repeatedly failing ports, distribute concurrent sessions across ports, and expose sanitized readiness/health APIs.

Browserless documents that Playwright should reuse the provider-created default context because a new context may lose launch/proxy/profile configuration. The scanner follows that pattern. See [Basic Playwright connection](https://docs.browserless.io/examples/playwright-connection) and [Stealth routes](https://docs.browserless.io/baas/bot-detection/stealth).

The manual challenge path uses Browserless's current [`solve` mutation](https://docs.browserless.io/bql-schema/operations/mutations/solve) and [`reconnect` handoff](https://docs.browserless.io/browserql/session-management/reconnect-to-browserless). It defaults to `/chromium/bql`, not `/stealth/bql`, because Browserless documents tracker blocking on the latter; tracker blocking would invalidate an audit. The returned CDP endpoint is authenticated in memory and never logged.

## Configuration and safe defaults

All options are listed in `.env.example`.

- `BROWSERLESS_SESSION_TIMEOUT_MS` must be greater than or equal to `AUDIT_TIMEOUT_MS`.
- `PRODUCT_DISCOVERY_BUDGET_MS=15000` and `PRODUCT_CONSENT_BUDGET_MS=15000` are capped below `AUDIT_TIMEOUT_MS`. They prevent a slow sitemap, PDP, or consent operation from consuming the entire Browserless session; they do not change Decodo, Browserless route, credential, or proxy selection.
- Decodo is the only ordinary/challenge proxy provider. Browserless Residential is used only by the bounded non-bulk fallback; Browserless datacenter mode is not configured or supported.
- `BROWSERLESS_CHALLENGE_SOLVING_ENABLED=true` permits the manual difficult-site BrowserQL handoff. `BROWSERLESS_CHALLENGE_SOLVING_BULK=false` is an invariant: bulk scans never solve challenges.
- `DECODO_MAX_RETRIES_BULK=1` and `DECODO_MAX_RETRIES_SINGLE=1` bound the tunnel retry ladder.
- `BROWSERLESS_RESIDENTIAL_FALLBACK_ENABLED=true` permits individual/diagnostic fallback; `BROWSERLESS_RESIDENTIAL_FALLBACK_BULK=false` keeps bulk scans cost-bounded.
- `DECODO_ENABLE_ROTATING_GATEWAY_FALLBACK=false` keeps the rotating gateway experimental and out of the default path.
- `PROXY_EGRESS_PROBE=true` enables sampling for normal scans; diagnostic scans probe automatically.
- `PROXY_PORT_ERROR_THRESHOLD` and `PROXY_PORT_QUARANTINE_MS` control persistent port quarantine.

Do not enable ad/tracker blocking, service-worker blocking, or request interception that drops analytics traffic. Those features make access look faster while creating false tracking negatives.

## Authorized access for sites you control

Set `AUTHORIZED_SCAN_DOMAINS`, `AUTHORIZED_SCAN_HEADER_NAME`, and `AUTHORIZED_SCAN_HEADER_VALUE`. The header is injected only into same-site top-level GET/HEAD document requests for exact configured domains. It is not sent to redirects, assets, analytics vendors, or arbitrary third parties, and its value is never traced.

For a Cloudflare-protected property you own, create a narrowly scoped WAF Skip rule that requires the secret header and, where stable, an egress IP allowlist. Limit the rule to the audit hostname, GET/HEAD, and storefront paths. Skip only the specific rate-limit/managed/Super Bot Fight Mode phases that block the authorized scanner; keep logging enabled and rotate the secret. Cloudflare documents the [Skip action](https://developers.cloudflare.com/waf/custom-rules/skip/) and its [available phase options](https://developers.cloudflare.com/waf/custom-rules/skip/options/).

For an application protected by Cloudflare Access, use a dedicated expiring [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) and a Service Auth policy. The scanner's current single-header origin allowlist is for WAF/origin audit authorization; adding the two Access headers should be a separate credential type so they remain first-party-document-only and separately rotatable.

Never add an allow/skip rule to a third-party site, never put the secret in source control, and never broadly skip all security controls for every path or method.

## Benchmarking

Run the same representative corpus after changing Browserless host, route, or proxy provider:

```powershell
npm run benchmark:access -- tests/fixtures/access-benchmark.sample.csv --geo USA --output tests/access-benchmark-result.json
```

The report includes valid-storefront rate, failure categories, challenge clears, retry recovery, average/p95 duration, and the safe Browserless host name. Compare at least 50–100 consented targets per variant. Do not draw conclusions from one site or run variants simultaneously against the same domain.

Useful internal endpoints:

- `GET /api/v1/scanner/access-readiness`
- `GET /api/v1/scanner/proxy-metrics`
- `GET /api/v1/queue`

## Remaining limits

- Some public sites intentionally deny automation or a particular residential pool. The correct result is inconclusive, not a fabricated pass.
- CAPTCHA solving and Browserless residential fallback depend on account entitlement and cost.
- The in-memory domain cooldown/circuit state is lost on restart; proxy health is durable in PostgreSQL. Move domain circuits to the future queue/orchestration store.
- A legal migration redirect can change the observed business/site. Cross-domain accepted audits are flagged in evidence and should be sampled in QA.
- Persistent authenticated profiles are deliberately not used for ordinary consent audits because old consent cookies would contaminate the observation.
