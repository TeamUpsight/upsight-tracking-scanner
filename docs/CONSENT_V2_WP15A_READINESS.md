# WP15A Consent Action Rollout Readiness

Freeze reviewed: `2e01b0e92356acd639863b304ecdcf0c0e67be1e`.

This review is based on the checked-in adapter contracts, deterministic unit and browser fixtures, the production session composition, and the final compatibility resolver. It is not evidence from a live storefront. Action defaults remain disabled.

## Provider readiness

| Provider | Detection / discovery evidence | Interaction and verification evidence | State |
| --- | --- | --- | --- |
| OneTrust | Multi-family provider identity; documented stable reject control and visible banner roots; current production browser fixtures exercise the visible reject route. | Direct Reject and documented API are distinguished in availability; user-facing selector is preferred. Production fixture verifies only with a TCF user-action rejection plus a separate provider event. Same-context semantic persistence is covered by session fixtures. | `ready_for_controlled_rollout` |
| Cookiebot | Provider-specific evidence and documented reject selectors; production fixtures cover localized control discovery and a direct reject example. | Reject can be executed through the adapter bridge, but current tests do not establish a consistent independent verification pair for the requested reject across provider variants. Provider state, event and framework representations need per-variant independence evidence before action rollout. | `insufficient_verification` |
| Usercentrics | Provider asset/root evidence, including open shadow-root control discovery; direct semantic UI controls are discovered in fixtures. | Current reject fixtures do not establish sufficiently independent matching verification families; provider state/persistence may represent the same underlying provider state. | `insufficient_verification` |
| Didomi | Provider SDK evidence and provider API state; action fixture exercises the API-only `setUserDisagreeToAll` route. | Available action is API-only in the covered case. A provider-state result plus provider event is not yet established as independent from that same API action in the production fixture contract. No user-facing Reject evidence for the covered variant. | `insufficient_verification` |
| CookieYes | Provider-specific asset/root/state evidence and explicit action adapter methods. | Existing production fixture does not prove two independent matching semantic families after Reject; action/persistence evidence remains supporting or same-provider-derived. | `insufficient_verification` |
| Sourcepoint | Provider-specific asset/root/persistence evidence; selector-based action adapter and first-layer/preferences fixture. | Existing fixture path does not establish stable independently corroborated Reject verification and same-context semantic persistence. | `insufficient_verification` |
| Shopify | Separate commerce privacy runtime detection and state/actions; rollout key exists but not in the identified-CMP action branch. | `v2-session.ts` only enters Reject execution for an identified CMP adapter. Runtime reject is not executed by this state machine and cookie Reject is not a US opt-out action. | `observation_only` |
| Generic/custom | Strongly scoped generic detection and semantic action candidates are recorded for observation/diagnostics. | No generic/custom action execution branch exists. Generic labels and surface evidence do not establish independent post-action semantics. | `observation_only` |

Provider adapter metadata marks detection and action inventory at fixture maturity; this matrix does not treat those declarations alone as production validation. Only OneTrust has the current end-to-end visible Reject fixture with independent TCF and provider-event corroboration suitable to justify a limited controlled validation. “Ready” authorizes a later controlled validation decision only; it does not enable actions.

## Rollout gates and cohort identity

An action is eligible only when Consent V2 is enabled, global actions are enabled, that provider's action flag is enabled, and the stable key's hash bucket is less than the configured sample percentage. Provider action flags default false and are themselves forced false when global actions are false. Sample `0` excludes all keys; sample `100` includes all keys that pass the other gates. The hash is deterministic.

Before WP15A, production omitted `rollout_key`, so the final page URL was hashed. Route paths, query strings, fragments, and redirects could therefore change sample membership for one submitted domain. Production now passes the normalized submitted domain; URL-form fallback keys are normalized to hostname. This is a deterministic cohort-stability correction. It does not broaden which providers can execute.

## Execution and verification boundary

The action planner prefers a provider selector when an action has a visible direct target, then falls back to documented API only when the preceding attempt genuinely did not execute. API-only actions are represented separately from direct user-facing availability. The bridge re-discovers browser facts, provider context and target before each transition and rejects detached, hidden, disabled, inactive, wrong-frame, closed-shadow, or navigating targets. Successful activation returns immediately; state transition or navigation interruption stops fallback. Preferences opening is preparatory and triggers rediscovery; opening or saving alone is not verified Reject.

Reject verification ignores click success, banner disappearance and storage-only changes. It requires at least two strong semantic families or one strong family with supporting corroboration from a different semantic family. Strong authoritative contradiction yields `not_verified`; other strong contradiction is inconclusive. OneTrust's current covered verification pair is framework TCF state and a separately observed provider event. Provider state and category state are not counted twice when they merely represent the same provider snapshot.

The execution timestamp is captured immediately before invoking the handler, so synchronous browser events are on or after the action boundary. Only verified Reject plus a completed post-reject observation can classify a later tracking event as a contradiction. Same-context reload persistence requires a completed reload/read and matching semantic state; storage continuity is supporting only. Production status mapping requires attempted + verified Reject + completed observation for `pass`, and verified Reject plus a post-verification tracking contradiction for `consent_leakage`. EU/UK pre-choice conclusions are limited to independently classified full measurement and completed CMP identification/absence. USA privacy choices remain descriptive and separate from cookie Reject.

## Diagnostics

Action-enabled telemetry includes the provider, available Reject category, requested interaction result, action timestamp lifecycle, verification status, persistence status, post-reject tracking consistency and bounded reason codes. Diagnostic observations expose capped normalized control names and visibility facts. They do not retain raw selectors, consent payloads, IDs or cookie values. Verification evidence-family names are available in the verifier result. The current persisted debug projection does **not** retain the action sample percentage, deterministic bucket, provider/global gate values, or an explicit reason for cohort inclusion/exclusion; it can show that actions were enabled and what happened afterward, but it cannot fully explain cohort selection from the debug package alone. That is an observability gap to close before relying on debug packages for rollout triage.

## Controlled validation settings

For a later OneTrust-only validation, start with:

```text
CONSENT_V2_ENABLED=true
CONSENT_V2_ACTIONS_ENABLED=true
CONSENT_ONETRUST_ACTIONS_ENABLED=true
CONSENT_V2_ACTION_SAMPLE_PERCENT=1
```

All other `CONSENT_<PROVIDER>_ACTIONS_ENABLED` flags remain false. A 1% sample can legitimately exclude an individual domain; confirm its deterministic cohort before interpreting a no-action result. Do not change the checked-in or deployed defaults as part of this readiness package.

## Decision

The action semantics and fixtures justify a **OneTrust-only, small controlled live action validation**. Before starting it, operators must manually confirm the submitted domain's 1% cohort membership because the debug package does not retain the bucket decision. A future rollout should add a bounded, sanitized gate/bucket projection if cohort inclusion/exclusion must be diagnosable from audit evidence. This is not evidence that all providers are ready, and offline fixtures cannot establish behavior on arbitrary live OneTrust templates. Other providers remain observation-only or insufficiently verified as shown above. No live site was visited for this review.
