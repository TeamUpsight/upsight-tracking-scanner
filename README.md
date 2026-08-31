# Upsight Tracking Scanner V2

An internal, evidence-based audit tool for ecommerce tracking. It visits a storefront through Browserless and configured Decodo residential proxies, captures bounded evidence, then applies deterministic detectors and status resolvers for CMP/consent, GA4, Meta, product `view_item`, CMS, and likely first-party/server-side collection.

The tool makes no legal-compliance claims. “No CMP detected” means only that the configured scan did not observe a CMP. A blocked or incomplete execution resolves to `inconclusive` or `not_tested`, never to a confident absence.

## Quick start

Requirements: Node.js 20+, npm, a Browserless account, configured Decodo proxy URLs, and PostgreSQL. For disposable local development only, set `USE_MEMORY_DB=true` instead of configuring PostgreSQL.

The Browserless plan must support third-party `externalProxyServer` launch options. If it does not, audits terminate as `browser_error` with `BROWSERLESS_EXTERNAL_PROXY_PLAN_REQUIRED`; the scanner never silently bypasses the selected Decodo geo proxy.

Before opening a browser session, the scanner performs a bounded DNS preflight. A confirmed resolver failure terminates as `dns_error` with `DNS_RESOLUTION_FAILED`, avoiding misleading proxy retries and false tracking-absence findings. If the local resolver is unavailable, two independent DNS-over-HTTPS responses must agree before the scanner treats resolution as failed.

```powershell
Copy-Item .env.example .env
npm ci
npm run typecheck
npm test
npm run dev
```

Open `http://localhost:3000`. If `INTERNAL_API_TOKEN` is set, enter the same token in the UI. API clients may send either `Authorization: Bearer <token>` or `X-Internal-API-Token: <token>`.

Do not commit or include `.env` in a handoff archive. It contains database, Browserless, and proxy credentials. Handoffs are source-only: exclude `node_modules/` and `dist/`, then run `npm ci` on the target platform before building. Never copy Windows-installed `node_modules` to Linux or Cloudflare; native optional binaries are selected during that platform's install.

## Commands

```text
npm run dev                         Start the Vite UI and Node API
npm run typecheck                   TypeScript validation
npm test                            Full deterministic test suite
npm run test:regression             Scanner regression corpus
npm run replay -- <file-or-folder>  Replay stored Evidence Bundles offline
npm run benchmark:access -- <csv>   Run a controlled access reliability corpus
npm run build                       Production UI and Node server build
npm run start                       Rebuild, then run the production server
npm run validate                    Typecheck, tests, and production build
```

Replay accepts an `evidence.json`, an exported `audit-result.json`, an array of audits, or a directory containing JSON files. Its JSON output reports audits replayed, results changed, previous results, new results, and field-level reasons.

## Scan workflow

1. Choose a domain, geo (`USA`, `UK`, or `EU`), the Consent, Tracking, and/or Server-side modules, and `normal` or `diagnostic` mode. Module selection controls which audit phases run; `scan_mode` only controls bounded evidence retention. Missing historical selections default to all three modules.
2. The domain-aware bounded queue starts the audit with the Browserless default CDP context and configured proxy.
3. The consent phase observes the homepage and attempts a real, verifiable reject action when one is available.
4. The product phase first randomizes URLs matching the established product-path rules. Comparison pages whose second path segment contains `-vs-` or `compare` are excluded. Only when the established product-path pool is empty does discovery fall back to safe same-storefront URLs with exactly two pathname levels. PDP evidence is checked after initial readiness and again after hydration. An out-of-stock candidate is skipped only when its own valid GA4 `view_item` was not observed; a URL-matched valid product event overrides the availability signal. Tracking listeners are attached before navigation and remain active through the bounded post-load observation window. A PDP tunnel failure rotates the bounded proxy session/port before the next candidate instead of exhausting every candidate on a dead tunnel.
5. Evidence is replayed through shared detectors, consistency checks, failure fingerprints, and QA prioritization.
6. Use **Re-run Diagnostic**, **Re-run Difficult Site**, **Export Debug Package**, **Audit Reviewer**, or **Replay Evidence** from the audit details when investigation is needed. Difficult-site escalation is manual and only activates configured, authorized Browserless capabilities.

