# M8 Editorial UX + ManUtd Editor Creative Style Alignment — Implementation Plan

## Goal

Implement the approved Telegram editorial console and ManUtd Editor creative
style contract on `main`, preserve M1–M8 behavior, verify deterministic and
regression coverage, push `main` to `origin`, and complete the explicitly
approved remote Supabase production rollout. Figma remains an M9 non-goal.

## Architecture

- Keep the direct `telegram-agent` webhook as the Telegram boundary.
- Add one shared editorial-console action layer used by callback queries,
  deterministic natural-language intents, and equivalent slash commands.
- Treat `app_private.editorial_rankings` + `public.story_clusters` as the
  canonical story source; raw posts remain evidence only.
- Use the existing `telegram_alert_events` outbox for one deduplicated
  `INTELLIGENCE_COMPLETE` summary event.
- Persist navigation in server-side console state and persist skip decisions as
  editorial dispositions; reject stale callbacks using the current message
  identity.
- Route card generation through `creative-generation` with `MANUAL`, then apply
  the shared `manutd_editor-v1` style profile and deterministic public-copy
  validator before rendering Telegram output.
- Keep `creative_briefs` append-only/idempotent and retain old M5 rows as
  readable legacy data.

## Tech Stack

- Supabase PostgreSQL migrations and pgTAP tests.
- Supabase Edge Functions in TypeScript/Deno.
- Existing REST/PostgREST repositories and Telegram Bot API client.
- Existing OpenAI structured generation path; no live provider calls in
  deterministic tests.
- Existing shell smoke, Deno tests, architecture checks, secret scan, and
  `supabase` CLI for linked remote rollout.

## Spec

Implement the design in:

`docs/superpowers/specs/2026-09-27-m8-editorial-ux-style-alignment-design.md`

The implementation must satisfy the user request's numbered UX, style,
callback, state, observability, test, README, non-goal, and final-report
requirements. The design document is the source of truth for the action names,
state model, event fingerprint, style identity, and rollout boundary.

## Global Constraints

- Work on the checked-out `main` branch; do not create a worktree or feature
  branch.
- Use `apply_patch` for source, migration, test, and documentation edits.
- Do not implement Figma, image rendering, publishing, video editing, or
  automatic approval.
- Never expose Telegram/OpenAI/Supabase secrets, signed URLs, full prompts, or
  raw provider responses in logs, command output, or tests.
- Do not trust Telegram message text or stale callback payloads as canonical
  data; reload from the database for every action.
- Do not delete canonical stories or source rows when skipping.
- Preserve existing slash commands, M7 orchestration, M8 grounding/ranking,
  and M5 revision confirmation behavior.
- No production deployment until local tests and migration/function checks are
  green; production deployment is authorized by the user's explicit
  `/goal 원격 production까지 ㄱㄱ` instruction.

## Review Focus

- Canonical action equivalence: buttons, deterministic natural language, and
  slash commands must converge on the same service functions.
- Story clustering: default lists must show one canonical story per event,
  with sources/evidence behind the detail view.
- Idempotency: update dedupe, outbox fingerprinting, stale callbacks, and
  creative-generation leases must all be independently tested.
- Public/internal boundary: research limitations and grounding metadata must
  never leak into carousel copy, while source caveats remain available to the
  editor.
- M5 compatibility: legacy briefs and revision flows must continue to parse and
  render even when style fields are null.
- Remote rollout: migration state, secrets, webhook target, deployed function
  versions, and a bounded smoke must be verified without secret disclosure.

## Task 1: Establish focused test fixtures and shared contracts

### Files

- Add `supabase/functions/_shared/editorial-style/types.ts`.
- Add `supabase/functions/_shared/editorial-style/manutd_editor.ts`.
- Add `supabase/functions/_shared/editorial-style/golden_examples.ts`.
- Add `supabase/functions/_shared/editorial-style/validator.ts`.
- Add focused Deno tests beside the shared style modules.

### TDD steps

1. Write failing tests for the `manutd_editor` identity/version, Korean copy
   constraints, `HOOK -> CONTEXT -> KEY_FACT -> optional IMPLICATION` roles,
   three- and four-slide acceptance, forbidden internal phrases, concise
   caption behavior, evidence ID validation, and Sancho/Garnacho fixture
   isolation.
2. Define the typed structured output contract for slides, captions,
   `editor_warning`, and internal grounding.
3. Add the versioned profile constants and golden examples as style-only
   fixtures; ensure their facts are never used as generation evidence.
4. Implement the deterministic validator and make the tests pass.

### Verification

- Run the focused Deno style test file.
- Confirm `rg` shows no unrelated prompt importing golden-example facts.
- Commit: `test/style: define ManUtd Editor contract fixtures`.

## Task 2: Add additive database state and migration tests

### Files

