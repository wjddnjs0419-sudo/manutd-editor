# MU Content Intelligence System — Milestone 6 Design

## 1. Goal

Milestone 6 turns the existing M4/M5 intelligence and creative-generation backend into a daily Telegram editorial operating console. The agent proactively sends a 09:00 KST morning briefing, pushes high-value event alerts, remembers the current editorial context across conversations, retrieves prior project context when explicitly needed, and exposes a small slash-command surface for controlled Creative Brief edits and selection.

The system remains human-in-the-loop. Natural-language conversation is read-only. Any state-changing editorial action requires an explicit slash command. Supabase remains canonical, n8n remains orchestration-only, Notion remains a visual/editorial projection, and Telegram becomes the operator interface rather than a new source of truth.

## 2. Product outcome and scope

A successful M6 run supports this complete workflow:

1. Before 09:00 KST, fixture and intelligence state are refreshed.
2. At 09:00 KST, Telegram receives a concise morning briefing with:
   - today's or upcoming Manchester United match context,
   - deterministic Top 3 content candidates,
   - one representative reference thumbnail per candidate when media is available,
   - the representative Instagram post permalink and source account for direct human verification,
   - FIRST_MOVER / MUST_COVER flags,
   - Creative Brief production status,
   - blocked or failed items,
   - a short no-change message when nothing meaningful changed.
3. The operator can enter `/open 2` to open the frozen second item from that briefing.
4. Follow-up natural-language questions use the active candidate/brief/match context without modifying data.
5. Historical questions such as “지난주 Bruno 콘텐츠 뭐였지?” retrieve relevant prior project context on demand.
6. Slash commands such as `/hook 3`, `/slide 3 더 짧게`, or `/caption 덜 자극적으로` create controlled append-only Creative Brief revisions.
7. New FIRST_MOVER / MUST_COVER transitions and important fixture changes trigger immediate deduplicated Telegram alerts.
8. Notion projections are updated where appropriate, but Notion failure never rolls back canonical Supabase state.

M6 v1 is single-user in operation but schema-compatible with future additional editors.

Out of scope: natural-language mutations, Telegram publishing, Instagram auto-posting, Figma automation, voice/image commands, real-time scorebot behavior, provider redundancy, full vector-RAG infrastructure, complex multi-user RBAC, and broad Notion administration.

## 3. Architectural ownership

M6 follows the established project rule: core logic lives in version-controlled Edge Function code; n8n schedules and transports events.

### Supabase

Supabase is canonical for:

- match fixtures and match status,
- Telegram users and allowlist,
- conversation/thread state,
- raw Telegram message history,
- rolling conversation summary,
- active editorial context,
- frozen morning briefing snapshots,
- alert deduplication state,
- command audit events,
- Telegram agent configuration.

Existing M4/M5 tables remain canonical for candidate priority, evidence, Creative Brief revisions, generation status, and production state.

### Edge Functions

Edge Functions own:

- fixture-provider adaptation and fixture normalization,
- briefing candidate selection and payload construction,
- briefing rendering fallback,
- memory/context assembly,
- historical retrieval,
- deterministic command parsing and validation,
- targeted revision orchestration,
- alert event creation and deduplication,
- Telegram webhook authorization and user allowlisting.

### n8n

n8n only:

- triggers the 09:00 KST morning briefing,
- invokes fixture refresh at configured intervals,
- forwards Telegram updates to the M6 agent endpoint,
- invokes alert checks after relevant M4/M5/fixture events,
- sends or routes returned Telegram messages.

n8n must not contain conversation-memory logic, command business rules, scoring logic, revision logic, fixture interpretation, or alert deduplication logic.

### Telegram

Telegram is the operator UI. It never becomes canonical project state.

### Notion

Notion remains projection-only:

- Daily Intelligence remains discovery/selection,
- Content Pipeline remains production workspace,
- Match Calendar remains the human-readable fixture view.

## 4. Fixture Intelligence

### 4.1 Provider strategy

M6 starts with exactly one sports fixture provider behind an adapter boundary so the provider can later be replaced without changing canonical schema or consumers.

Conceptual interface:

```ts
interface FixtureProvider {
  fetchFixtures(from: Date, to: Date): Promise<Fixture[]>;
  fetchMatch(externalMatchId: string): Promise<Fixture>;
}
```

Provider-specific field names and payloads must not leak into M5/M6 business logic.

### 4.2 Canonical match storage

`public.matches` stores Manchester United fixtures only for v1.

Conceptual fields:

