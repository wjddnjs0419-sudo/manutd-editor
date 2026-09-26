# Milestone 8 Phase A — Multimodal Instagram Content Understanding

## Goal

Add a server-only, versioned multimodal analysis layer between the existing
Instagram collector and M7 intelligence pipeline. The system will understand
captions and cached Instagram media, preserve explicit claim provenance, and
enrich existing story clustering without replacing M1–M7 canonical state or
the deterministic M4 Priority Score.

The implementation and deterministic verification loop is local-only. It does
not call live OpenAI in CI, publish to Instagram, or implement M8-B source
discovery or M8-C editorial ranking. The user has separately authorized a
post-verification production rollout after all local checks pass; that rollout
is a distinct final operation, not part of deterministic test execution.

## Existing context and constraints

- The current checked-out branch is `main` and contains the completed M7
  Supabase-native queue, worker, schedule, and observability changes.
- `raw_posts` remains the raw Meta input and is never overwritten by AI
  output.
- `media_assets` and the private `instagram-analysis` Storage bucket remain
  the media cache contract. The bucket must remain private.
- Existing M6/M5 OpenAI integrations use injected providers, bounded errors,
  and Responses API structured output. Phase A follows those patterns.
- Existing intelligence remains caption-compatible when no multimodal
  analysis exists.
- All implementation and commits stay on `main`. Production rollout is allowed
  only as the final post-verification operation explicitly requested by the
  user; external webhook registration remains out of scope.

## Non-goals

- No Figma integration, publishing, video editing, full Reel download, speech
  to text, ML training, autonomous posting, arbitrary scraping, or M8-B/M8-C
  functionality.
- No redesign of M4 Priority Score, score weights, readiness, or canonical
  raw collection state.
- No public media URL, signed URL, model secret, or raw upstream error is
  persisted or logged.

## Architecture

The M7 chain becomes:

```text
COLLECT_INSTAGRAM
        ↓
ANALYZE_CONTENT  (one bounded batch job per collection chain)
        ↓
RUN_INTELLIGENCE (one job for the batch, never one per post)
```

`ANALYZE_CONTENT` is a new worker stage and a new authenticated Edge Function
boundary. It scans a bounded recent-post window for raw posts that do not have
the current analysis contract and processes each post independently. A post
failure is recorded safely and does not prevent the batch from completing or
the single downstream intelligence job from being enqueued.

The analysis function has four focused boundaries:

1. a repository that reads raw posts, ordered media metadata, and private
   analysis rows through the service-role REST boundary;
2. a private media reader that downloads cached bytes from Supabase Storage,
   validates MIME/size/path, computes SHA-256, and produces in-memory data
   inputs without exposing URLs;
3. an OpenAI Responses provider that sends caption plus supported image inputs
   to a configured model and validates strict JSON Schema output; and
4. an orchestrator that fingerprints inputs, skips exact prior attempts,
   calls the provider, validates semantic output, and writes one auditable
   versioned result per input contract.

The analysis function uses caption-only processing when media is absent but a
caption exists. Visual fields become `UNAVAILABLE` and the result is
`PARTIAL`. If neither caption nor supported media exists, it writes an
`UNAVAILABLE` result without asking the model. An individual provider/media
failure writes a safe `FAILED` result and the batch continues.

## Canonical analysis data model

Create `app_private.content_understandings` in a new migration after the M7
migrations.

Required columns:

- `id uuid primary key`
- `raw_post_id uuid not null references public.raw_posts(id) on delete cascade`
- `status text not null`, constrained to `SUCCEEDED`, `PARTIAL`, `FAILED`, or
  `UNAVAILABLE`
- `analysis_version text not null`
- `model text not null`
- `prompt_version text not null`
- `input_fingerprint text not null`
- `caption_summary text`
- `visual_summary text`
- `combined_summary text`
- `entities jsonb not null default []`
- `topics jsonb not null default []`
- `on_image_text jsonb not null default []`
- `important_numbers jsonb not null default []`
- `source_names jsonb not null default []`
- `claims jsonb not null default []`
- `content_type text`
- `visual_format text`
- `analysis_confidence numeric(5,4)` with a 0–1 check
- `evidence_state jsonb not null default {}`
- `error_category text`
- `analyzed_at timestamptz`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

All JSON columns must be JSON arrays/objects of the expected shape at the
database boundary. `analysis_version`, `model`, `prompt_version`, and
`input_fingerprint` must be nonblank. The uniqueness boundary is:

```text
(raw_post_id, analysis_version, input_fingerprint)
```

This preserves historical versions while making the same raw post, contract,
and input idempotent. A changed caption or changed downloaded media hash
creates a new fingerprint and therefore a new auditable row. The latest row
for the current contract is used by Intelligence.

The table has RLS enabled, no privileges for `public`, `anon`, or
`authenticated`, and CRUD privileges only for `service_role`, matching
`app_private.story_cluster_evaluations`. It is exposed through the existing
server-only `app_private` API schema only so Edge Functions can use the
service-role REST boundary.

### Claim contract

Each claim is an extracted assertion made by the Instagram post, never a
verified fact:

```json
{
  "subject": "Jadon Sancho",
  "predicate": "training_at",
  "object": "Flixton FC facilities",
  "text": "Sancho is training at Flixton FC facilities",
  "origin": "carousel_slide",
  "confidence": 0.94,
  "evidence": [{"slide_index": 2, "media_asset_id": "asset-3"}]
}
```

