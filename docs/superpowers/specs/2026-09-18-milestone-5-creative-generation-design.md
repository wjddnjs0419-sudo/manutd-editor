# MU Content Intelligence System — Milestone 5 Design

## 1. Goal

Milestone 5 turns a verified M4 `content_candidate` into one grounded Korean Instagram Carousel creative brief. The subsystem freezes the exact internal evidence used, classifies the content deterministically first, calls OpenAI only with that evidence, validates the structured result deterministically, stores immutable revisions in `public.creative_briefs`, and projects ready work to the existing Notion editorial surfaces.

The output is one main carousel draft with exactly three hooks, four to seven slides, caption and CTA, slide-level visual direction, human-readable sources, and claim-level grounding.

## 2. Scope and ownership

- Supabase public schema owns generation configuration and immutable Creative Brief revisions.
- `app_private` owns generation jobs, leases, and Content Pipeline identity mapping.
- The M4 evidence tables remain the only factual input boundary.
- The Creative Generation Edge Function owns orchestration, provider calls, validation, repair, and state transitions.
- Notion remains an editorial projection. Daily Intelligence owns discovery and selection; Content Pipeline owns production tracking.
- n8n only schedules and invokes Edge Functions; it contains no generation or classification business logic.

In scope: `NEWS_UPDATE`, `ANALYSIS_CONTEXT`, and `MATCH_CONTENT` with `PRE_MATCH`, `LIVE`, and `POST_MATCH`; Instagram Carousel only; automatic priority triggers and Notion `Selected` triggers; one repair attempt; Daily Intelligence and Content Pipeline projection.

Out of scope: external search, news enrichment, Telegram, Figma, image generation, Instagram publishing, performance feedback, scoring/clustering changes, reverse-sync of editorial fields, multiple variants, and Reels.

## 3. Evidence boundary

The evidence snapshot is built from the candidate, its story cluster, cluster member raw posts, source accounts, recognized information sources, story-source evidence, and scoring evidence already stored by M4. No external URL is fetched for factual enrichment, and the OpenAI request does not include a web-search tool.

Each frozen item has a deterministic `evidence_id`, such as `post:<uuid>`, `source:<uuid>`, or `score:<component>`. The snapshot preserves only the text and structured evidence actually sent to the model; media binaries are excluded. Unsupported or malformed evidence is excluded before generation and recorded as a safe precheck result.

## 4. Classification

The classifier runs deterministic rules first with precedence `MATCH_CONTENT` > `NEWS_UPDATE` > `ANALYSIS_CONTEXT`. Match phases are derived from explicit event terms: lineup or matchup signals map to `PRE_MATCH`; goal, red card, VAR, injury-in-match, and half-time signals map to `LIVE`; final score, full time, match statistics, and post-match signals map to `POST_MATCH`.

The taxonomy, bilingual keyword/event lists, ambiguity threshold, and classifier version live in the active generation config. Ambiguous input alone may call the small configured classifier model and must return strict `{content_mode, match_phase, confidence, reason_code}`. Below-threshold or invalid fallback output becomes `CLASSIFICATION_UNCERTAIN` and stops generation.

## 5. Versioned configuration

`public.creative_generation_configs` is additive and has one active row enforced by a partial unique index. It stores classifier configuration, generator configuration, mode-specific prompts/policies, quality-gate limits, model names, output limits, and effective dates. The initial seed names `gpt-5.6-luna` for classification and `gpt-5.6-terra` for generation without silently falling back when access is unavailable.

The Edge Function validates the config before use. Model names, reasoning settings, response format, retry policy, evidence policy, and prompt versions are included in the generation metadata and fingerprint.

## 6. Provider boundary

The provider uses the OpenAI Responses API through a small injectable transport. Classifier and generator requests use separate prompts and strict JSON Schema structured outputs. The transport never attaches web search, never logs API keys or authorization headers, and stores only safe error categories. 429, 5xx, and network timeout errors use bounded retry with `Retry-After` precedence; 401, 403, malformed request, invalid schema/config, and exhausted retries become `FAILED_PROVIDER`.

## 7. Creative Brief and grounding contract