- `id uuid primary key`
- `provider text not null`
- `external_match_id text not null`
- `competition text not null`
- `season text`
- `home_team text not null`
- `away_team text not null`
- `opponent text not null`
- `is_home boolean not null`
- `kickoff_at timestamptz not null`
- `venue text null`
- `status text not null`
- `home_score integer null`
- `away_score integer null`
- `provider_payload jsonb`
- `provider_updated_at timestamptz null`
- `last_synced_at timestamptz not null`
- `manual_override jsonb null`
- timestamps

Unique identity is `(provider, external_match_id)`.

Canonical time is stored as UTC-compatible `timestamptz`; Telegram and Notion render KST.

Supported statuses:

- `SCHEDULED`
- `LIVE`
- `FINISHED`
- `POSTPONED`
- `CANCELLED`

### 4.3 Sync policy

Default behavior:

- normal period: sync upcoming 60 days at 03:00 and 15:00 KST,
- every morning briefing run performs a fixture refresh immediately before briefing compilation,
- D-1 through kickoff: refresh hourly,
- LIVE: refresh every 15 minutes,
- after FINISHED: persist final state and return to normal cadence.

This is an editorial context service, not a real-time score product. Background schedule values may later move into config, but these are the M6 v1 defaults.

### 4.4 Match lifecycle context

M6 derives a local operating mode:

- `NORMAL_DAY`
- `MATCH_EVE`
- `MATCH_DAY_PRE`
- `MATCH_LIVE`
- `MATCH_POST`

This context can be injected into M6 conversation and used by M5 MATCH_CONTENT classification, but it does not replace M5’s evidence and grounding rules.

### 4.5 Notion Match Calendar

Existing Notion Match Calendar is a projection of `public.matches`. It may show:

- Match
- Competition
- Kickoff KST
- Home/Away
- Opponent
- Status
- Score
- Content Phase

Notion edits do not silently overwrite canonical fixture values. Any future manual correction must write to explicit Supabase override fields or a dedicated admin path.

## 5. Telegram persistence model

### 5.1 Users

`app_private.telegram_users`

- `id uuid primary key`
- `telegram_user_id bigint unique not null`
- `display_name text null`
- `role text not null default 'OWNER'`
- `is_active boolean not null default true`
- timestamps

M6 v1 allows only the configured owner user, but the schema supports adding editors later without a redesign.

### 5.2 Threads and active context

`app_private.telegram_threads`

- `id uuid primary key`
- `telegram_chat_id bigint not null`
- `telegram_user_id bigint not null`
- `active_candidate_id uuid null`
- `active_brief_id uuid null`
- `active_match_id uuid null`
- `active_content_pipeline_ref text null`
- `context_history jsonb not null default '[]'`
- `conversation_summary text null`
- `summary_message_count integer not null default 0`
- `summary_updated_at timestamptz null`
- `pending_action jsonb null`
- `pending_action_expires_at timestamptz null`
- `last_message_at timestamptz null`
- timestamps

The conversation is persistent. Current work is represented by explicit active-context pointers. `context_history` retains at most five entries for `/back`; pushing a sixth discards the oldest entry.

### 5.3 Message history

`app_private.telegram_messages`

- `id uuid primary key`
- `thread_id uuid not null`
- `telegram_message_id bigint null`
- `telegram_update_id bigint unique null`
- `role text not null`
- `message_type text not null`
- `content text not null`
- `metadata jsonb`
- `created_at timestamptz not null`

Roles include:

- `USER`
- `ASSISTANT`
- `SYSTEM_EVENT`

Message types include:

- `TEXT`
- `COMMAND`
- `BRIEFING`
- `ALERT`

Raw message history is retained. Incoming Telegram `update_id` is stored when available and is the idempotency key for duplicate webhook delivery. Rolling summary is only a prompt-optimization artifact and never replaces the audit history.

### 5.4 Frozen briefing snapshots

`app_private.telegram_briefings`

- `id uuid primary key`
- `briefing_date date not null`
- `thread_id uuid not null`
- `match_context jsonb`
- `candidate_snapshot jsonb not null`
- `rendered_message text not null`
- `generation_metadata jsonb`
- `sent_at timestamptz null`
- `created_at timestamptz not null`

The candidate snapshot freezes the exact numbered list shown to the operator.

Example:

