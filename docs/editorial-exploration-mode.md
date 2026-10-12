# Editorial Exploration Mode

Exploration Mode extends the existing M6–M9 workflow with review-only drafts from extracted publisher articles. It reuses the existing discovery observations, story clusters, content candidates, generation jobs, creative briefs, Telegram console, and manual M9 preview. It does not create a second news queue or change the READY-only M9 scheduler in PR #8.

## Enablement and limits

`EDITORIAL_EXPLORATION_MODE` defaults to `false`. While disabled, generation uses the existing strict path. Enable it only in a disposable or staging environment after applying the additive migration and confirming the required M9 workflow settings.

| Setting | Default | Maximum | Use |
| --- | ---: | ---: | --- |
| `EDITORIAL_EXPLORATION_MODE` | `false` | — | Enables explicit Exploration generation and the recent-candidate pass. |
| `EDITORIAL_EXPLORATION_MAX_DRAFTS_PER_DAY` | `10` | `10` | Atomic reservation limit per Asia/Seoul calendar day, including in-flight work. |
| `EDITORIAL_EXPLORATION_MAX_ARTICLE_AGE_HOURS` | `72` | `72` | Publication-time limit for automatic Exploration generation. |
| `EDITORIAL_EXPLORATION_MIN_ARTICLE_CHARS` | `300` | `6,000` | Minimum extracted publisher text length. |
| `EDITORIAL_EXPLORATION_MAX_ARTICLES_PER_STORY` | `5` | `10` | Maximum publisher articles attached to one frozen evidence snapshot. |
| `EDITORIAL_EXPLORATION_INPUT_COST_PER_MILLION_USD` | unset | — | Optional input-token rate used for an estimated USD cost. |
| `EDITORIAL_EXPLORATION_OUTPUT_COST_PER_MILLION_USD` | unset | — | Optional output-token rate. Cost remains `null` unless both rates are set. |

Numeric settings that are invalid fall back to defaults and are clamped to the listed maximum. The database RPC independently caps the daily limit at ten. Automatic selection orders eligible article observations by actual `published_at` descending and ignores items outside the publication-time window. `STALE` stories can be assessed only with a fresh qualifying article; `ARCHIVED` stories are blocked without changing their stored status. There is no automatic historical backfill. The Telegram generation request accepts one selected candidate per call, so a manual request remains below the 30-candidate review ceiling. An older article is eligible only for an explicit `MANUAL` Exploration request; its DRAFT records `historical_review: true` and preserves the original publication time. That manual generation still consumes one of the ten daily Exploration reservations.

## Evidence and status

An Exploration article must have a publisher name, HTTPS publisher URL, `EXTRACTED` marker from a publisher-page fetch, at least the configured amount of body text, a valid non-future publication time, and a materially Manchester United-related story. Feed summaries, title-only records, unsafe or missing URLs, short bodies, unrelated stories, and archived stories are rejected before any model call.

Article text is stored separately from verified claim evidence with `verified: false`. It never satisfies `verifiedNewsSources()`, creates a VERIFIED claim, or relaxes the strict NEWS_UPDATE READY gate. Exploration output is always saved as `DRAFT` across NEWS_UPDATE, ANALYSIS_CONTEXT, and MATCH_CONTENT. Output validation requires three to five slides, article evidence IDs, publisher name and exact URL in slide copy and caption, preserved report/rumor/denial/opinion wording, a review note, and no more than five hashtags.

The daily priority runner completes existing strict READY candidates first, then considers recent Exploration candidates until it reaches the remaining atomic quota. A story-level fingerprint and unique indexes prevent another date-scoped candidate or concurrent manual request from creating a duplicate. Existing briefs for that story, including READY and PUBLISHED, are reused without demotion.

## Telegram and M9 preview

When the flag is on, Telegram can pass a non-eligible selected story to the canonical generator with explicit Exploration intent. Missing article text, archived stories, low relevance, and the daily limit return a reason instead of invoking the model. A DRAFT remains DRAFT when selected; selection does not promote it to READY.

An explicit `🖼️ 비공개 미리보기` action on a DRAFT or SELECTED Exploration brief dispatches the existing `m9-private-preview.yml` workflow in `upload_preview` mode. The Edge function needs `M9_GITHUB_ACTIONS_TOKEN`, `M9_GITHUB_REPOSITORY`, and `M9_GITHUB_WORKFLOW_REF`. The workflow loads the DRAFT only with its explicit draft-preview input, renders all brief slides with Pretendard Bold headings and Pretendard SemiBold body copy, and uploads PNGs to private storage. DRAFT preview does not send Telegram media. The READY path remains available through the existing manual workflow; PR #8's scheduler remains READY-only. Instagram publishing remains a separate, unconfigured action.

## Usage and cost

`creative_generation_jobs` records `generation_intent`, reservation time, provider-call attempts, input/output tokens, retries, and optional estimated cost. The corresponding brief stores the Exploration fingerprint and provider-call/token/cost totals; `generation_metadata.provider_usage` also retains retry count. No article body, prompt, or provider response is included in usage metrics. Missing provider token usage is recorded as zero; missing price configuration leaves estimated cost `null` rather than inventing a value.

The additive schema is in `supabase/migrations/20261012150000_editorial_exploration_generation.sql`. Its RPC is service-role-only and serializes reservation by Seoul business date and event fingerprint. Validate it with `supabase/tests/database/027_editorial_exploration_generation_test.sql` only against a disposable database. This implementation has not applied the migration to the shared `manutd_editor` database or any production project.

## Rollout boundary

The flag is off by default. This PR does not deploy code, apply a production migration, enable the flag, dispatch GitHub Actions, send Telegram, or publish Instagram. Before a staging rollout, configure the optional provider rates and the three M9 dispatch settings, apply the migration to an isolated database, then run the full database and application tests. Keep PR #10 in Draft until an operator reviews that staging result.
