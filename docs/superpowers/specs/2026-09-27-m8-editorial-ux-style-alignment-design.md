# M8 Editorial UX + ManUtd Editor Creative Style Alignment

## Status

Approved product direction: build the Telegram editorial console and
ManUtd Editor style contract on the current `main` branch. Figma is explicitly
out of scope and remains an M9 integration. Production rollout is allowed for
this task after local verification and an explicit deployment step.

## Goal

Turn Telegram into a low-typing editorial console for canonical M8 stories:

```text
M8 intelligence completes
  -> one deduplicated Telegram summary
  -> recommended/all canonical story list
  -> story detail/evidence/skip
  -> one-tap canonical Creative Generation
  -> ManUtd Editor structured carousel draft
```

Natural language and existing slash commands remain supported as fallback
interfaces, but they must delegate to the same business actions used by inline
button callbacks.

## Current-state diagnosis

- M7/M8 orchestration is a Supabase-native `editorial_jobs` queue consumed by
  `orchestration-worker`, chaining collection, analysis, intelligence, source
  discovery, grounding, ranking, priority generation, Notion projection,
  selected polling, and alert dispatch.
- Intelligence writes `app_private.intelligence_readiness` with
  `RUNNING`, `SUCCEEDED`, or `FAILED`. The worker treats the intelligence
  boundary as complete on a successful HTTP response and the readiness row is
  the canonical completion/readiness source.
- `telegram-alerts` currently dispatches transition, fixture, and dead-job
  events as plain text. `telegram-morning-brief` owns the daily 09:00 briefing
  and currently renders a small fixed snapshot without inline keyboards.
- `telegram-agent` accepts message updates and routes explicit slash commands
  before routing all other text to the read-only conversational LLM.
- The phrase `이거 카드뉴스로 만들거야` therefore does not call
  `creative-generation`; it is currently handled as natural-language prose.
- `creative-generation` is the canonical evidence-grounded generation path,
  but its active M5 prompt and quality gate describe a generic grounded brief,
  require four to seven slides, require slide body text, and have no ManUtd
  Editor public-copy contract.
- Existing M6 repository and briefing snapshots are candidate-oriented and
  top-three-oriented. They do not provide the full current canonical story
  list, story detail, evidence view, or callback navigation state.

## Scope and non-goals

In scope:

- Inline-keyboard Telegram summary, pagination, story detail, evidence, skip,
  back navigation, carousel generation, minimal text-Reel planning, and draft
  rendering.
- Canonical story queries built from M8 editorial rankings and story clusters,
  not independent raw-post cards.
- A shared action layer used by callbacks, natural-language intents, and the
  existing slash-command paths.
- A versioned `manutd_editor` creative style profile and deterministic public
  copy validation.
- Safe interaction observability, idempotency, stale-callback handling, local
  verification, `main` push, and approved remote Supabase rollout.

Out of scope:

- Figma creation or editing; that is M9.
- Instagram publishing, auto-approval, video editing, copyrighted-footage
  retrieval, YouTube/TikTok publishing, or finished Reel generation.
- Replacing M4 Priority Score, M8 grounding semantics, or the M7 queue.
- Removing natural-language or existing slash-command support.

## Architecture

### One Telegram boundary, one action layer

Keep the existing direct `telegram-agent` webhook. Extend its update parser to
accept both ordinary `message` updates and Telegram `callback_query` updates.
The function will authenticate and deduplicate both shapes before dispatching
to a shared `EditorialConsoleAction` service.

The action service owns these canonical actions:

```text
OPEN_RECOMMENDED(page)
OPEN_ALL(page)
OPEN_STORY(candidate_id)
OPEN_EVIDENCE(candidate_id)
SKIP_STORY(candidate_id)
GENERATE_CAROUSEL(candidate_id)
OPEN_REEL(candidate_id)
SELECT_DRAFT(brief_id)
SHOW_ALTERNATE_HOOKS(brief_id)
BACK
```