Existing `public.creative_briefs` remains the canonical table and is extended only with M5 metadata. Existing columns retain their mapping: `headline` is the representative hook, `angle` is the angle, `slide_count` is the slide length, `slides_json` is slide content plus claims, `design_json` is visual direction, `caption_draft` is caption body, and `cta` is the CTA.

Every generation revision stores `content_mode`, optional `match_phase`, `generation_config_id`, `input_fingerprint`, frozen `evidence_snapshot`, `hooks_json`, `grounding_json`, generation metadata, quality, model name, and generation timestamp. Revisions are append-only; historical rows are never overwritten. The candidate/fingerprint unique constraint makes same-input READY runs idempotent.

Each factual `FACT` claim and each analytical `INFERENCE` claim contains one or more evidence IDs present in the frozen snapshot. Analysis output labels FACT and INFERENCE distinctly. `NEWS_UPDATE` uses strict evidence policy and blocks if a required news claim lacks adequate reliable support or has unresolved contradiction. Analysis and match modes permit partial output only for confirmed claims; the model may not fill gaps from general knowledge.

## 8. Lifecycle, idempotency, and failure isolation

`app_private.creative_generation_jobs` is separate from the public brief and tracks `QUEUED`, `GENERATING`, `READY`, `BLOCKED_EVIDENCE`, `CLASSIFICATION_UNCERTAIN`, `FAILED_VALIDATION`, and `FAILED_PROVIDER`, plus lease, attempt, repair, error category, and linked brief. A unique candidate/fingerprint key plus a lease protects concurrent AUTO_PRIORITY and NOTION_SELECTED triggers.

The core flow is eligibility → evidence snapshot → classification → config/evidence precheck → fingerprint → idempotent job lease → provider → deterministic gate → exactly one repair if needed → revision insert → job READY → projections. A same candidate/fingerprint with an existing READY brief returns `NOOP`. A changed semantic input creates the next revision. Notion failure never rolls back a successfully persisted brief or changes its READY state.

## 9. Notion projection

Daily Intelligence gains system-owned `Creative Status`, `Current Brief Revision`, and `Content Pipeline URL` properties. Existing human-owned `Selected`, `Editorial Status`, `Editor Headline`, and `Editor Notes` are never sent in update payloads and are never overwritten.

After READY, the brief is projected to the configured Content Pipeline database. Operational metadata is stored as properties; the brief body contains Angle, Key Takeaway, three Hook Options, Carousel slides, Caption, Visual Direction, and readable Sources. Claim-level evidence IDs remain internal metadata and are not dumped into the human-facing page.

An EDITABLE existing production item is updated in place while preserving human-owned properties. LOCKED or APPROVED items are immutable; a new revision creates a new production page. A private mapping table records candidate/brief/revision/page identity and hash.

The lightweight Selected poll reads Daily Intelligence through the Notion API, selects only `Selected=true` rows with a candidate identity, and invokes the same generation core. The urgent path is invoked directly after successful M4 intelligence for `FIRST_MOVER` or `MUST_COVER` candidates. Both paths are idempotent.

## 10. Quality gate and repair

The deterministic validator checks strict schema validity, legal mode/phase, exactly three hooks, four to seven sequential slides, nonblank content, visual direction on every slide, evidence membership, grounded FACT/INFERENCE claims, mode evidence policy, and sources limited to frozen evidence. It returns stable error codes.

On failure the provider receives the original output, error codes, and the same frozen evidence for exactly one repair attempt. Repair cannot add facts, sources, or evidence IDs. The repaired result is validated again; failure becomes `FAILED_VALIDATION` and no public brief is inserted.

## 11. Security and testing

`OPENAI_API_KEY`, Notion token, Supabase invocation secrets, and local service keys remain server-side and are excluded from git, workflow exports, logs, and provider error bodies. Public and private tables are backend-only with RLS/revoked anon/authenticated access and service-role grants consistent with existing migrations.

Tests cover pgTAP constraints/security, snapshot ordering and fingerprints, deterministic classification and fallback, provider request mapping/retries/safe errors, quality gate and exactly-one repair, orchestrator idempotency/concurrency/state outcomes, Notion mapping/ownership/revision branching, n8n routing, and M4/M4.5 regressions. Actual OpenAI and Notion smoke use safe fixtures and do not mutate production editorial content.
