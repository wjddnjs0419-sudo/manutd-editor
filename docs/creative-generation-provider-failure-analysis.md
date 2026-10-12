# Production FAILED_PROVIDER investigation — 2026-10-12

Scope: PR #10, `codex/gnews-resolution-pipeline`; Production project
`byymtttpwmllqvggnddm`. No OpenAI API call or Production mutation was made during
this investigation.

## Evidence and limits

Production `creative-generation` is ACTIVE v32. Failed job:
`0ed7510e-305c-401b-82ba-0712164fbfc5`; execution:
`6174f238-9e7d-478b-a428-8b458fe150a1`.

Read-only Production function logs show boot at 13:04:29.801 UTC and
`creative_generation_completed / FAILED_PROVIDER` at 13:05:02.159 UTC:
32.358 seconds from boot. The provider deadline is 30 seconds and the entrypoint
does not override it. This is consistent with a timeout, but does not prove one:
v32 discards the exception category and upstream HTTP status in its generation
catch. The Supabase handler HTTP 200 is not an OpenAI HTTP status.

The job has no creative brief, 2 cumulative provider calls, 0 retries, 2,721
input tokens and 63 output tokens, with estimated cost $0.006198. These token
counts were recorded by the earlier classifier; the failed generation supplied
no additional usage. Its billable usage cannot be inferred from this record.
The stored completion timestamp uses the orchestration start time; it must not
be used as the actual request completion time.

The active config selects classifier `gpt-5.6-luna` / low and generator
`gpt-5.6-terra` / medium / 5,000 maximum output tokens. No model-access probe was
made. A successful classifier response does not establish access to the different
generation model. `CLASSIFICATION_UNCERTAIN` can also mean low confidence; the
available record does not identify its exact reason.

| Candidate cause | Finding |
| --- | --- |
| 401/403 authentication or permission | No upstream status retained; unconfirmed |
| 404 model name/access | No upstream status retained; unconfirmed |
| 400/422 request format | No upstream status retained; unconfirmed |
| 429 rate limit or credit/quota | No upstream status/code retained; unconfirmed |
| 5xx upstream error | No upstream status retained; unconfirmed |
| Deadline/network | 32.358-second elapsed time supports investigation of 30-second deadline; unconfirmed |
| Response JSON/output JSON parsing | Exception detail discarded; unconfirmed |
| Quality gate contract mismatch | Cannot produce this recorded status in the generation path: gate runs afterward and returns FAILED_VALIDATION |

## Minimal code changes

- Reuse the provider; add locally defined failure codes for HTTP status classes,
  transport/deadline, invalid response JSON, invalid output JSON and missing text.
- For 429, recognize only `insufficient_quota` and `rate_limit_exceeded`; unknown
  or unreadable bodies remain `HTTP_USAGE_LIMIT`, without guessing which limit.
- Preserve HTTP 200 on malformed structured output diagnostics.
- Fix body-read aborts being labeled malformed JSON. Use the request's own abort
  signal to identify its deadline; transport TypeError maps to NETWORK, other
  exceptions to UNKNOWN.
- Carry only category, safe code and optional HTTP status through the existing
  orchestrator and handler. Do not retain/log upstream messages, arbitrary codes,
  API keys, article/request text or generated output.

No change to model, request schema, timeout length, retry count, cost limits,
classification policy, quality gate, READY/DRAFT rules, or DB schema. Standard
retry policy remains unchanged; Exploration generation still makes no retry.

## Verification

New mock tests failed before implementation, then passed. Provider tests: 10
passed, covering the HTTP matrix, safe diagnostics, transport/parsing and deadline
during both fetch and body read. Creative Generation suite: 97 passed. All Deno
nonintegration tests: 692 passed (29 steps), 0 failed. Database integration tests
were excluded; no Production test writes were performed. `git diff --check` passes.

## Approval and next step

The historical provider cause remains unresolved. Approve deployment of only
`creative-generation` with these diagnostics, then separately approve one manual
article generation request with no automatic retry. Use that request's safe code
and status to decide whether credentials/account/model settings or timeout need
changing. Do not deploy speculative model or timeout changes.

No migration or Telegram deployment/webhook change is needed. Deploying only
`creative-generation` updates its manual/direct generation path. Priority and
selected-poll functions share source imports but their existing deployed bundles
remain unchanged until explicitly redeployed. Telegram delivery code is unchanged;
a later Telegram-triggered call to this function would receive the additional
optional diagnostics fields on failure.

For planning only, assuming $2 per million input tokens and $12 per million
output tokens, 5,000–10,000 input tokens plus the 5,000-output-token cap estimates
$0.07–$0.08 for one generation. This is an arithmetic estimate, not verified
pricing for the configured model, a bill, or an account-level spending cap.
Reasoning/output usage and any prior timed-out request charge must be checked
against actual provider usage after an approved call.

## Pre-call blocker found after v33 deployment

v33 was deployed and its three changed source files verified remotely. Before
spending the separately approved generation request, the existing job was checked:
it remains FAILED_PROVIDER. The manual mode override guard accepts only
CLASSIFICATION_UNCERTAIN, so the approved request would be rejected before any
OpenAI call. No live request was sent and no job state was reset.

The minimal follow-up permits an explicit MANUAL/EXPLORATION/ANALYSIS_CONTEXT
override for an existing attempted FAILED_PROVIDER job as well. The existing
reservation RPC already supports FAILED_PROVIDER and preserves lease/duplicate
checks. No migration, automatic retry, or classifier repeat is added. A mock
regression covers uncertain -> failed -> explicit retry -> DRAFT -> NOOP, with one
classifier call, cumulative usage preserved and no duplicate brief. All Deno
nonintegration tests now pass: 693 (29 steps). This follow-up needs approval to
deploy before consuming the already approved one-generation request.

