# Consent V2 Completion WP03

## Provider verification matrix

| Provider | Reject execution | Strong semantic state | Independent corroborator | Verification E2E | Persistence E2E | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Cookiebot | visible Reject | `declined` plus optional categories false | distinct provider category state | yes | yes | verified; confirmed |
| Didomi | documented Reject API | fresh `getCurrentUserStatus()` rejected | captured `consent.changed` | yes | yes | verified; confirmed |
| CookieYes | visible Reject | `getCkyConsent()` optional categories false | `isUserActionCompleted` | yes | yes | verified; confirmed |
| Sourcepoint | cross-origin visible Reject | async TCF purpose and vendor aggregates rejected | `useractioncomplete` in the same authoritative framework transition | yes | not asserted | verified |
| OneTrust | visible Reject | TCF purpose and vendor aggregates rejected | captured `OTConsentApplied` | yes | fixture state reloads | verified |
| OneTrust, no framework state | visible Reject | unavailable | captured provider event only | yes | not applicable | inconclusive |
| Usercentrics | localized open-shadow Reject | unavailable | `ucData` / `ucString` metadata only | yes | yes | inconclusive |

All rows are controlled browser fixtures. They do not establish live production action readiness.

## Strong vs supporting signals used

- Cookiebot and CookieYes use the provider decision plus separately normalized optional-category decisions. CookieYes also requires its explicit completed-action state.
- Didomi uses a fresh provider-state read after a captured transition event.
- Sourcepoint uses no raw TC string; only the asynchronous TCF event and aggregate purpose/vendor state are read.
- OneTrust never treats tenant group IDs as semantic categories. Its verified path requires a TCF-negative state and captured OneTrust transition.
- Browser events are only corroborators when actually captured. Adapter evidence is no longer reclassified as an event.

## Persistence results

Cookiebot, Didomi, and CookieYes compare the post-action semantic provider state with the same-origin reload and confirm persistence. Usercentrics records completed reload observation and matching privacy-safe storage descriptors, but remains inconclusive because no approved semantic state reader exists.

## Cases intentionally left inconclusive

- OneTrust without authoritative TCF/GPP semantic evidence.
- Usercentrics after localized Reject: no documented, validated safe provider semantic API is present in the codebase or validated source notes.

## GPP semantic implementation status

Not implemented. The codebase and validated source notes establish only GPP lifecycle and applicable section identifiers; they contain no validated structured `getSection`/section-field mapping for sale, sharing, targeted-advertising, or known-user opt-outs. Required external evidence: the official GPP API section-access contract and public field semantics for each supported US section, including applicable-section/jurisdiction rules. Raw GPP-string parsing and speculative bit decoding remain prohibited.

## Production-path tests

`src/scanner/consent/v2-session.production.test.ts` covers the matrix above, including Sourcepoint contradiction (`useractioncomplete` while both aggregates remain granted) as `not_verified` with a state contradiction.

## Privacy review

The fixtures and bridge retain only normalized booleans, aggregate counts, event names, and storage descriptors. No cookie values, TC strings, GPP strings, consent IDs, or tenant group IDs are persisted.

## Remaining action-readiness blockers

`CONSENT_V2_ACTIONS_ENABLED=false` and `CONSENT_V2_ACTION_SAMPLE_PERCENT=0` remain unchanged. Every provider still requires reviewed non-production Browserless/Decodo validation, stability telemetry, and the existing rollout gate before any production sampling.

## Ready for Completion WP04

NO. GPP US-opt-out normalization requires the external evidence identified above, and no provider is live-action ready.
