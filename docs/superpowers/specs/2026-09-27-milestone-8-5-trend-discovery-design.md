# Milestone 8.5 — Trend Discovery Engine

## Problem and product behavior

M8 decides which known canonical stories are worth publishing. M8.5 discovers
which topics should become known to the system. A bounded discovery run expands
Manchester United queries, collects modular provider observations, filters for
United subject relevance, clusters duplicate observations, computes trend
snapshots, and then hands the resulting canonical story context to the
existing M8 grounding and editorial ranking stages.

Trend discovery is evidence about attention, not proof of facts. Community,
competitor, and video observations remain discovery-only and can never make a
claim `VERIFIED`. Only `FACT_PRIMARY` and `FACT_INDEPENDENT` observations may
be grounding evidence.

## Data flow

```text
DISCOVERY_RUN
  -> QUERY_EXPANSION
  -> DISCOVERY_PROVIDER[]
  -> OBSERVATION_NORMALIZATION
  -> UNITED_RELEVANCE_FILTER
  -> FINGERPRINT / IDEMPOTENCY
  -> STORY_CLUSTER_ATTACHMENT
  -> TREND_SNAPSHOT
  -> M8 GROUNDING + EDITORIAL RANKING
  -> TELEGRAM TREND CONSOLE
```

The first live implementation reuses the existing bounded RSS/Atom/HTML feed
collector and adds a provider abstraction. Providers are isolated: a failed
provider produces a safe status and does not discard successful observations.
No arbitrary crawling or copyrighted media download is introduced.

## Contracts

M8.5 adds `discovery_runs`, `discovery_queries`, `discovery_observations`, and
`trend_snapshots` in `app_private`, plus additive trend columns on the
existing editorial projection where needed. An observation preserves source,
role, platform, canonical URL, external ID, title, excerpt, publication time,
observation time, engagement metadata, query ID, and content fingerprint.
Observation identity is `(provider_id, external_id)` and a content fingerprint
is used as a duplicate-clustering fallback. Runs and snapshots are append-only
at the measurement boundary; repeated provider items update metadata without
inflating mention counts or creating duplicate stories.

## Query expansion and windows

Queries are deterministic and bounded. The base families cover latest,
breaking, trending, injury, transfer, manager, tactics, stats, controversy,
fan reaction, Reddit, academy, interview, press conference, and next match.
Current manager, squad, injuries, opponents, competitions, and recently seen
entities are injected from a refreshable `EntityContext`.

The default windows are breaking 0–3h, hot 3–12h, current 12–24h, and
background 24–72h. `published_at` remains nullable and is never replaced by
`observed_at`; missing publication time receives conservative freshness.

## Scoring

All sub-scores and `trend_score` are 0–100. Version `m8.5-v1` uses:

```text
trend_score =
  0.30 * velocity
+ 0.20 * cross_source
+ 0.15 * engagement
+ 0.15 * freshness
+ 0.10 * novelty
+ 0.10 * manutd_relevance
```

Velocity rewards acceleration using recent versus previous windows. Cross-source
scoring counts distinct source categories and platforms, not repost volume.
Engagement is source-normalized and carries an explicit unavailable flag.
Novelty falls with competitor coverage, similar-post saturation, and prior own
coverage. Relevance uses the existing subject/entity anchoring behavior.

Deterministic states are `BREAKING`, `RISING`, `HOT`, `STABLE`, `COOLING`, and
`SATURATED`. Opportunity labels are derived from trend, novelty, grounding,
and saturation; the LLM does not assign scores or states.

## Telegram behavior

Existing `/today`, recommended/all story navigation, evidence, skip, and
creative actions remain valid. The editorial console gains `OPEN_TRENDING`,
`DISCOVER_MORE`, and `REFRESH_DISCOVERY` actions. `📈 지금 뜨는 소재` reads
latest trend snapshots and shows Trend Score, Editorial Score, state, source
and platform diversity, and grounding status. `🔎 더 찾아보기` creates a
bounded discovery run and returns deterministic run status; it is not a page
through existing stories. Korean deterministic intents map “지금 뭐 뜨고
있어?” to `OPEN_TRENDING` and “좀 더 찾아봐” to `DISCOVER_MORE`.

## Failure, security, and rollout

Provider errors, malformed input, missing configuration, timeouts, and partial
failures are isolated and summarized. Credentials and raw private provider
payloads are never stored or logged. M8.5 is additive and does not change M4
Priority Score, M8 grounding, creative generation, or publishing behavior.

Phase A is deterministic contracts, schema, query expansion, scoring, and
fixtures. Phase B enables a small safe provider set. Phase C attaches discovery
observations to existing clusters and reruns M8 stages. Phase D exposes the
Telegram trend console. Production deployment remains a separate explicitly
authorized operation.
