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
11. **Stop gate.** If a work package concludes `Ready for next package = NO`, no subsequent package may proceed until its blocker is resolved or explicitly waived with a recorded reason.
12. **CI truth.** A mandatory CI requirement is not complete while its executable test is failing.
13. **No summary-driven completion.** Commit messages and agent summaries are not acceptance evidence; only production code, executed tests, and required live evidence count.
14. **Release-candidate stability.** After `CODE_RELEASE_CANDIDATE`, further Consent V2 work must originate from a live-validation failure, provider-drift telemetry, verified bug, or approved new requirement—not speculative general repair.

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

| Requirement | Owning module | Production caller | Production browser fixture | Full-runner coverage | Status |
| --- | --- | --- | --- | --- | --- |
| provider scoring and P0 adapters | `adapter-registry.ts`, provider adapters | `v2-session.ts` | provider cases in `v2-session.production.test.ts` | RUNNER-V2-01 uses OneTrust through `audit-runner.ts` | complete |
| Shopify runtime | `shopify-customer-privacy-runtime.ts` | `v2-session.ts` | Shopify and multi-mechanism cases | not applicable to runner acceptance | complete |
| TCF, GPP, USP lifecycle | `framework-observers.ts` | `v2-session.ts` | async TCF, GPP-02, USP-E2E-01 | not required for the runner fields | complete |
| Google Consent Mode | `google-consent-mode-observer.ts` | prepared session and `v2-session.ts` | GCM-01 through GCM-04 | not required for the runner fields | complete |
| generic detector and unknown fingerprint | `generic-consent-detector.ts`, `unknown-cmp-fingerprint.ts` | `v2-session.ts` telemetry | TELEM-UNKNOWN-01 stable/drift fixture | Consent V2 result persists telemetry through the runner | complete |
| provider-conflict telemetry | `adapter-registry.ts`, `v2-session.ts` | `v2-session.ts` telemetry | TELEM-CONFLICT-01 | not required for compatibility fields | complete |
| action planner and verification | `action-planner.ts`, `reject-verification-engine.ts` | `v2-session.ts` | OneTrust/Cookiebot/CookieYes/Sourcepoint and VER-CB-01 | observation-only runner fixture does not enable actions | complete for observation mode |
| persistence verifier | `persistence-verification.ts` | `v2-session.ts` | provider cases assert same-context reload | not required when observation-only | complete for observation mode |
| tracking consistency | `tracking-consistency.ts` | `v2-session.ts` | pre-choice and GCM contradiction cases | RUNNER-V2-02 final status assertion | complete |
| compatibility mapper | `compatibility-mapper.ts` | `audit-runner.ts` finalization | mapper unit cases | RUNNER-V2-01 and RUNNER-V2-02 | complete |
| rollout controls / legacy fallback | `rollout-controls.ts` | `audit-runner.ts` and `v2-session.ts` | disabled production-session case | RUNNER-DISABLED-01 | complete |
| blocked access semantics | `fresh-context.ts`, `audit-runner.ts` | access finalization | PRE-05 | RUNNER-BLOCKED-01 | complete |
| Linux CI browser gate | `.github/workflows/consent-v2.yml` | GitHub Actions | explicit unit, production-browser, regression, and build commands | remote confirmation pending after the final local release gate |

Action readiness remains **NOT READY**. Code status may be `CODE_RELEASE_CANDIDATE` only after the required local executable gates pass; `LIVE_VALIDATION_PENDING` remains until the Browserless/Decodo cohort is observed.