Callbacks, deterministic natural-language intents, and slash commands call the
same functions. No callback path may render an arbitrary LLM response in place
of a canonical action.

### Intelligence-complete notification

Extend the existing `app_private.telegram_alert_events` outbox with an
`INTELLIGENCE_COMPLETE` event type. `telegram-alerts` will read the latest
successful same-business-date M8 ranking after the existing worker chain has
reached alert dispatch, build a stable fingerprint from the current canonical
story/ranking set, and insert one pending event only when there are current
stories and the fingerprint is new.

The fingerprint includes the business date, ranking version, ordered story
cluster IDs, ranks, editorial scores, information-gap scores, audience-signal
scores, grounding status, and news eligibility. It excludes run timestamps and
model metadata. Repeating an unchanged run therefore does not spam Telegram;
meaningful ranking/story changes create a new summary event.

The summary is one compact message with two inline buttons:

```text
📡 오늘의 맨유 인텔리전스

새롭게 확인된 소재 12개
추천 후보 5개

🔥 가장 유력한 소재
<canonical story title>

[🔥 추천 소재] [📚 전체 소재]
```

The existing 09:00 `telegram-morning-brief` remains backward-compatible and
continues to own the daily briefing. The new event is an additional change-
driven console entry point, not a replacement for the morning briefing.

### Canonical story views

Create a focused server-only editorial-console repository that joins:

- `app_private.editorial_rankings` for current ranking and M8 editorial
  components;
- `public.story_clusters` for the canonical title, summary, lifecycle, and
  last-seen state;
- `public.content_candidates` for the canonical generation target and legacy
  priority flags;
- `public.creative_briefs` for the latest generation status;
- `public.story_cluster_sources` and the M8 grounding tables for source counts
  and evidence views.

The repository never presents raw posts as independent default stories. Raw
posts remain evidence under a story cluster.

Recommended and all views use five stories per page. Recommended is sorted by
the latest M8 rank and excludes a skipped story for the current ranking window
when its story fingerprint has not changed. All is the full current canonical
story set that passed Manchester United relevance filtering, regardless of
rank; it may still show discovery-only or not-news-eligible stories with a
small, editor-facing status label.

The compact public score mapping is deterministic:

```text
information_gap = editorial_rankings.information_gap_score
hook_strength = round((information_gap_score + discovery_audience_signal_score) / 2)
shareability = discovery_audience_signal_score
source_confidence = fact_grounding_score
```

These labels are an editorial presentation mapping only. They do not change
M8 ranking math.

### Navigation and state

Add `app_private.telegram_console_state`, one current state row per Telegram
thread. It stores only server-controlled navigation state: view, page,
ranking date, candidate/brief target, Telegram message ID, and a state version.
Callbacks must verify the callback message belongs to the current console
message; an old callback returns a safe stale response and performs no action.
Canonical data is reloaded for every callback. Telegram display text and
conversation history are never treated as authoritative state.

Add `app_private.telegram_editorial_dispositions` for human decisions such as
`SKIPPED`. A disposition is keyed by thread, candidate, ranking date, and the
current story fingerprint. Skipping never deletes a story or source and does
not hide it from the all-stories view.

Add `app_private.telegram_console_events` for safe operational metadata:
summary sent, list opened, story opened, evidence opened, generation requested,
generation completed/failed, story skipped, draft selected, and stale callback
outcomes. Event rows contain IDs, action/status, and bounded metadata only; no
tokens, signed URLs, full prompts, or raw upstream responses.

### Telegram API client

Extend the existing Telegram client without breaking current callers:

- `sendText` and `sendPhoto` accept optional inline keyboard markup;
- `editMessageText` edits an existing navigation message;
- `answerCallbackQuery` acknowledges a callback promptly and can show a short
  safe error;
- all methods retain bounded retry/error categorization and never log bot
  tokens.

`telegram-agent` persists callback updates through the existing update-dedupe
path. Callback messages use the existing private message table with a console
message type/metadata extension rather than a second inbound log.

## Canonical generation path

`GENERATE_CAROUSEL(candidate_id)` performs the following sequence:

