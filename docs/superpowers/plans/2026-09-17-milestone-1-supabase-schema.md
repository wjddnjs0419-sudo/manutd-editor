# MU Content Intelligence Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a reproducible, secure Supabase/Postgres foundation for deterministic Manchester United content intelligence scoring.

**Architecture:** Supabase is the canonical backend. Public-schema tables are reachable only by the server-side `service_role`; `anon` and `authenticated` receive no table access in Milestone 1. Raw Instagram facts, time-series metrics, story/source relationships, scoring configuration, candidate scores, creative briefs, publications, and performance are separated so every score can be audited.

**Tech Stack:** PostgreSQL 17, Supabase CLI 2.117.0, pgTAP, Git/GitHub

**Spec:** `/Users/jeongwonkim/.codex/attachments/0026f628-b502-4f79-b5ab-1cdff80e0517/pasted-text.txt`

## Global Constraints

- Implement Milestone 1 only; do not implement collectors, clustering logic, scoring execution, Telegram, or Notion sync.
- Keep Priority Score deterministic and separate from AI editorial assessment.
- Model `information_sources` as real entities, not reliability categories.
- Add versioned `scoring_configs`; candidates reference the exact configuration used.
- Permit follower counts of zero and unknown (`NULL`); scoring must treat zero/unknown as unavailable denominators.
- Do not persist `weighted_engagement`; calculate it deterministically from metric inputs and the selected scoring configuration.
- Never commit or log credentials, project passwords, service-role keys, or Meta tokens.
- Enable RLS on every public table and deny `anon` and `authenticated` access in this server-only milestone.

---

### Task 1: Repository and database contract tests

**Files:**
- Create: `.gitignore`
- Create: `supabase/tests/database/001_schema_contract_test.sql`
- Create: `supabase/tests/database/002_integrity_and_scoring_test.sql`
- Create: `supabase/tests/database/003_security_and_seed_test.sql`

**Interfaces:**
- Consumes: Supabase local Postgres and pgTAP.
- Produces: Executable contracts for table shape, data integrity, weighted engagement, security, and seed data.

- [ ] Write pgTAP tests for all required relations, keys, RLS, seed records, and behavioral constraints.
- [ ] Start the local Supabase stack.
- [ ] Run `supabase test db` and verify RED because the application schema does not exist.

### Task 2: Core schema and deterministic scoring configuration

**Files:**
- Create: `supabase/migrations/<timestamp>_create_milestone_1_schema.sql`

**Interfaces:**
- Consumes: The pgTAP contracts from Task 1.
- Produces: 13 public tables, private trigger/calculation helpers, constraints, foreign keys, indexes, grants, and RLS.

- [ ] Create the migration with `supabase migration new create_milestone_1_schema`.
- [ ] Add UUID primary keys, timestamps, enums, foreign keys, checks, and query-oriented indexes.
- [ ] Add `private.calculate_weighted_engagement(bigint, bigint, numeric)` as an immutable function; keep `weighted_engagement` out of metric snapshots.
- [ ] Add server-only grants and enable RLS without client policies.
- [ ] Run `supabase db reset` and `supabase test db`; fix only implementation defects until GREEN.

### Task 3: Idempotent realistic seed data

**Files:**
- Create: `supabase/seed.sql`

**Interfaces:**
- Consumes: `source_accounts`, `information_sources`, and `scoring_configs`.
- Produces: Ten monitored accounts, five named source entities, and one active `v1` scoring configuration.

- [ ] Seed monitored accounts with neutral `1.0` weights and no invented Instagram IDs.
- [ ] Seed actual source entities: Manchester United, Fabrizio Romano, BBC Sport, Sky Sports, and The Athletic.
- [ ] Seed the approved 100-point scoring weights and curves as JSON in configuration `v1`.
- [ ] Use conflict-safe upserts and verify a second reset does not duplicate rows.

### Task 4: Documentation and remote delivery

**Files:**
- Create: `README.md`
- Create: `.env.example`

**Interfaces:**
- Consumes: The verified schema and Supabase project reference.
- Produces: Setup, security, data-model, migration, testing, and scoring-data documentation.

- [ ] Document architecture, table responsibilities, authoritative data ownership, commands, and secret handling.
- [ ] Run fresh local reset, pgTAP tests, schema lint/advisors, migration listing, and Git diff review.
- [ ] Push the verified migration to linked Supabase project `byymtttpwmllqvggnddm` and run remote advisors.
- [ ] Commit the repository, create a private GitHub remote, and push `main`.
