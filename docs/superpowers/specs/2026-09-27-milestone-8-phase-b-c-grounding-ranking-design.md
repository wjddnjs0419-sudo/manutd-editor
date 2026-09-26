# Milestone 8 Phase B/C — Source Grounding and Editorial Ranking

## Goal

Integrate source discovery, claim grounding, and editorial information-gap
ranking into the existing M7 Supabase-native pipeline while preserving the M4
Priority Score, canonical match provider, and the distinction between factual
evidence and audience discovery signals.

The production outcome is a self-consuming pipeline whose latest safe editorial
state is available to the existing 09:00 Asia/Seoul morning briefing. A source
failure must degrade the editorial enrichment only; it must not prevent the
canonical Instagram, fixture, intelligence, or briefing paths from completing.

## Editorial source-role policy

Source role is stored explicitly and copied onto observations/evidence so a
later consumer cannot infer editorial authority from popularity or repetition.

| Role | Examples | May ground a fact? | May contribute to discovery/audience signal? |
|---|---|---:|---:|
| `FACT_PRIMARY` | Manchester United official site/social, official player/manager statements, press conferences, direct club announcements | Yes | Yes |
| `FACT_INDEPENDENT` | Reuters, BBC Sport, Sky Sports, The Guardian, ESPN, The Athletic, trusted reporters in the registry | Yes | Yes |
| `DISCOVERY_COMPETITOR` | Competitor Instagram accounts | No | Yes |
| `DISCOVERY_COMMUNITY` | Reddit, especially relevant Manchester United communities | No | Yes |
| `DISCOVERY_VIDEO` | Public YouTube metadata | No | Yes |
| `MATCH_CONTEXT` | Existing fixture/match provider | No | No; match context only |
| `OWN_PERFORMANCE` | `published_posts`, `performance_metrics` | No | No; reserved for a later learning milestone |

Discovery sources may create a lead and may be linked to a claim as
`DISCOVERY_ONLY`, but they can never make a claim `VERIFIED`. Repost count,
engagement, repeated community discussion, and source frequency are never
converted into factual confidence. `source_confidence` is derived only from
fact-grounding sources and their explicit evidence links.

## Architecture

The existing M7 collection chain becomes:

```text
COLLECT_INSTAGRAM
  -> ANALYZE_CONTENT
  -> RUN_INTELLIGENCE
  -> DISCOVER_SOURCES
  -> GROUND_CLAIMS
  -> RANK_EDITORIAL
  -> GENERATE_PRIORITY
  -> SYNC_NOTION / POLL_SELECTED / alerts
```

`DISCOVER_SOURCES` reads bounded, configured public RSS/Atom feeds for
official/independent fact sources and Reddit/YouTube discovery feeds. Existing
Instagram competitor posts remain discovery inputs through `raw_posts`; the
collector is not redesigned. Missing feed configuration is a successful `NOOP`
with an empty observation set. Each feed is isolated, bounded by timeout and
body size, and produces safe error categories without persisting raw upstream
errors or credentials.

`GROUND_CLAIMS` extracts claims already produced by M8 Phase A and matches them
to source observations using deterministic normalized-token evidence. A claim
with supporting `FACT_PRIMARY` or `FACT_INDEPENDENT` evidence becomes
`VERIFIED`; a lead with only discovery evidence becomes `DISCOVERY_ONLY`; no
usable evidence becomes `INSUFFICIENT`; conflicting fact evidence becomes
`CONTRADICTED`. Match-provider data is stored in its own input section and does
not enter fact confidence.

`RANK_EDITORIAL` writes a separate ranking projection. It does not alter
`content_candidates.priority_score`, score weights, readiness semantics, or
the M4 canonical ranking. The ranking is deterministic and versioned:

```text
editorial_score =
  0.35 * information_gap
  + 0.30 * fact_grounding
  + 0.15 * discovery_audience_signal
  + 0.10 * match_context
  + 0.10 * freshness
```

Scores are normalized to 0–100 and the exact input snapshot is persisted.
Discovery-only candidates can rank highly as research leads, but
`news_eligible = false` until fact grounding is present. Neither ranking nor
grounding reads `published_posts` or `performance_metrics`.

