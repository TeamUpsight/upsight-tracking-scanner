# P0 production readiness

Verdict: **P0_BLOCKED** until the production browser/proxy egress boundary denies private, loopback, link-local, and metadata destinations after DNS resolution. The scanner rejects unsafe submitted hosts and guards ordinary CDP requests, but Playwright routing does not cover every redirected or Service Worker request. Verify the network rule in the deployment environment before accepting arbitrary domains. No live vendor action was performed in this package.

| Module | Capability | Production status | Known safe degradation | P0 blocker? | P1/P2 follow-up |
| --- | --- | --- | --- | --- | --- |
| Consent | CMP observation, guarded Reject/Accept | ready_with_safe_degradation | Unverified geo, unsupported action, or incomplete verification becomes inconclusive; zero activation | No | Usercentrics live Reject stability; OneTrust strong-verifier live certification; other provider coverage |
| Cookiebot | Detection, action, verification, persistence, leakage chronology | ready | Action still requires explicit global/provider/sample flags, clean compiled build, verified geo, and runtime capability | No | None required for launch |
| Usercentrics v2 | Detection/runtime/ownership and deterministic verification/persistence | ready_with_safe_degradation | Live Reject disabled in production; observation remains available | No | Live execution when runtime stability is proven |
| OneTrust | Detection/lifecycle/safety observation | ready_with_safe_degradation | Strong-verifier action disabled in production | No | Live action certification on suitable runtime |
| Other CMPs | Existing detection and observation | ready_with_safe_degradation | Unsupported action remains inconclusive | No | Provider-specific action coverage |
| Product | Strict GA4 `view_item` on confirmed PDP | ready_with_safe_degradation | Incomplete discovery/navigation/observation becomes inconclusive | No | Broader ecommerce coverage |
| Server-side | Existing collection classifier | ready_with_safe_degradation | Incomplete network observation becomes inconclusive | No | Additional collector coverage |
| Single and bulk scans | Bounded process-local queue, stale recovery | ready | Failed audits do not stop other queued audits | No | Durable distributed queue after scale warrants it |
| CSV import/export | Bounded import, lightweight group export | ready | Invalid rows are skipped; no evidence blob required for export | No | Row-level import feedback |
| Evidence/debug | On-demand detail and ZIP | ready | Bulk debug ZIP limited to 25 audits/request | No | Artifact storage if diagnostic volume grows |
| Database | PostgreSQL durable rows, summary-only list | ready | Database failure is technical; no memory fallback in production | No | Non-production PostgreSQL integration smoke |
| Browserless | Bounded CDP session and cleanup | ready_with_safe_degradation | Transport failure becomes technical; BrowserQL/GPC side sessions disabled in production | No | Guard optional side sessions before enabling |
| Proxy/geo | Per-geo proxy, egress country probe for Consent | ready_with_safe_degradation | Country mismatch or failed probe makes Consent inconclusive and disables action | No | Live geo smoke |
| Build/runtime | Compiled bundle, clean commit provenance | ready | Direct source is non-certifiable | No | None required |
| Security | API token, URL guard, request checks | blocked | Unsafe requests are aborted; private egress must also be denied by infrastructure | **Yes** | None before resolving egress rule |
| Observability | Health, phases, reason codes, bounded evidence | ready | Health omits audit-domain details | No | Operational dashboards |

## P0 changes and bounds

- Production startup now requires an internal API token, Browserless token, valid USA/EU/UK proxy URLs, and durable storage. It rejects local-browser and memory modes. The checked-in challenge-solving default is off; BrowserQL and GPC side sessions are rejected in production until they share the request guard.
- The scanner rejects non-web schemes, internal hostnames and private literal IPs. Ordinary browser requests are checked against bounded public DNS answers. A blocked request marks network observation incomplete, preventing a negative finding from that incomplete capture.
- Legacy Product Accept and clean-context Accept now require an explicit action cohort, eligible build, verified geo, and eligible provider. Production action eligibility is limited to Cookiebot. Consent V2 Reject also requires verified geo.
- A Consent audit probes actual egress country even in normal mode. Unverified or mismatched egress returns an inconclusive Consent result.
- The public health response exposes counts and build provenance without cooled-down audit domains. Bulk debug ZIP limits heavy audit-detail reads to 25 per request.
- Audit concurrency defaults to 3 and is capped at 10. Bulk submission is capped at 5,000 domains and 10 MB CSV. Lists default to 25 rows, cap at 100, and fetch summary columns only. Detail evidence is fetched for a selected audit. CSV export uses selected fields, caps at 5,000 rows, and escapes spreadsheet formula prefixes. Browser/session cleanup and bounded retry/finalization paths remain in the runner.

## Runbook

1. Configure production secrets through the platform secret store: `DATABASE_URL` or `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD`, `INTERNAL_API_TOKEN`, `BROWSERLESS_TOKEN`, and valid `DECODO_PROXY_USA`, `DECODO_PROXY_EU`, `DECODO_PROXY_UK`. Set `NODE_ENV=production`, `USE_MEMORY_DB=false`, `BROWSERLESS_CHALLENGE_SOLVING_ENABLED=false`, and `GPC_EXPERIMENT_ENABLED=false`.
2. Keep `CONSENT_V2_ACTIONS_ENABLED=false`, `CONSENT_V2_ACTION_SAMPLE_PERCENT=0`, and all provider action flags false for observation-only launch. Do not enable an action solely to increase coverage.
3. Enforce and verify private/loopback/link-local/metadata destination denial at Browserless/Decodo egress, including redirects and Service Worker traffic. Put the API behind TLS and the intended access perimeter.
4. On a clean committed checkout run `npm ci`, `npm run build`, then `node dist/server.cjs`. Check `GET /api/health` for `compiled_bundle`, the expected commit, `build_dirty=false`, and `certification_eligible=true`. Run a small non-action canary after deployment.

Offline validation cannot establish live Browserless, Decodo, storefront, or PostgreSQL behavior. Provider certification remains outside this package.