```text
callback or natural-language intent
  -> reload canonical story/candidate
  -> call creative-generation with trigger_type=MANUAL
  -> creative-generation builds the frozen M8/M5 evidence snapshot
  -> classifier + structured provider + deterministic quality/style gates
  -> append-only READY creative_briefs revision
  -> reload canonical brief by ID/fingerprint
  -> Telegram renderer shows public slides + separate editor warning
```

The Telegram conversational provider is not allowed to generate carousel copy
for this action. Repeated taps are safe because the existing candidate/evidence
fingerprint and generation lease return/reuse the same READY brief or safely
report a canonical failure state.

`SELECT_DRAFT` marks the current canonical brief `SELECTED` with `selected_at`
and updates the Telegram console state. It does not publish to Instagram and
does not create a Figma file.

`OPEN_REEL` produces only a bounded TEXT_REEL plan from the same canonical
story/evidence packet. It does not download or edit video.

## ManUtd Editor style contract

Create one shared versioned profile:

```text
supabase/functions/_shared/editorial-style/
  types.ts
  manutd_editor.ts
  golden_examples.ts
  validator.ts
```

Canonical identity:

```json
{
  "style_profile": "manutd_editor",
  "style_version": "manutd-editor-v1"
}
```

The profile requires Korean, concise football-fan language; a direct current
situation; strong but supported hooks; short visual lines; limited attribution;
and no academic/report prose, unsupported cause/effect, fake quotes, invented
facts, or filler slides.

The preferred structure is:

```text
HOOK       1–2 headline lines, optional highlight, normally no body
CONTEXT    concise development of the situation
KEY_FACT   strongest supported number/contrast/status/quote
IMPLICATION optional grounded next development or fan question
```

The default output is three or four meaningful slides. A fourth slide is
optional. Missing evidence produces an `editor_warning` such as
`현재 근거로는 3장까지 구성하는 것이 적절합니다.` outside the public slide
copy; the generator must never add a filler slide containing research-limit
language.

Structured slide fields are:

```json
{
  "index": 1,
  "role": "HOOK",
  "headline": "...",
  "highlight": "...",
  "body": null,
  "closing_line": null
}
```

The stored `creative_briefs` row also records `style_profile` and
`style_version`; old M5 rows remain readable with nullable legacy values.
`generation_metadata` continues to preserve internal model/config provenance.
Internal grounding, unsupported claims, source caveats, and research limits
remain in the evidence/grounding fields and are never rendered as public slide
copy.

Golden examples for Sancho and Garnacho are test fixtures and style references
only. Their facts must not be appended to unrelated generation prompts or leak
into unrelated outputs. The prompt receives style rules and structural traits,
while the current story's frozen evidence remains the only factual source.

The deterministic validator rejects at least:

- forbidden internal phrases in public headline/highlight/body/closing/caption;
- blank headline or missing story/style identity;
- invalid role order or slide numbering;
- more than four slides or fewer than three for a completed carousel;
- body text on a HOOK when the profile requires a clean cover;
- obviously excessive copy length;
- unsupported/unknown evidence IDs and ungrounded claims.

## Natural-language fallback

Before the read-only conversational LLM, recognize deterministic intents when
the request has a clear meaning and an active canonical target:

- `오늘 올릴 거 보여줘`, `오늘 뭐 있어?`, and `추천 소재` →
  `OPEN_RECOMMENDED(1)`;
- `전체 수집한 거 보여줘`, `전체 소재` → `OPEN_ALL(1)`;
- `이거 카드뉴스로 만들어줘`, `이거 카드뉴스로 만들거야` →
  `GENERATE_CAROUSEL(active_candidate_id)`;
- `다음 거 보여줘` → next page in the current console view.

If there is no active candidate for a generation intent, return a deterministic
prompt to open a story first. Other natural-language messages remain read-only
and use the current conversational context path.

