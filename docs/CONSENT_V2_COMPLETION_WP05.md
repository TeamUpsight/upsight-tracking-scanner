# Consent V2 Completion WP05

## Live validation cohort

No live Browserless + Decodo observation cohort was run for this completion package (`n=0`). The repository contains no approved Consent V2 target matrix or research-note domain list covering the required providers and geographies. The work package prohibits substituting arbitrary public sites, so no live target was selected.

The checked-in production browser fixtures passed with observation-only rollout controls:

```text
CONSENT_V2_ENABLED=true
CONSENT_V2_ACTIONS_ENABLED=false
CONSENT_V2_ACTION_SAMPLE_PERCENT=0
```

This establishes production-session and full-runner wiring only; it is not Browserless, Decodo, proxy, GEO, or storefront validation.

### Observation telemetry review

All live telemetry denominators are zero, so the following rates are not calculable and have no statistical significance.

| Metric | Result | Sample size |
|---|---|---|
| Provider detection precision | not calculable | 0 detected providers |
| Provider detection miss rate | not calculable | 0 expected providers |
| Provider conflict rate | not calculable | 0 observed pages |
| Banner detection rate | not calculable | 0 expected banners |
| Generic fallback rate | not calculable | 0 observed pages |
| False-positive custom-CMP rate | not calculable | 0 reviewed custom candidates |
| GPP stub rate | not calculable | 0 observed pages |
| Framework error rate | not calculable | 0 observed framework probes |
| GEO verification rate | not calculable | 0 requested GEOs |
| Challenge rate | not calculable | 0 navigation attempts |
| Unknown-CMP rate | not calculable | 0 observed pages |

## GEO verification

No proxy GEO was requested or verified (`0/0`). GEO verification rate is not calculable without a live cohort. USA, EU, and UK remain unvalidated for Consent V2 live deployments.

## Provider accuracy

No live provider detections were observed (`n=0`), so provider detection precision, miss rate, and conflict rate are not calculable. Fixture and production-session coverage exists for OneTrust, Cookiebot, Usercentrics, Didomi, CookieYes, Sourcepoint, Shopify Customer Privacy, and generic/custom classification.

## Framework accuracy

No live framework observations were collected (`n=0`). TCF, GPP, USP, and Google Consent Mode lifecycle checks passed in the executable production fixtures. `GPP_US_SEMANTIC_RESOLVER_PENDING` remains intentionally deferred: lifecycle presence, API support, and section lists must not be treated as US sale/share/targeted-ad opt-out semantics without validated official field-level evidence.

## Generic/custom accuracy

No live generic/custom examples were observed (`n=0`). The fixture suite includes stable unknown-CMP fingerprinting and negative dialog cases to guard against classifying newsletter, login, age-gate, country-selector, and similar dialogs as custom CMPs. Generic fallback rate, false-positive custom-CMP rate, and unknown-CMP rate are not calculable without live samples.

## Pre-choice tracking accuracy

No live pre-choice tracking observations were collected (`n=0`). The production fixture suite covers pre-choice GA4, Meta, Consent Mode, and POST tracking facts. It does not prove storefront timing or proxy/browser behavior.

## Observed implementation bugs

None observed in the executable fixture and typecheck validation. No live observation occurred, so this is not evidence that the production infrastructure is defect-free.

## Observed provider drift

None observed (`n=0` live samples). Provider/template drift, GEO/proxy failure, access blocking, anti-bot behavior, site customization, and insufficient evidence cannot be distinguished until the approved cohort is supplied and observed.

## Action-readiness matrix

| Provider | Detection fixture | Detection live | UI interaction fixture | Semantic verification | Persistence | Live action tested | Drift risk | Production action ready |
|---|---|---|---|---|---|---|---|---|
| OneTrust | YES | NO | YES | YES | YES | NO | CONDITIONAL — no live evidence | NO |
| Cookiebot | YES | NO | YES | YES | YES | NO | CONDITIONAL — no live evidence | NO |
| Usercentrics | YES | NO | YES | CONDITIONAL — intentionally inconclusive | CONDITIONAL — descriptor continuity only | NO | CONDITIONAL — no live evidence | NO |
| Didomi | YES | NO | YES | YES | YES | NO | CONDITIONAL — no live evidence | NO |
| CookieYes | YES | NO | YES | YES | YES | NO | CONDITIONAL — no live evidence | NO |
| Sourcepoint | YES | NO | YES | YES | CONDITIONAL — fixture evidence only | NO | CONDITIONAL — no live evidence | NO |
| Shopify Customer Privacy | YES | NO | NO | CONDITIONAL — observation-only runtime | CONDITIONAL — fixture evidence only | NO | CONDITIONAL — no live evidence | NO |
| unknown/custom CMP | YES | NO | NO | CONDITIONAL — intentionally inconclusive | CONDITIONAL — metadata only | NO | CONDITIONAL — no live evidence | NO |

Every provider fails the permanent live-validation requirement. No action cohort was run, and no provider action should be enabled.

## Recommended production flags

```text
CONSENT_V2_ENABLED=true
CONSENT_V2_ACTIONS_ENABLED=false
CONSENT_V2_ACTION_SAMPLE_PERCENT=0
```

Keep all provider-specific action flags disabled.

## Remaining evidence/research needed

1. An approved, bounded live target matrix with provider expectation and requested USA, EU, or UK GEO for each target.
2. A non-production Browserless + Decodo run for each supplied target, recording only the privacy-safe WP05 observation fields.
3. Per-mismatch classification as `IMPLEMENTATION_BUG`, `PROVIDER_DRIFT`, `TEMPLATE_VARIANT`, `GEO_NOT_VERIFIED`, `ACCESS_BLOCKED`, `ANTI_BOT`, `SITE_CUSTOMIZATION`, `INSUFFICIENT_EVIDENCE`, `EXPECTED_CONSERVATIVE_RESULT`, or `VALIDATION_DATA_WRONG`.
4. Sample-size-labelled telemetry for provider, banner, framework, GEO, challenge, generic/custom, and pre-choice tracking metrics.
5. Reviewed live non-production observation stability, conflict, selector/action-drift, semantic-verification, and persistence evidence before considering a single-provider action cohort.

## Final system verdict

`CODE_RELEASE_CANDIDATE` when the documented local code gates are green; `LIVE_VALIDATION_PENDING` until the approved Browserless/Decodo cohort is observed.

Consent V2 is ready for observation-mode code deployment, but WP05's required non-production Browserless/Decodo live validation has not occurred because no approved cohort is available. The action-readiness gate therefore remains unmet for every provider.
