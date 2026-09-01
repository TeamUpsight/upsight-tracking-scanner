# Consent V2 rollout

Consent V2 runs in an isolated browser context and retains its internal evidence only as bounded, privacy-safe facts. The existing compatibility mapper remains the only route to `cmp_provider`, `consent_status`, and `trace_steps`; no database schema change is required.

## Controls

`CONSENT_V2_ENABLED` controls the V2 session. Provider detection can be disabled independently with `CONSENT_<PROVIDER>_ENABLED`. Actions require all three conditions:

- `CONSENT_V2_ACTIONS_ENABLED=true`
- `CONSENT_<PROVIDER>_ACTIONS_ENABLED=true`
- the deterministic domain sample is below `CONSENT_V2_ACTION_SAMPLE_PERCENT`

The default configuration is observation-only: V2 and provider detection are on, action execution is off, and the action sample is zero. `PROVIDER` is one of `ONETRUST`, `COOKIEBOT`, `USERCENTRICS`, `DIDOMI`, `COOKIEYES`, `SOURCEPOINT`, `SHOPIFY`, or `GENERIC`.

Disabling an action path never disables provider detection, framework observation, or the rest of the consent audit.

## Per-audit telemetry

The existing `runtime_metrics.consent_v2` JSON records only enums, booleans, provider IDs, and a bounded unknown-CMP fingerprint. It does not contain browser text, HTML, storage/cookie values, TC/GPP/USP strings, URLs with queries, or consent identifiers.

The existing quality-metrics endpoint aggregates detection/provider confidence/conflicts, banner and action discovery, interaction/verification/persistence outcomes, generic fallback, selector/action failures, TCF/GPP and Consent Mode state, tracking contradictions, unknown fingerprints, geo verification, and blocking/challenge outcomes. These provide drift signals for falling action/verification rates and rising unsupported/contradictory results.

## P0 capability posture

| Provider | Detection | User-facing Reject | API Reject |
| --- | --- | --- | --- |
| OneTrust | verified | verified selector path | documentation-supported |
| Cookiebot | fixture/documentation-supported | stable controls | disabled |
| Usercentrics | verified current bundle | semantic open-shadow UI | unvalidated/disabled |
| Didomi | verified bundle | stable/semantic controls | documentation-supported |
| CookieYes | verified bundle | stable controls | documentation-supported |
| Sourcepoint | verified bundle | documented controls via Playwright frames | not applicable |
| Shopify Customer Privacy | runtime observation | conservative/unvalidated | disabled |
| Generic/custom | conservative | disabled until false-positive review | not applicable |

## Recommended rollout

1. Keep the checked-in defaults for observation-only telemetry.
2. Enable a single verified provider action path with a small deterministic sample, for example OneTrust at 5%.
3. Review verification, unsupported-action, contradiction, and unknown-fingerprint metrics before expanding P0 providers.
4. Enable generic actions only after a dedicated false-positive review; generic detection may remain enabled throughout.

Offline tests validate feature decisions and telemetry shape. A non-production Browserless/proxy validation is still required before enabling any action cohort.