The existing 09:00 Asia/Seoul `MORNING_BRIEF` Cron job remains the delivery
owner. It consumes the latest same-business-date editorial ranking when one is
available, annotates the frozen briefing with grounding/news-eligibility
state, and falls back to the existing M4 candidate ordering when enrichment is
not ready. The 09:00 path must remain idempotent and must not wait on an
external feed.

## Data contracts

Add role metadata to `public.information_sources`, retaining the existing
reliability score for fact sources. Add server-only tables:

- `app_private.source_observations`: source id/role, stable external id,
  canonical URL, title/excerpt, published/observed timestamps, bounded
  discovery signal, and content fingerprint. The copied role is immutable for
  the observation.
- `app_private.story_claims`: Phase A claim identity, cluster/post linkage,
  extraction confidence, grounding status, grounding confidence, and a
  deterministic claim fingerprint.
- `app_private.claim_evidence`: claim-to-observation links, copied source role,
  support/contradiction relation, evidence excerpt, and `is_grounding`. The
  database check permits `is_grounding = true` only for fact roles.
- `app_private.editorial_rankings`: cluster/date/version identity, score
  components, rank, `news_eligible`, `grounding_status`, reason codes, and the
  complete input snapshot. It is a projection, not a replacement for M4.

All server-only tables use RLS with service-role-only CRUD and bounded JSON
contracts. Idempotency keys are `(source_id, external_id)` for observations,
`(story_cluster_id, claim_fingerprint, grounding_version)` for claims, and
`(story_cluster_id, ranking_date, ranking_version)` for rankings.

## Edge Function boundaries

- `source-discovery`: authenticated with the collector boundary secret; accepts
  only an optional ISO `as_of` timestamp and bounded limit; returns safe counts
  and per-feed categories.
- `ground-claims`: authenticated with the collector boundary secret; consumes
  current-cluster claims and source observations; returns counts by grounding
  state.
- `rank-editorial`: authenticated with the collector boundary secret; consumes
  grounding, discovery, and match-context inputs; returns ranked count and
  version.

Each boundary is pure-orchestrator friendly: repositories and feed/fact
adapters are injected in tests, network calls are bounded, and repeated calls
with the same identity do not call or persist duplicate work.

## Failure and security behavior

- One feed failing does not discard successful observations from other feeds.
- A missing/invalid feed URL, timeout, non-2xx response, oversized body, or
  malformed RSS item is recorded as a safe category and the job can still
  complete.
- Raw upstream bodies, authorization headers, API keys, signed URLs, and model
  secrets are never logged or persisted.
- A fact source with no matching claim is retained as an observation but does
  not raise fact confidence.
- A discovery source is never copied into `story_cluster_sources` as factual
  grounding solely because it is popular or repeated.
- Existing M7 retries, dead-letter alerts, and 09:00 ALREADY_SENT behavior are
  preserved.

## Verification contract

Tests must prove:

1. every source role maps to the allowed editorial behavior;
2. official/independent evidence can verify a claim;
3. Instagram/Reddit/YouTube evidence remains discovery-only;
4. conflicting fact evidence produces `CONTRADICTED` and is not news-eligible;
5. match context is isolated from fact confidence;
6. own performance tables are absent from grounding/ranking queries and input
   snapshots;
7. feed timeout, malformed input, body bounds, and missing configuration are
   safe and isolated;
8. source observations, claims, and rankings are idempotent;
9. the worker chain enqueues all new stages exactly once and preserves retry/
   dead-letter semantics;
10. the 09:00 briefing consumes same-date ranking data when present and falls
    back safely when it is absent;
11. local database, focused Deno, full Deno, architecture, smoke, and diff
    checks pass without calling live external providers;
12. the linked production project has the migration, functions, Cron roots,
    worker poller, and a successful 09:00 enqueue/worker/briefing smoke.

## Non-goals

This phase does not scrape arbitrary websites, infer truth from engagement,
train a model, change M4 Priority Score math, use performance learning, publish
content, register a Telegram webhook, or make the 09:00 briefing wait for a
source feed.
