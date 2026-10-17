# M8 Grounding, Ranking, and READY Design

## Goal

Connect verified publisher reporting to editorial ranking and creative generation without upgrading Google News discovery data into event-level fact evidence or bypassing existing verification gates.

## Constraints

- Keep Google News as `DISCOVERY_COMMUNITY`; its wrapper URL, publisher label, or successful body extraction alone never establishes publisher trust.
- Use only an active, already-reviewed `information_sources` entry with a fact role and established reliability for publisher evidence. A newly encountered host remains discovery-only with no elevated reliability.
- A source may verify that an outlet reported a statement. It does not verify the underlying event unless separate evidence directly supports that event.
- Preserve uncertainty, rumor, attribution, and denial through claims, evidence snapshots, Korean carousel copy, and captions.
- Store the publisher URL, Google News URL, outlet name, publication time, and exact supporting sentence with traceable links.
- Scores, confidence, and flags must be derived from observed evidence and existing scoring policy. Never synthesize `first_mover_flag` or `must_cover_flag` to unlock generation.
- Production Supabase and the shared local `manutd_editor` database are out of scope. Use only a separately identified disposable staging stack with isolated project ID and ports.
- Do not merge PR #8, #9, or #10; create no new PR; keep PR #10 Draft and based on PR #9. Do not activate Google News operations, schedules, cron, Telegram delivery, or user-facing publishing.

## Architecture

### Publisher identity and evidence

The discovery observation remains tied to Google News and keeps its discovery role. During M8 promotion, the resolved publisher URL is matched by exact normalized host against an existing active `information_sources.website_url` record whose role is `FACT_PRIMARY` or `FACT_INDEPENDENT` and whose reliability is at least 8, matching the existing NEWS_UPDATE source threshold. Only a match may create publisher-report evidence. No source row is created with elevated trust from RSS metadata or an unreviewed URL. An unmatched source remains a review candidate.

The article-backed M8 claim represents the report itself: for example, “BBC reported that United are considering player A.” Its evidence must be a sentence extracted from the publisher article that supports that reporting assertion. The report claim is distinct from an event claim such as “United signed player A.” A rumor, possibility, negotiation, denial, or prediction cannot ground an event claim as confirmed. Matcher inputs retain claim origin/predicate, publisher role, article text, and provenance so a trusted article cannot verify an unrelated or stronger assertion by lexical overlap alone.

### Ranking and candidate eligibility

`rank-editorial` continues to calculate `editorial_rankings` from the current grounding, relevance, freshness, and discovery inputs. After the ranking write succeeds, it updates the same-date `content_candidates` projection with the calculated evidence confidence and a namespaced ranking snapshot. It leaves M4 component scores and the meaning of `first_mover_flag` and `must_cover_flag` intact.

Automatic selection reads current-date editorial rankings in rank order and includes only rows that pass the existing `news_eligible` evidence rule and the existing 72-hour discovery freshness window. Freshness also remains an input to the editorial score. The candidate lookup must resolve to the same story/date. A candidate without an eligible ranking stays available for human review and is not sent through `AUTO_PRIORITY`. The NEWS_UPDATE gate applies to every trigger and requires claim-linked, verified publisher evidence that the generated claim actually cites; legacy source mentions cannot satisfy it.

### Creative evidence and attribution

The frozen evidence snapshot includes the verified claim text, exact evidence sentence, publisher canonical name, article URL, original Google URL, publication time, editorial role, reliability, relation, and claim linkage. Generation instructions preserve reported/rumored/confirmed distinctions. A READY NEWS_UPDATE brief must cite only supported evidence and include outlet attribution and the publisher URL in the public carousel source treatment and Instagram caption. If these requirements or the evidence gate fail, generation records its failure code and leaves the candidate blocked or in a human-review state; it does not force READY.

### Manchester United relevance

Relevance evaluation keeps title, extracted body, entities, and primary topic as separate signals. A headline-centered United story can pass when body/entities/topic corroborate it. Opponent-only context is classified separately and cannot become an automatic news candidate without a direct United fixture relation. A brief United mention, another-sport article, or a multi-club rumor roundup does not pass the automatic relevance gate from one keyword or entity hit. Existing focused-source exceptions require normalized allow-listed identities and still cannot bypass contradictory topic or sport signals.

### Runtime diagnostics and isolated validation

Gateway validation uses an actual Functions gateway URL in a fresh disposable Supabase stack with a unique project ID and non-shared ports. It records client timeout, DNS, connection/TLS, gateway response, handler entry/exit, authentication result, and Data API stage durations with redacted secrets and no article-body logging. HTTP 499 is treated as a client-disconnect symptom until those timings identify whether the client, gateway, handler, authentication, or service initialization stalled.

End-to-end validation uses at most five recent real Manchester United items: Google News RSS, resolved publisher URL, body extraction, discovery/source observations, reported-claim extraction, fact evidence, grounding, ranking, candidate selection, creative generation, and M9 request construction. The run uses only the disposable database and actual gateway. It records separate authentication, grounding, scoring, generation, and M9 failure codes; AI provider invocation count is measured. No Telegram request or public posting is permitted.

## Acceptance criteria

1. Ranking, grounding, and source-discovery internal Data API calls send both `apikey` and `Authorization: Bearer <service-role-key>`; private-schema calls preserve both profile headers. Tests inspect actual outgoing headers, and secrets remain server-only and absent from logs.
2. An unknown publisher host cannot become a fact source. A reviewed, exact-host registry match can support the article's report claim with an exact source sentence, while the Google observation itself remains discovery-only.
3. A publisher report about a rumor cannot verify a claim that the transfer is complete. A matching rumor/report claim retains attribution and uncertainty in the generation evidence.
4. Ranking persists a same-date candidate connection and actual data confidence. Existing M4 flags and component scores are not fabricated. Ineligible or stale stories are not AUTO_PRIORITY candidates.
5. Relevance tests distinguish United-centered news, an opponent article with explicit United fixture context, incidental United mention, another sport, and a multi-club rumor roundup using title/body/entity/topic agreement.
6. NEWS_UPDATE generation fails closed without claim-linked verified evidence and a valid source citation. READY output carries source attribution, publisher URL, Korean source-faithful summary, uncertainty distinction, and a caption draft.
7. A disposable staging API request through the real gateway and Data API confirms the auth fix; gateway diagnostics record timings and distinguish client timeout, handler delay, DNS, authentication, and service initialization failures.
8. M9 request-builder input is created from the verified brief and retains publisher URL/provenance. All verification artifacts identify the disposable target; no shared-local or production database is reset or modified.