### Scan and investigation controls

| Control | Visits the website? | What changes |
| --- | --- | --- |
| Normal mode | Yes | Runs the standard audit with lean, bounded evidence retention. This is the bulk/default mode. |
| Diagnostic mode | Yes | Runs the same detector rules while retaining additional bounded request, CMP, timing, and screenshot evidence. |
| Re-run Diagnostic | Yes | Creates a new diagnostic audit for the selected audit's domain and geo. It does not enable challenge-solving escalation. |
| Re-run Difficult Site | Yes | Creates a manual diagnostic audit with the configured CAPTCHA/challenge retry enabled. Use only for high-value blocked sites. |
| Replay | No | Re-evaluates the stored Evidence Bundle with the current rule pack and reports field-level changes. |
| Audit Reviewer | No | Derives guardrail violations, likely root cause, a patch plan, and regression-test suggestions from the stored result and evidence. |
| Sanitized trace timeline | No | Displays chronological runtime facts for technical debugging. It is evidence, not a diagnosis. |

The main audit summary shows GA4 installation as one finding and GA4 ecommerce `view_item` as another. The separate collection-observed field remains in normalized evidence, exports, and resolvers because installation evidence and a collection hit are technically different, but it is not shown as a redundant standalone finding in the main UI.

Bulk CSV input accepts a `domain` column (or the first column), deduplicates valid domains, validates geo, limits upload bytes, caps each batch at 5,000 unique domains, and defaults to concurrency 3. CAPTCHA solving is disabled for bulk jobs.

The Review Queue contains one row per normalized website and only its latest audit. **Mark as Correct** persists a QA resolution, removes that latest audit from the queue, and excludes its resolved failure fingerprints from Quality improvement priorities. Quality finding distributions and operational rates use the latest audit per unique website; the dashboard separately reports all stored audits and unique websites.

## Status semantics

- `not_tested`: the module never ran or was intentionally skipped.
- `inconclusive`: the module ran but evidence was blocked, incomplete, or ambiguous.
- `not_detected`: the module completed validly and found no qualifying evidence.
- `cancelled`: explicit user cancellation.
- `failed / scan_timeout`: worker/global audit timeout.

GA4 is reported as three separate findings: installation evidence, collection observed, and ecommerce `view_item` payload status. A GTM container alone and a generic `/collect` endpoint are not GA4 evidence.

## Configuration

See [.env.example](./.env.example) for the complete list. Important controls are:

- `INTERNAL_API_TOKEN`
- PostgreSQL `DB_*` values or explicit local-only `USE_MEMORY_DB=true`
- `BROWSERLESS_HOST`, `BROWSERLESS_TOKEN`, `BROWSERLESS_ROUTE`
- `BROWSERLESS_SESSION_TIMEOUT_MS`, `BROWSERLESS_PROXY_MODE`, and opt-in difficult-site controls
- `DECODO_PROXY_USA`, `DECODO_PROXY_UK`, `DECODO_PROXY_EU`
- bounded `DECODO_PROXY_*_PORTS` and real `DECODO_PROXY_EU_COUNTRY_FALLBACKS`
- `SCAN_CONCURRENCY`, `AUDIT_TIMEOUT_MS`, `MAX_BATCH_SIZE`, `MAX_CSV_BYTES`
- `DECODO_MAX_RETRIES_BULK` and `DECODO_MAX_RETRIES_SINGLE` (the only proxy retry limits)
- optional build provenance: `BUILD_COMMIT` (CI); timestamp is generated by `npm run build`

Production database connection failures stop startup. They never silently switch to process memory.

## Documentation

- [Architecture](./ARCHITECTURE.md)
- [Quality system](./QUALITY_SYSTEM.md)
- [Deployment and Cloudflare migration](./DEPLOYMENT.md)
- [Access reliability and authorized-site setup](./ACCESS_RELIABILITY.md)
- [Current engineering handoff](./CODEX_HANDOFF.md)
- [Documentation index](./docs/README-FIRST.md)

Gemini, Google AI Studio metadata, self-modifying source patches, generated outreach copy, and their runtime/API/UI paths have been removed. The remaining Audit Reviewer is deterministic and read-only: it classifies evidence and suggests a Git-based patch and regression-test plan.
