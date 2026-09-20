# MU Instant Intelligence Run Design

## 1. Goal

Add a manual n8n workflow named `MU Instant Intelligence Run` that runs the existing Instagram ingestion, intelligence, creative-generation, Notion projection, and Telegram alert pipeline once on demand, then sends a fresh deterministic Telegram Top 3 report from the data produced by that execution.

The existing 09:00 KST `Telegram Morning Brief` remains unchanged in meaning and continues to use its daily `(thread_id, briefing_date)` idempotency contract.

## 2. Constraints and success criteria

- Supabase remains canonical; n8n only orchestrates HTTP calls.
- The scheduled collector workflow is not modified to add manual behavior.
- The Morning Brief workflow and `telegram-morning-brief` daily dedupe remain intact.
- A new manual execution is allowed multiple times per day.
- A retry or duplicate delivery for the same `request_id` must not create another Instant report or resend delivery slots already recorded as sent.
- A new n8n Manual Execute receives a new execution id and is therefore a new report.
- Instant reports and Morning Briefs use separate persistence and explicit source/type metadata.
- `/open N` resolves the newest numbered report across both sources: the latest Instant report until a newer Morning Brief is sent, then the newer Morning Brief.
- Candidate ordering, representative reference selection, cached-media preference, signed URL generation, OpenAI phrasing, and deterministic fallback reuse existing M6 modules.
- Thumbnail delivery never depends directly on an expiring Instagram upstream URL.
- Partial collector failure, fixture refresh failure, Notion failure, phrasing failure, and signed-URL failure are isolated according to the existing M6 behavior.
- No credential value or secret is committed to workflow JSON, source code, test fixtures, or response payloads.

## 3. Current M6 behavior to preserve

`telegram-morning-brief` currently:

1. Authenticates with `TELEGRAM_AGENT_INVOKE_SECRET`.
2. Loads the active `telegram_agent_configs` row.
3. Computes the KST briefing date.
4. Returns `ALREADY_SENT` when a row already exists for the owner thread and date.
5. Refreshes the ESPN-backed fixture state with last-canonical-state fallback.
6. Loads deterministic candidate rows from `M6Repository`.
7. Builds a frozen snapshot with `buildMorningBriefingSnapshot`.
8. Uses M6 OpenAI phrasing validation and fallback rendering.
9. Persists the frozen snapshot before sending Telegram messages.
10. Uses private Storage signed URLs when available and text/permalink fallback otherwise.

The Instant path should use the same domain modules and should not call the Morning Brief handler or attempt to bypass its daily dedupe.

## 4. Architecture

### 4.1 Edge Function

Add `supabase/functions/telegram-instant-report` with a server-only handler. It accepts an authenticated POST body:

```json
{
  "request_id": "n8n-execution-id"
}
```

The handler validates method, bearer secret, and a non-empty bounded request id. The runtime:

1. Claims or loads the `request_id` report record.
2. If the record is already sent, returns `ALREADY_SENT` without sending.
3. Loads current M6 configuration and current local date/time.
4. Performs the existing force fixture refresh and records a warning when the provider fails.
5. Reads the newest canonical candidate state after the preceding n8n pipeline completes.
6. Builds the Instant snapshot from the same candidate, representative-reference, signed-media, and phrasing modules used by M6.
7. Persists the snapshot and rendered delivery plan without persisting ephemeral signed URLs.
8. Sends only unrecorded delivery slots through the existing retrying Telegram client.
9. Records sent message ids and final report status.

The response is a safe delivery summary containing status, request id, report id, candidate count, sent count, render mode, and warnings. It never returns secrets or raw provider bodies.

### 4.2 Shared reporting modules

Extract the common report composition boundary into focused shared M6 code rather than copying the Morning Brief implementation. The common boundary accepts a report source (`MORNING` or `INSTANT`), candidate rows, fixture result, and a clock, and returns:

- a frozen snapshot without signed URLs;
- a render snapshot with short-lived signed URLs;
- Telegram message plans;
- safe generation metadata and warnings.

The existing Morning Brief entrypoint keeps its current response and dedupe behavior while delegating composition to this shared boundary. Instant rendering adds the Instant heading and current-run summary while retaining canonical candidate fields and `/open N` lines from the M6 renderer.

### 4.3 Persistence and idempotency

Add private service-only tables:

`app_private.telegram_instant_reports`

- `id uuid primary key`
- `request_id text unique not null`
- `thread_id uuid not null references app_private.telegram_threads(id)`
- `source text not null default 'INSTANT'` with an `INSTANT` check
- `report_date date not null`
- `candidate_snapshot jsonb not null`
- `rendered_message text not null`
- `generation_metadata jsonb not null default '{}'::jsonb`
- `status text not null` in `PENDING`, `SENDING`, `SENT`, `FAILED`
- `sent_at timestamptz`
- `last_error text`
- timestamps

