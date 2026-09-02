# Consent V2 development rules

These rules protect the Consent V2 production path from parallel implementations and unsafe action rollout. They apply to new adapters, browser bridges, framework observers, and session changes.

## Permanent ownership rules

1. **Single owner.** Each semantic domain has one implementation owner: provider behavior belongs to its adapter; TCF, GPP, and USP to framework observers; generic CMP classification to `generic-consent-detector.ts`; Shopify Customer Privacy to `shopify-customer-privacy-runtime.ts`; and Google Consent Mode to `google-consent-mode-observer.ts`.
2. **Orchestrator.** `v2-session.ts` composes capture, adapters, observers, verification, persistence, and tracking modules. It must not contain provider selectors, provider method names, provider state interpretation, framework parsing, or generic-CMP scoring.
3. **Executable acceptance.** A requirement is complete only after an executable test exercises its production wiring.
4. **Fixtures are behavior.** A scenario manifest or expected-object test is not a browser test. Fixture pages must execute the real production session.
5. **Integration gate.** A new provider module must be registered, called from the production path, and covered by an integration test before it is reported as complete.
6. **No parallel implementation.** When a session needs capability from an existing module, add the smallest browser bridge or adapter interface rather than reproducing its semantics.
7. **Pre-navigation capture.** Collectors needed for pre-consent observations must be installed after the fresh page is created and before first navigation.
8. **Conservative state.** Unavailable or conflicting evidence is inconclusive; it is never inferred as a consent decision.
9. **Provider/framework separation.** TCF, GPP, USP, and Consent Mode establish framework facts, not CMP identity.
10. **Multi-mechanism facts.** A CMP, platform privacy runtime, frameworks, and Consent Mode remain independent mechanisms in the result.

## Action-readiness gate

No provider action may be recommended for production sampling until every condition below is documented for that provider:

1. its executable browser fixture passes;
2. its production-session integration test passes;
3. semantic verification exists, or the adapter intentionally returns `inconclusive`;
4. the selected strategy matches the intended user-path audit, preferring visible UI controls over API shortcuts;
5. observation telemetry shows stable provider detection;
6. telemetry shows no material provider-conflict spike;
7. telemetry shows no material selector or action drift; and
8. non-production Browserless/Decodo validation has been reviewed.

Keep production in observation-only mode until the full gate passes:

```text
CONSENT_V2_ENABLED=true
CONSENT_V2_ACTIONS_ENABLED=false
CONSENT_V2_ACTION_SAMPLE_PERCENT=0
```

The `CONSENT_V2_ENABLED=false` fallback uses the legacy detector only; it must not execute the removed legacy Reject path or run any V2 interaction.

## Current provider maturity

“No” in the final column is intentional: no reviewed non-production live validation has yet cleared the action-readiness gate.

| Provider | Detection | UI action | API action | Semantic verification | Persistence | E2E fixture | Live validation | Production action ready |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OneTrust | verified | documented UI path | documented fallback | supporting evidence | supporting evidence | yes | pending | no |
| Cookiebot | verified | documented UI path | disabled | supporting evidence | supporting evidence | yes | pending | no |
| Usercentrics | verified | semantic open-shadow UI | disabled | supporting evidence | supporting evidence | yes | pending | no |
| Didomi | verified | documented UI path | documented fallback | supporting evidence | supporting evidence | yes | pending | no |
| CookieYes | verified | documented UI path | documented fallback | supporting evidence | supporting evidence | yes | pending | no |
| Sourcepoint | verified | cross-origin iframe UI | disabled | supporting TCF evidence | supporting evidence | yes | pending | no |
| Shopify Customer Privacy | verified runtime | observed only | disabled | supporting evidence | supporting evidence | yes | pending | no |
| Generic/custom | verified fallback | disabled | disabled | inconclusive by design | metadata only | yes | pending | no |

## Production audit map

| Requirement | Owning module | Production caller | Executable E2E test | Status |
| --- | --- | --- | --- | --- |
| provider scoring | `adapter-registry.ts` | `v2-session.ts` | provider fixture cases in `v2-session.production.test.ts` | complete |
| P0 adapters | six `*-adapter.ts` modules | adapter registry via `v2-session.ts` | OneTrust, Cookiebot, Usercentrics, Didomi, CookieYes, Sourcepoint cases | complete |
| Shopify runtime | `shopify-customer-privacy-runtime.ts` | platform registry via `v2-session.ts` | Shopify and multi-mechanism cases | complete |
| TCF, GPP, USP | `framework-observers.ts` | `v2-session.ts` | Sourcepoint and GPP cases; USP remains unit-covered only | incomplete for USP E2E |
| Google Consent Mode | `google-consent-mode-observer.ts` | prepared session and `v2-session.ts` | GCM-01 through GCM-04 | complete |
| generic detector | `generic-consent-detector.ts` | `v2-session.ts` | custom-banner and newsletter cases | complete |
| action planner | `action-planner.ts` | `v2-session.ts` | OneTrust/Cookiebot/CookieYes/Sourcepoint action cases | complete |
| Reject verifier | `reject-verification-engine.ts` | `v2-session.ts` | VER-CB-01 | complete |
| persistence verifier | `persistence-verification.ts` | `v2-session.ts` | production session cases invoke same-context reload; no dedicated asserted browser case | incomplete |
| tracking consistency | `tracking-consistency.ts` | `v2-session.ts` | pre-choice and GCM contradiction cases | complete |
| unknown fingerprinting | `unknown-cmp-fingerprint.ts` | `v2-session.ts` telemetry | custom-banner case does not assert fingerprint | incomplete |
| compatibility mapper | `compatibility-mapper.ts` | `audit-runner.ts` finalization | OneTrust mapper assertion exercises the same mapper, but not full runner finalization | incomplete for full runner E2E |
| rollout controls | `rollout-controls.ts` | `audit-runner.ts` and `v2-session.ts` | disabled-rollout production-session case; legacy runner fallback is not browser-exercised | incomplete for full runner E2E |

The remaining incomplete rows are release gates: do not enable actions until they have direct production-session browser assertions. The two full-runner rows also need a safe, approved Browserless integration fixture before they can be called end-to-end covered.