Existing `/today`, `/current`, `/open`, `/brief`, `/hook`, `/slide`, `/caption`,
`/select`, `/status`, `/back`, `/reset`, `/confirm`, `/cancel`, and `/help`
remain valid. Where an equivalent console action exists, the slash command
delegates to it; protected revision confirmation rules remain unchanged.

## Error and idempotency behavior

- Telegram update IDs remain the first dedupe boundary for both messages and
  callbacks.
- Callback actions reload canonical state and reject stale console messages
  without mutating data.
- The existing creative generation fingerprint and lease prevent duplicate
  READY briefs from double taps.
- Story skip is an append/update decision record, never a source/story delete.
- A missing ranking or empty current story set produces a compact deterministic
  empty state and no summary notification.
- Generation `BLOCKED_EVIDENCE`, `CLASSIFICATION_UNCERTAIN`, provider failure,
  and style validation failure render safe editor-facing errors; they do not
  create an arbitrary public draft.
- Telegram API failures mark the existing outbox event failed and preserve it
  for the established retry/recovery path.
- Logs and event metadata exclude secrets, signed URLs, raw provider payloads,
  and full prompts.

## Database changes

Add one additive migration that:

- adds `INTELLIGENCE_COMPLETE` to the alert event type constraint;
- adds a `CONSOLE` message type if needed by the inbound/outbound audit path;
- creates service-role-only `telegram_console_state`;
- creates service-role-only `telegram_editorial_dispositions`;
- creates service-role-only `telegram_console_events`;
- adds nullable `style_profile` and `style_version` fields/checks to
  `public.creative_briefs`;
- preserves all existing RLS, grants, unique keys, and append-only creative
  revision behavior.

Seed/config changes activate `manutd_editor-v1` behavior with a 3–4 slide
quality window while keeping old M5 rows and test fixtures compatible.

## Verification contract

Deterministic tests must cover:

1. one intelligence-complete summary event for a successful changed ranking;
2. no duplicate summary for an unchanged ranking fingerprint;
3. recommended and all-story pagination at five items per page;
4. canonical story detail and back navigation;
5. evidence rendering from M8 grounding without internal JSON leakage;
6. skip persistence without story deletion and skip reappearance rules;
7. callback update authentication, dedupe, stale callback rejection, and
   callback acknowledgment;
8. repeated callback idempotency;
9. card callback invoking canonical `creative-generation` with `MANUAL`;
10. button and natural-language generation using the same action function;
11. conversational LLM never bypassing canonical generation;
12. style profile identity, role ordering, forbidden-copy rejection, 3-slide
    and 4-slide acceptance, and no filler slide;
13. Sancho-like HOOK → CONTEXT → KEY_FACT fixture behavior;
14. golden facts not leaking into unrelated fixtures;
15. concise caption validation and attribution preservation;
16. existing slash-command, M5 revision, M7 worker, and M8 grounding/ranking
    regressions.

The local gate is the existing M8 Phase B/C smoke plus focused new Deno/DB
tests, architecture validation, secret scan, `git diff --check`, and a clean
`main` worktree.

## Deployment and rollout

After local verification:

1. Commit the implementation on `main` and push `origin/main`.
2. Apply the linked migration with `supabase db push --linked`.
3. Run linked DB lint and verify migration state.
4. Deploy changed Edge Functions: `telegram-agent`, `telegram-alerts`, and
   `creative-generation` (plus any explicitly added function only if the final
   implementation needs one).
5. Confirm required remote secrets exist without printing values, especially
   `COLLECTOR_INVOKE_SECRET`, `TELEGRAM_AGENT_INVOKE_SECRET`,
   `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_OWNER_THREAD_ID`, and
   `OPENAI_API_KEY`.
6. Verify the existing direct Telegram webhook points at the deployed
   `telegram-agent`; re-register only if the remote webhook is absent or points
   elsewhere, using the existing secret-safe helper.
7. Run a bounded remote smoke: invoke the protected functions without exposing
   secrets, verify an M8 summary/outbox result, and verify a callback/update
   path only when safe test data is available.

No Figma API, Figma token, or Figma file is involved in this rollout.