`app_private.telegram_instant_report_deliveries`

- `id uuid primary key`
- `report_id uuid not null references app_private.telegram_instant_reports(id) on delete cascade`
- `slot integer not null`
- `message_type text not null` in `TEXT`, `PHOTO`
- `content text not null`
- `storage_path text`
- `status text not null` in `PENDING`, `SENDING`, `SENT`, `FAILED`
- `telegram_message_id bigint`
- `last_error text`
- timestamps
- unique `(report_id, slot)`

The report unique key handles request-level retries. Delivery rows handle normal partial-send retries and concurrent retry claims. A delivery slot transitions from `PENDING` to `SENDING` through a conditional update before the Telegram call and to `SENT` after a successful response. A retry never sends a slot already marked `SENT` or currently claimed by another execution. The external Telegram API has no idempotency key; the persisted claim is the system boundary used to prevent duplicate concurrent sends.

### 4.4 Latest numbered context

Add a shared latest-context resolver that compares the newest sent Instant report and newest sent Morning Brief for the same thread by creation/send time. It returns a source-tagged snapshot. Update only the Telegram agent's `/today` and numeric `/open` lookup to use this resolver. Alert lookup, Creative Brief state, and Morning Brief storage remain unchanged.

## 5. n8n workflow

Create `n8n/workflows/mu-instant-intelligence-run.json` with `active: false` in git and timezone `Asia/Seoul`:

```text
Manual Trigger
  -> Collect Active Instagram Accounts
  -> Run Content Intelligence
  -> Trigger Priority Creative Generation
  -> Sync Daily Intelligence to Notion
  -> Poll Selected Creative Generation
  -> Dispatch Telegram Alerts
  -> Send Instant Intelligence Report
```

The first seven HTTP nodes reuse the existing endpoint and credential references. The final node calls `/functions/v1/telegram-instant-report`, uses `Telegram Agent Invoke Secret`, sends JSON with `request_id: "={{ $execution.id }}"`, and preserves JSON response/status. No Code node is allowed.

Update the workflow validator and fixtures/tests to enforce this contract while retaining all existing scheduled-workflow checks.

## 6. Failure isolation

- Collector partial failure: continue with successful account data; the collector aggregate remains the input to intelligence.
- Intelligence failure: stop downstream report generation because no fresh canonical intelligence exists.
- Priority generation, selected polling, and Telegram alerts: continue-on-failure as in the existing scheduled pipeline; Instant report still runs and reports warnings.
- Fixture refresh failure: use the last canonical fixture state and include a warning.
- Notion failure: preserve canonical data and continue to Instant report.
- OpenAI failure or invalid output: deterministic fallback phrasing.
- Signed URL failure or missing cached media: text plus canonical Instagram permalink.
- Telegram delivery failure: bounded client retry and persisted per-slot status without retrying a slot already sent.

## 7. Testing strategy

Use RED -> GREEN -> REFACTOR for each new behavior.

Unit and handler tests must cover:

1. Instant report can send when today's Morning Brief already exists.
2. Two different Instant request ids can both send on the same date.
3. The same request id returns `ALREADY_SENT` after success.
4. Morning Brief daily dedupe still returns `ALREADY_SENT`.
5. `/open 2` resolves the latest Instant snapshot.
6. A newer Morning Brief makes `/open 2` resolve the Morning snapshot.
7. Candidate ordering is deterministic under ties.
8. Representative media selection is frozen in the snapshot.
9. Missing thumbnail falls back to permalink text.
10. Invalid OpenAI phrasing uses deterministic fallback.
11. Fixture failure continues with a warning.
12. Notion failure does not block report composition.
13. Collector partial failure does not block report composition.
14. Request and delivery retry do not duplicate sent slots.
15. Secret markers are rejected from workflow exports.

Database pgTAP must cover private table existence, unique request id, unique delivery slot, RLS, grants, status constraints, and the fact that no public/anonymous role receives access.

Verification must include focused Deno tests, the full Deno functions suite, pgTAP when local database tooling is available, n8n workflow validation, `git diff --check`, and a repository secret scan. A real E2E run is reported separately and is not replaced by a mock result when external credentials are unavailable.

## 8. Deployment and operator flow

The implementation will produce a deployable Edge Function, migration, n8n export, and validator contract. If n8n API access or a logged-in n8n browser session is available, import and credential binding can be automated; otherwise the generated JSON is the exact import artifact and activation remains an operator action. The workflow must be explicitly activated in n8n after import because repository exports intentionally remain inactive.

Operator flow after deployment:

1. Open `MU Instant Intelligence Run` in n8n.
2. Confirm the two existing credential references resolve.
3. Click `Execute Workflow`.
4. Inspect the final report response and Telegram message.

The 09:00 Morning Brief remains a separate workflow and is not replaced by this flow.