```json
{
  "items": [
    {
      "position": 1,
      "candidate_id": "...",
      "priority_score": 88,
      "reference_post_id": "...",
      "reference_username": "utdreport",
      "reference_permalink": "https://www.instagram.com/p/...",
      "reference_media_asset_id": "..."
    },
    {
      "position": 2,
      "candidate_id": "...",
      "priority_score": 81,
      "reference_post_id": "...",
      "reference_username": "utddistrict",
      "reference_permalink": "https://www.instagram.com/p/...",
      "reference_media_asset_id": "..."
    }
  ]
}
```

Later score changes do not alter the meaning of `/open 2`. The representative reference identity is frozen with the briefing as well, so reopening an item can show the same post the operator saw that morning.

### 5.5 Alert event state

`app_private.telegram_alert_events`

- `id uuid primary key`
- `thread_id uuid not null`
- `event_type text not null`
- `candidate_id uuid null`
- `match_id uuid null`
- `event_fingerprint text unique not null`
- `payload jsonb not null`
- `status text not null`
- `sent_at timestamptz null`
- `last_error text null`
- `created_at timestamptz not null`

Statuses:

- `PENDING`
- `SENT`
- `FAILED`

### 5.6 Command audit

`app_private.telegram_command_events`

- `id uuid primary key`
- `thread_id uuid not null`
- `telegram_message_id bigint null`
- `command_type text not null`
- `target_candidate_id uuid null`
- `target_brief_id uuid null`
- `input_args jsonb not null`
- `status text not null`
- `result_brief_id uuid null`
- `error_code text null`
- `created_at timestamptz not null`

Every state-changing command must be auditable.

## 6. Agent configuration

`public.telegram_agent_configs` is versioned and has one active configuration.

Conceptual fields:

- `id uuid primary key`
- `version integer unique not null`
- `is_active boolean not null`
- `timezone text not null default 'Asia/Seoul'`
- `morning_brief_time time not null default '09:00'`
- `briefing_top_n integer not null default 3`
- `recent_message_limit integer not null default 12`
- `summary_trigger_count integer not null default 20`
- `alert_cooldown_minutes integer not null default 60`
- `model_config jsonb not null`
- timestamps

The initial operating time is 09:00 KST. The initial alert cooldown is 60 minutes, applied only where fingerprint identity alone does not suppress an equivalent repeated alert. Config changes must not require code changes.

## 7. Morning Briefing

### 7.1 Deterministic selection

The briefing builder, not the LLM, decides:

- current match lifecycle context,
- overnight changes,
- Top 3 candidate identities and order,
- FIRST_MOVER / MUST_COVER inclusion,
- Creative Brief status,
- blocked or failed production state,
- no-change state.

The LLM may only turn the supplied structured payload into concise Korean Telegram prose.

The LLM must not:

- change ranking,
- add candidates,
- invent facts,
- reinterpret score values,
- add unsupported reasons,
- replace canonical statuses.

### 7.2 Briefing contents

Normal format:

- date and match-day state,
- overnight collection/intelligence summary,
- Top 3 candidates,
- one representative thumbnail for each Top candidate when available,
- representative source account and direct Instagram permalink for human verification,
- flags and Priority Score,
- creative production status,
- blocked/failed items,
- short action hint.

Representative-reference selection is deterministic. Prefer a cluster post with an available cached media asset, then higher match confidence, higher source/account reliability where available, newer published time, and stable ID ordering as the final tie-breaker. Image posts use the image asset, carousels use the first carousel image, and video/Reel posts use a cached thumbnail when available. If no cached asset exists, send the candidate as text-only while retaining its permalink when available.

Telegram must not depend on expiring upstream Instagram media URLs. Thumbnail delivery uses the existing private Supabase Storage asset and a short-lived server-generated signed URL; the human-verification link uses the canonical `raw_posts.permalink`.

If no meaningful changes exist, a short “특이사항 없음” style briefing is still sent so the operator knows the system is healthy.

### 7.3 Failure behavior

The morning briefing is partial-failure tolerant.

- fixture provider unavailable → send briefing without fixture details and include a warning,
- LLM rendering failure → send deterministic template fallback,
- one candidate enrichment/query failure → isolate that candidate if possible,
- Telegram 429 → honor `Retry-After`,
- Telegram 5xx/network → bounded exponential retry,
- Telegram 401/403 → record failure and do not retry meaninglessly.

An OpenAI rendering outage must not suppress the entire scheduled briefing.

## 8. Conversation memory

Each read-only natural-language request is assembled from five layers:

1. static agent/system rules,
2. rolling conversation summary,
3. recent raw messages,
4. active candidate/brief/match context,
5. live Supabase project state.