- Add the next timestamped migration under `supabase/migrations/`.
- Add/extend pgTAP tests under `supabase/tests/`.

### TDD steps

1. Add failing pgTAP assertions for:
   - `INTELLIGENCE_COMPLETE` in the alert event type constraint;
   - console message type support if used;
   - `app_private.telegram_console_state` keys, ownership, JSON checks, and
     indexes;
   - `app_private.telegram_editorial_dispositions` decision/fingerprint keys;
   - `app_private.telegram_console_events` bounded metadata and event indexes;
   - nullable `creative_briefs.style_profile` and `style_version` checks;
   - preserved existing RLS/grants/unique constraints.
2. Write the additive migration without changing existing M1–M8 semantics.
3. Add service-only policies/grants consistently with existing `app_private`
   tables and verify old rows remain valid.
4. Make pgTAP assertions pass against a fresh local database.

### Verification

- Run the focused DB test and schema lint.
- Inspect the generated schema diff for accidental public exposure.
- Commit: `feat(db): add Telegram console and style state`.

## Task 3: Build the canonical editorial-console repository and renderer

### Files

- Add a focused repository/action module under
  `supabase/functions/_shared/m6/` (or the closest existing shared M6
  boundary).
- Add list/detail/evidence/reel/draft renderer modules.
- Add deterministic Deno tests for repository joins and rendering.

### TDD steps

1. Write failing fixtures for canonical story clusters with multiple raw posts,
   M8 rankings, grounding states, sources, candidates, and old/new briefs.
2. Implement current ranking selection and canonical story mapping, including
   recommended/all views, five-item pagination, score labels, source counts,
   and skip filtering only for the same story fingerprint/window.
3. Implement compact list, story detail, evidence, empty state, and TEXT_REEL
   renderers with no model IDs, prompt versions, fingerprints, or raw JSON.
4. Implement deterministic callback short-ID/session mapping; never embed long
   story content in callback data.
5. Add back navigation state and draft rendering with separate editor warning.

### Verification

- Assert duplicate source posts become one list item.
- Assert all-stories includes relevant lower-ranked/discovery-only stories.
- Assert evidence view contains source caveats while public draft does not.
- Commit: `feat(telegram): add canonical editorial console views`.

## Task 4: Extend Telegram client, update parser, callback router, and action layer

### Files

- Update `telegram-agent/telegram.ts` (or current client location).
- Update `telegram-agent/handler.ts` and `telegram-agent/index.ts`.
- Add shared action/router modules and focused unit tests.
- Update existing command handlers only to delegate where an equivalent action
  exists.

### TDD steps

1. Write failing tests for inline keyboard serialization, message editing,
   callback acknowledgment, callback authentication, callback update dedupe,
   malformed/unknown callback safety, and canonical reload after each tap.
2. Extend the Telegram client with inline markup, `editMessageText`, and
   `answerCallbackQuery` while preserving current `sendText`/`sendPhoto` calls.
3. Accept private `callback_query` updates, resolve the thread, persist the
   inbound update through the existing dedupe boundary, and acknowledge it
   promptly.
4. Implement `OPEN_RECOMMENDED`, `OPEN_ALL`, `OPEN_STORY`, `OPEN_EVIDENCE`,
   `SKIP_STORY`, `OPEN_REEL`, `BACK`, draft actions, and stale-message checks.
5. Prefer editing the current navigation message; create a new message only
   for a clean generated-draft result when needed.
6. Map supported natural-language phrases to the same action functions before
   the read-only LLM. Preserve all existing slash commands and help text.
7. Add safe error responses and console event instrumentation.

### Verification

- Test repeated callbacks, stale callbacks, back navigation, skip persistence,
  and equivalent button/natural-language actions.
- Test that the conversational LLM mock is never called for deterministic
  console intents and never generates carousel copy directly.
- Commit: `feat(telegram): add callback editorial console actions`.

## Task 5: Add change-driven M8 summary alert and wire outbox rendering

### Files

- Update shared M6 alert/repository helpers.
- Update `telegram-alerts` handler and tests.
- Update orchestration alert-dispatch integration if required by the current
  queue chain.

### TDD steps

1. Write failing tests for a successful changed M8 ranking creating one
   `INTELLIGENCE_COMPLETE` event with one compact summary and two buttons.
2. Implement stable fingerprinting from business date, ranking version, ordered
   story/rank/score/grounding fields; exclude run timestamps/model metadata.
3. Make unchanged reruns conflict-dedupe and emit no additional Telegram
   message; make meaningful ranking/story changes produce a new event.
4. Extend alert rendering without changing existing FIRST_MOVER, MUST_COVER,
   fixture, or dead-job behavior.
5. Keep `telegram-morning-brief` backward-compatible and avoid notification
   spam.

### Verification

- Run alert-focused Deno tests and existing M6/M7 alert tests.
- Assert exactly one summary event/message for a changed run and zero for an
  unchanged rerun.