`origin` is one of `caption`, `image`, `carousel_slide`, or `thumbnail`.
`confidence` describes extraction/interpretation quality, not factual
truth. Verification is explicitly deferred to M8-B grounding.

`evidence_state` maps semantic fields to `OBSERVED`, `INFERRED`, or
`UNAVAILABLE`. The provider prompt forbids filling unavailable evidence with
guesses. `analysis_confidence` is the model's overall analysis quality and is
not source reliability.

## Media handling

The collector is not redesigned. Phase A reuses existing stored assets:

- `IMAGE`: the stored `IMAGE` asset plus caption;
- `CAROUSEL_ALBUM`: stored `CAROUSEL_CHILD` assets sorted by
  `carousel_index`, with a configured maximum slide count. The prompt labels
  each slide and requires story reconstruction across the ordered sequence;
- `VIDEO` + `REELS`: the stored `THUMBNAIL` asset plus caption only, with
  `visual_format = THUMBNAIL_ONLY`;
- unsupported, missing, expired, or oversized media: no public fallback and no
  raw URL logging. The result records unavailable/partial visual evidence.

The private media reader uses `SupabaseClient.storage.from("instagram-analysis")
.download(storage_path)` with the service-role client. It validates the
deterministic storage path, supported image MIME, configured input byte limit,
and a bounded slide count. It never creates or persists a signed URL. SHA-256
is computed over the downloaded bytes and included in the fingerprint.

## Structured model contract

The model is selected by configuration, not embedded in business logic. The
default configuration is safe for local tests but can be replaced with
`CONTENT_UNDERSTANDING_MODEL`, `CONTENT_UNDERSTANDING_PROMPT_VERSION`,
`CONTENT_UNDERSTANDING_TIMEOUT_MS`, `CONTENT_UNDERSTANDING_MAX_SLIDES`,
`CONTENT_UNDERSTANDING_MAX_BYTES`, `CONTENT_UNDERSTANDING_BATCH_SIZE`, and
`CONTENT_UNDERSTANDING_CONCURRENCY`.

The provider uses the OpenAI Responses endpoint with `store: false`, a strict
JSON Schema, and a multimodal user input containing a text instruction/caption
and zero or more in-memory `input_image` data URLs. It validates:

- required field presence and enum values;
- bounded string/array sizes;
- claim origin, evidence indexes, and confidence ranges;
- `visual_format` against the server-selected media mode; and
- the distinction between observed, inferred, and unavailable fields.

Provider errors are reduced to safe categories such as
`PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMITED`, `PROVIDER_UPSTREAM_5XX`,
`MALFORMED_PROVIDER_RESPONSE`, `MEDIA_TOO_LARGE`, and
`MEDIA_UNAVAILABLE`. Error responses/logs contain only request IDs, status
classes, and safe categories; they never contain API keys, signed URLs,
authorization headers, or raw upstream bodies.

## M7 queue integration

The new migration extends the existing editorial job type check and enqueue
RPC allowlist with `ANALYZE_CONTENT`. The worker type union, boundary map, and
stage map are extended as follows:

```text
COLLECT_INSTAGRAM -> ANALYZE_CONTENT -> RUN_INTELLIGENCE
```

The existing chain key and `<chain_key>:<stage>` dedupe convention remain the
only downstream dedupe boundary. `ANALYZE_CONTENT` receives at most a bounded
`as_of`/limit request and returns a safe summary. It does not enqueue one job
per post. Existing `RUN_INTELLIGENCE` `already_running` behavior and all later
M7 stages are unchanged.

## Intelligence enrichment

`RecentRawPost` gains an optional server-only content-understanding value.
The repository loads the latest current-contract analysis for recent posts
from `app_private.content_understandings` in a separate service-role request;
raw-post retrieval continues to work if no analysis row exists.

Caption extraction remains the base behavior. When semantic analysis exists:

- visual entities are normalized and added to entity features;
- topics are normalized into the existing event/topic matching channel;
- important visual numbers are added to number features;
- extracted source names are added to source features; and
- normalized combined summaries add bounded content tokens and cluster
  signature summaries.

The existing caption fields and deterministic similarity behavior remain valid
for posts without analysis. Story signatures and classifier snapshots may carry
the additional multimodal fields, but M4 Priority Score SQL and its canonical
inputs are not redesigned.

## Deterministic verification

Add tests for:

1. a weak-caption image whose visual text supplies the story;
2. a useful-caption image with useful visual context;
3. a carousel whose third slide supplies the key fact while slide order is
   preserved;
4. duplicate analysis requests not calling the provider twice;
5. changed captions producing changed fingerprints;
6. changed media bytes producing changed fingerprints;
7. Reel analysis using thumbnail only;
8. missing media falling back to safe partial/unavailable output;
9. malformed structured model output;
10. timeout and rate-limit provider failures;
11. no secrets in persisted errors/logs;
12. existing intelligence running successfully with no M8 analysis.

Create a synthetic/golden fixture for a well-known former Manchester United
player in an unexpected current situation with a strong numeric/contrast hook,
for example a post whose image states that Jadon Sancho has gone three months
without a club while training at lower-league facilities. The fixture is
synthetic and does not assert that the scenario is true; it is used to test
editorial information extraction and later M8-C information-gap work.

Run the focused Deno tests, database contract tests, full Deno test suite,
existing M7 smoke/parity tests, `node --test` repository validators, and
`git diff --check`. No test requires live Meta, OpenAI, Notion, Telegram, or a
remote Supabase project.