Conversation summary may contain editorial preferences and conversational decisions, but it must not be trusted for current project facts such as Priority Score, match status, or latest Creative Brief revision. Those are always re-read from canonical tables.

Example context:

- current candidate,
- latest brief revision,
- content mode,
- creative status,
- current match and phase,
- recent messages,
- summary of older conversation.

### 8.1 Rolling summary

Default policy:

- keep the most recent 12 messages raw in prompt context,
- when 20 unsummarized messages have accumulated, fold the oldest messages into a new rolling summary while retaining the newest 12 raw messages,
- retain all raw messages in `telegram_messages`,
- do not delete source history when `/reset` is called.

## 9. Historical retrieval

Historical retrieval is conditional rather than always-on.

Examples that should trigger retrieval:

- “지난주 Bruno 콘텐츠 뭐였지?”
- “전에 골랐던 Hook 뭐였지?”
- “지난 경기 끝나고 만든 전술 분석 보여줘.”

Current-context questions should not trigger historical retrieval.

Lookup order:

1. structured relation lookup using match, candidate, briefing, or brief identity,
2. constrained text/keyword lookup over Telegram messages and Creative Brief history,
3. semantic/vector retrieval is explicitly deferred unless later usage proves it necessary.

Primary retrieval sources:

- `telegram_messages`
- `telegram_briefings`
- `content_candidates`
- `creative_briefs`
- `matches`

M6 v1 does not require a dedicated vector database. The conversational agent does not use external web search in v1; factual answers are grounded in current Supabase project state and retrieved project history.

## 10. Telegram command contract

Natural language is read-only. Database-changing actions require explicit slash commands.

Supported v1 commands:

- `/today`
- `/open <number|candidate_id|alert>`
- `/brief`
- `/hook <number>`
- `/slide <number> <instruction>`
- `/caption <instruction>`
- `/select`
- `/status`
- `/back`
- `/reset`
- `/confirm`
- `/cancel`
- `/help`

### 10.1 Read-only commands

`/today` returns the latest stored morning briefing.

`/brief` returns the current active Creative Brief.

`/status` summarizes current active candidate, Priority Score, mode, flags, brief revision, production state, and match context.

`/help` shows the compact command reference.

### 10.2 Context commands

`/open 2` resolves against the frozen current-day briefing snapshot, not live ranking.

`/open alert` opens the candidate or match from the latest actionable alert.

`/back` restores the previous bounded context from `context_history`.

`/reset` clears active working context and pending action only. It does not delete conversation history or summary.

### 10.3 Mutation commands

`/hook <n>` selects one of the existing hook options and creates a new append-only draft revision.

`/slide <n> <instruction>` revises only the requested slide. All other slides must remain unchanged unless a validation-required minimal change is unavoidable and explicitly recorded.

`/caption <instruction>` revises only the caption.

`/select` updates the existing M4.5 Notion Daily Intelligence `Selected=true` signal rather than inventing a new parallel selection system. Existing M5 generation contracts remain authoritative.

Command parsing is deterministic. The command determines the action type; only the free-text argument is passed to the model for scoped rewriting.

### 10.4 Protected-state confirmation

If the active production item is LOCKED or APPROVED, a mutation command must not overwrite it. The requested operation becomes a short-lived pending action and requires `/confirm`. `/cancel` discards it.

Pending actions expire exactly ten minutes after creation.

M6 v1 does not expose `/publish`, `/delete`, or direct Instagram posting.

## 11. Revision and grounding rules

Telegram edits reuse the M5 evidence boundary and append-only revision contract.

For `/slide` and `/caption`:

- existing evidence snapshot is authoritative,
- new external facts are prohibited,
- every factual claim remains grounded,
- analytical inference requires supporting evidence,
- new sources cannot be introduced,
- existing historical revisions remain immutable,
- one targeted command produces at most one successful new revision.

If a user asks for wording that cannot be supported by the evidence, the operation is rejected rather than hallucinated.

Content Pipeline behavior follows M5:

- EDITABLE item → update system-owned production content,
- LOCKED/APPROVED item → preserve existing item and create a new revision/item only after confirmation,
- Notion projection failure does not roll back the canonical Creative Brief revision.

## 12. Alert policy

Immediate alerts are limited to:

- new FIRST_MOVER transition,
- new MUST_COVER transition,
- match status transitions,
- kickoff changes,
- POSTPONED,
- CANCELLED,
- venue changes.

Duplicate prevention is mandatory.

Example fingerprint classes:

- `FIRST_MOVER:<candidate_id>:<transition-id>`
- `MUST_COVER:<candidate_id>:<transition-id>`
- `MATCH_STATUS:<match_id>:LIVE`
- `MATCH_STATUS:<match_id>:FINISHED`
- `FIXTURE_KICKOFF_CHANGED:<match_id>:<new-kickoff>`

A candidate remaining FIRST_MOVER while its score changes does not generate repeated alerts.

## 13. Security

All `app_private` M6 tables are service-only. anon/authenticated roles receive no direct access. `public.matches` and `public.telegram_agent_configs` also follow the existing backend-only access pattern unless a later milestone explicitly introduces a client read path.

Required protections:

- Telegram webhook secret validation,
- explicit Telegram user allowlist,
- server-side Telegram bot token,
- server-side OpenAI key,
- server-side Notion token,
- server-side Supabase service credentials,
- no tokens or authorization headers in logs,
- secret-safe provider and Telegram error messages,
- idempotent handling of duplicate Telegram deliveries.

The single-user v1 still stores user and chat identity explicitly so future editors can be added safely.

## 14. Testing strategy

Implementation follows TDD.

### Fixture tests

- repeated identical sync remains idempotent,
- kickoff change updates one match and emits one alert event,
- POSTPONED/CANCELLED changes persist correctly,
- repeated changed payload does not resend duplicate alert,
- provider adapter normalization is independent of provider-native field names.

### Morning briefing tests

- deterministic Top 3 order,
- deterministic representative-reference selection,
- thumbnail fallback when no cached asset exists,
- representative Instagram permalink preserved in the frozen briefing snapshot,
- correct FIRST_MOVER/MUST_COVER display,
- match-day mode behavior,
- no-news-day short briefing,
- blocked/failed status inclusion,
- LLM failure fallback,
- partial fixture failure,
- frozen numbering remains stable after later score changes.

### Memory tests

- recent message injection,
- rolling-summary creation,
- active-context injection,
- stale summary facts do not override live Supabase facts,
- `/reset` preserves historical messages,
- bounded context-history restoration.

### Historical retrieval tests

- current-context question does not search history,
- explicit prior-time reference does,
- match-scoped lookup uses structured relations first,
- prior brief/hook can be recovered without vector infrastructure.

### Command tests

- parser coverage for all supported commands,
- invalid indexes and malformed arguments,
- missing active candidate/brief,
- immutable prior revision,
- `/slide` changes only the target slide,
- `/caption` changes only caption,
- evidence-invalid edit rejected,
- LOCKED/APPROVED confirmation path,
- expired pending action,
- duplicate Telegram update idempotency,
- command audit event recorded.

### Security tests

- unauthorized Telegram user rejected,
- webhook secret required,
- anon/auth cannot access private tables,
- service credentials absent from workflow exports and logs.

### End-to-end smoke

A completion smoke must demonstrate:

1. fixture sync,
2. 09:00 briefing generation and Telegram delivery with representative thumbnail + source permalink where available,
3. `/open 1` reopening the same frozen representative reference,
4. read-only active-context question,
5. historical retrieval question,
6. `/brief`,
7. targeted `/slide` revision,
8. Content Pipeline projection,
9. FIRST_MOVER or MUST_COVER alert dedupe,
10. fixture-change alert,
11. partial failure isolation,
12. secret scan.

## 15. Completion criteria

M6 is complete when the production flow can reliably behave as an editorial agent rather than a stateless chatbot:

- it proactively reports every morning at 09:00 KST,
- it knows whether today is a normal day, match eve, pre-match, live, or post-match context,
- it pushes only important deduplicated alerts,
- it remembers recent conversational context,
- it maintains a compact rolling summary,
- it keeps a persistent active candidate/brief/match pointer,
- it retrieves prior project history only when needed,
- it treats normal natural language as read-only,
- it requires explicit slash commands for mutations,
- it creates safe append-only targeted brief revisions,
- it preserves grounding and protected production states,
- it keeps Supabase canonical and Notion/n8n/Telegram as bounded projections or interfaces.

## 16. Explicit non-goals

M6 does not implement:

- natural-language state mutation,
- Telegram publishing or deletion commands,
- Instagram publishing,
- multi-user permission UI or complex RBAC,
- vector-first RAG infrastructure,
- real-time score coverage,
- primary/fallback fixture-provider orchestration,
- automatic Figma design,
- image generation,
- voice commands,
- generalized Notion CMS management,
- M7 performance feedback and calibration.
