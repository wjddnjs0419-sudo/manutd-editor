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