- Commit: `feat(alerts): notify Telegram of canonical M8 stories`.

## Task 6: Route card generation through canonical Creative Generation

### Files

- Update `creative-generation/types.ts`, `prompts.ts`, `quality_gate.ts`,
  `repository.ts`, handler/provider adapter, and M6 revision compatibility
  code as needed.
- Update `telegram-agent` generation action and tests.
- Add style fields to the stored brief mapping.

### TDD steps

1. Write failing tests proving `idea:carousel:<short-id>` invokes the internal
   `creative-generation` endpoint with the canonical candidate ID and
   `trigger_type=MANUAL`, then reloads the stored READY brief.
2. Add style identity/version and structured slide mapping while accepting old
   M5 slide JSON and null legacy style fields.
3. Inject only the shared style profile rules plus frozen current-story
   evidence into the canonical prompt; keep golden facts out of the provider
   input.
4. Update the structured schema and deterministic quality gate to support
   three or four meaningful slides, optional implication, public/internal
   separation, attribution, and `editor_warning` outside slide copy.
5. Preserve blocked evidence, uncertain classification, lease, fingerprint,
   append-only revisions, and existing M5 confirmation behavior.
6. Ensure a style validation failure cannot emit an arbitrary prose fallback.

### Verification

- Test canonical MANUAL invocation, double-tap reuse, source caveat
  preservation, no filler slide, and no forbidden research prose.
- Test the same action through button, natural-language fallback, and slash
  path where supported.
- Commit: `feat(creative): align generation with ManUtd Editor style`.

## Task 7: README and architecture/regression coverage

### Files

- Update `README.md` with Sources -> M8 -> Stories -> Ranking -> Telegram ->
  Style -> Structured Draft -> M9.
- Update architecture tests, secret scan allowlists only if required, and
  existing milestone test runners.
- Add deterministic acceptance tests covering all 30 requested test cases.

### TDD steps

1. Add tests for existing slash commands, M7 worker chaining, M8 grounding and
   ranking, M5 revisions, and all new UX/style behavior.
2. Add README sections describing canonical stories, public/internal copy,
   button-first UX, style contract, TEXT_REEL limitation, and M9 boundary.
3. Run architecture checks and remove any accidental Figma/auto-publish code.

### Verification

- Run focused Deno/pgTAP tests first, then the existing M8 Phase B/C smoke.
- Run secret scan, architecture checks, `git diff --check`, and a clean
  worktree check.
- Commit: `docs: document M8 Telegram console and style flow`.

## Task 8: Local completion audit

1. Inspect every changed file and compare it against the spec's requirement
   list, not only test output.
2. Run all available deterministic DB, Deno, Telegram UX, style, M5, M7, and
   M8 regression tests.
3. Confirm Figma files/tools/tokens were not added and production has not yet
   been changed during local work.
4. Capture exact test counts and any known limitations for the final report.
5. Commit any final fixes as focused commits; do not squash away traceability.

## Task 9: Push `main` and perform approved remote production rollout

1. Confirm `git status` is clean and push `main` to `origin/main`.
2. Confirm the linked Supabase project ref is the production project from the
   repository configuration; do not print secrets.
3. Run `supabase db push --linked`, then linked DB lint/schema verification.
4. Deploy changed functions: `telegram-agent`, `telegram-alerts`, and
   `creative-generation`, plus any function the final diff proves necessary.
5. Check remote secret names only; set missing required secrets from the
   existing secret-safe environment source without echoing values.
6. Verify the Telegram webhook target points to the deployed
   `telegram-agent`; re-register only if absent or incorrect.
7. Run bounded remote smoke checks for health/auth, M8 alert/outbox behavior,
   and callback routing when safe canonical test data is available. Do not
   create production posts, publish Instagram, or create Figma files.
8. Record deployment commands, function names, migration version, webhook
   result, and any smoke limitations for the final report.

### Verification

- Re-run local status and inspect remote deployment output.
- Confirm `origin/main` contains the implementation commit(s).
- Confirm the deployed functions report success and no secrets appear in logs.
- Commit only if a post-deploy documentation correction is necessary; push
  again before declaring completion.

## Final report checklist

The final response must include:

1. Current Telegram architecture and root cause of generic drafts.
2. Old and new generation paths.
3. Telegram state flow and callback/action model.
4. Database state changes and changed files.
5. ManUtd Editor profile, golden examples, structured contract, and a
   before/after fixture comparison.
6. Text mockups for summary, lists, detail, and generated carousel.
7. Test counts by DB, Deno, Telegram UX, style, and regression category.
8. Known limitations and required environment variables.
9. Exact deployment commands and remote rollout evidence.
10. Explicit confirmation that Figma was not implemented and production was
    deployed only after the user's explicit approval.