## Approved v34 deployment and one live request

User separately approved deployment and one generation request. v34 was deployed
to `byymtttpwmllqvggnddm`, ACTIVE status and returned runtime source files verified.
The only runtime change from v33 was the manual retry guard in orchestrator.ts.

Exactly one POST was sent, 2026-10-12 13:43:02–13:43:33 UTC, using the existing
invoke secret from the original `.env.local` without printing it. Request ID:
`4ee9b639-c067-4199-8dda-021388667a54`. Candidate and job are unchanged. A local
exclusive-create attempt marker prevents accidental repeat of that invocation.

Result: FAILED_VALIDATION; error codes STYLE_SLIDE_INDEX (5 occurrences) and
STYLE_ROLE_ORDER (2 occurrences). Production function logs confirm v34 and this
status. OpenAI generation returned parseable JSON and reached the quality gate;
no provider exception occurred in this request. This does not retroactively prove
the cause of the earlier v32 FAILED_PROVIDER.

Job totals after request: provider_calls 3, input_tokens 25,440, output_tokens
2,850, retry_count 0, estimated_cost_usd $0.085080, creative_brief_id null.
Delta for this request: one provider call, 22,719 input tokens, 2,787 output tokens,
zero retries and $0.078882 estimated cost. Actual invoice cost remains unverified.
No brief was saved and no M9/PNG/Storage/Telegram action was performed.

Code comparison confirms the Exploration prompt omitted a one-based `index`
requirement and replaced the fixed role order with "Use a distinct role per
message", while the style gate requires the prefix of
HOOK, CONTEXT, KEY_FACT, IMPLICATION, KEY_FACT, IMPLICATION. The returned output
was not retained or logged, so its exact wrong values cannot be reconstructed.

A PR-only follow-up makes the Exploration prompt explicitly match these existing
index and role requirements. It does not normalize returned roles, relax the
gate, change Standard prompts, or trigger a paid repair. Mock prompt-contract test
failed first and then passed; all nonintegration Deno tests now pass: 694
(29 steps). This prompt change is NOT in deployed v34. Deployment of this
follow-up and any further live request require new user approval.

## Approved v36 retry and follow-up finding

After a fresh user approval, the prompt correction was deployed as v35. Before
invoking it, the previous live job state was checked and revealed FAILED_VALIDATION
was not allowed by the manual retry guard. No request was made against v35.
The guard was extended to permit an explicit MANUAL Exploration retry for an
attempted FAILED_VALIDATION job. A mocked regression verifies that it resumes
without classification and creates a DRAFT only after the next output validates.

The combined source was deployed as v36 and verified ACTIVE with all returned
runtime files matching the deployment bundle. Exactly one POST followed at
2026-10-12 13:55:55–13:56:27 UTC (request ID
`af4ad453-993a-496a-8a91-7a5b443dffbf`). There were no automatic retries. OpenAI
returned structured output, but validation stopped at
`EXPLORATION_ATTRIBUTION_MISSING`. The status came from the existing quality gate,
which requires each `slides[].claims[].text` to itself contain a report marker such
as `보도`, `따르면`, `reported`, or `according to`. The general instruction to
attribute claims to publishers did not state this literal requirement.

Job totals: 4 provider calls, 48,242 input tokens, 6,003 output tokens, 0 retries,
$0.168520 estimated cumulative cost, and no creative brief. This invocation added
22,802 input / 3,153 output tokens and $0.083440 estimated cost under the stored
rates. No raw model output was stored in logs; exact claim wording is unavailable.
No brief or downstream rendering/storage/Telegram action occurred.

A further PR-only prompt clarification now tells each claim to include publisher
name and an explicit report marker inside the claim text, with the tested example
`[publisher_name] 보도에 따르면 …`. It leaves the quality gate unchanged. Tests
assert this instruction for every Exploration content mode. This latest prompt
revision has not been deployed, and no further paid call has been made.

## Approved v37 live verification — 2026-10-12

The claim-attribution prompt correction was deployed to Production project
`byymtttpwmllqvggnddm` as creative-generation v37. Returned runtime source files
were compared against the deployment bundle and matched. Exactly one manual
request was sent for the existing BBC candidate at 14:03:29–14:03:54 UTC.
Request ID `602c95cd-53e1-402a-972d-9889f4f1511e`; no automatic retry.

The function returned HTTP 200 / DRAFT with brief
`6a8048cc-ebbb-4a74-9948-f5c868661276`. A read-only Production DB join confirms
job and brief are both DRAFT, content mode ANALYSIS_CONTEXT, five slides and one
source saved, with a 414-character caption. Production function logs tie the
DRAFT result to deployment v37.

This request added 22,855 input tokens and 2,580 output tokens, zero retries, and
$0.076670 estimated cost at the configured accounting rates. Job cumulative totals
are 5 provider calls, 71,097 input / 8,583 output tokens and $0.245190 estimated
cost. A brief was saved. No image rendering, Storage upload, or Telegram delivery
was requested or performed.

Outcome: the current end-to-end Creative Generation path now reaches an actual
DRAFT for this article. The historical v32 FAILED_PROVIDER itself remains
unattributable: v32 persisted only the generic category and its logs contain no
upstream status or exception. The successful v37 request demonstrates that the
same Production provider path and configured credentials can now generate and
pass the quality gate; it cannot reconstruct the specific earlier exception.
