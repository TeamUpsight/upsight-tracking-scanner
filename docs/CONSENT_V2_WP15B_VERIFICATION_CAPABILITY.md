# WP15B Verification Capability Gate

## Decision

Provider identity and Reject availability do not establish that a requested action can be verified. Before action execution, Consent V2 now requires both the existing rollout/action gates and a currently viable strong semantic verifier. For OneTrust, a ready, semantically populated TCF observer is the supported path unless a normalized provider state already supplies an accepted/rejected decision or a wholly known category state that the global verifier can interpret.

OneTrust's current adapter deliberately reports ambiguous state and no categories when it sees active-group IDs. Therefore a OneTrust tenant with no semantic TCF observation and no other normalized decision remains observation-only even when the action flags and sample gates pass. Reject availability remains in `available_actions` and telemetry.

## Evidence boundaries

The capability assessor admits only:

- `framework_tcf` when TCF is ready and the latest event contains known purpose or vendor state;
- `provider_state` when the normalized state is accepted or rejected;
- `provider_category_state` when the adapter exposes at least one normalized optional cookie category (preferences, analytics, marketing, or personalization) that it can resolve after interaction. Necessary-only and US sale/share categories do not establish cookie-Reject capability. Unanswered category values establish capability only; they are not rejection evidence.

TCF availability means a verifier path is plausible; it does not imply that a future `useractioncomplete` state will arrive or match. A normalized category channel has the same limit. The existing verifier remains unchanged and requires matching post-action semantic evidence with independent corroboration.

Click/API execution, provider events, banner visibility, cookie/storage existence, and persistence metadata remain insufficient to create a strong semantic verifier. OneTrust `OneTrustGroupsUpdated` and `OTConsentApplied` events remain supporting. No category IDs or cookie payloads enter the capability result or diagnostics.

The public OneTrust Web CMP documentation describes `RejectAll()` as excluding strictly necessary categories. The events documentation describes `OneTrustGroupsUpdated` as reporting active group IDs that may be user-consented **or Always Active**. `GetDomainData()` returns tenant configuration including consent models and category descriptions, but its public contract does not define the scanner's required stable mapping from tenant groups to normalized optional-category decisions. The scanner therefore does not infer a safe non-TCF category result from these sources.

## Execution and persistence

The action gate now requires Consent V2, global actions, provider actions, sample membership, an exposed actionable Reject path, and available verification capability. Generic/custom remains observation-only. A capability loss during fresh preflight prevents activation.

Same-context reload verification now runs only after semantic Reject verification succeeds. An executed but unverified Reject is returned with persistence `not_applicable`, no reload attempt, and an action-verification reason. This avoids spending time on a semantic persistence comparison that cannot be interpreted.

## Diagnostics

The bounded Consent runtime projection records requested action, actual executed strategy, activation occurrence, pre-action verification capability and strong families, post-action strong/supporting/contradicting families, and verification reason codes. It stores no selectors, DOM text, category identifiers, raw framework strings, cookies, or provider payloads. These fields are diagnostic only and do not influence canonical decisions.

## Next validation variant

The next single controlled live validation should use **OneTrust with a visible direct Reject control and a ready TCF API whose initial event includes normalized purpose/vendor state**. A `useractioncomplete` state with matching Reject semantics must still be observed before the audit can report verified behavior. A OneTrust tenant without that TCF state remains observation-only until a safe, provider-owned non-TCF semantic mapper is separately proven.
