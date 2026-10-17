# Google News Promotion and Intelligence Recovery Plan

> **For agentic workers:** Execute inline with test-driven development. Track each fix and verification in the plan ledger.

**Goal:** Make resolved Google News observations link reliably to promoted stories and prevent Intelligence clustering from failing when source evidence follows a reassigned post.

**Architecture:** Claim discovery observations with an atomic null-or-same-job filter and reject no-row updates. Centralize story membership moves in a private database function that relocates dependent source evidence before changing the membership key, merging duplicate sources safely.

**Tech Stack:** Deno, Supabase Edge Functions, Postgres, pgTAP.

**Spec:** Production diagnosis confirmed in this conversation: new discovery rows have null promotion_job_id, assignment filtered by the current job ID silently updates zero rows; cluster membership updates are restricted by dependent story_cluster_sources references.

## Global Constraints

- Preserve idempotent retries for the same promotion job.
- Prevent a concurrent promotion job from stealing an observation already claimed by another job.
- Preserve source evidence and citation counts when a raw post moves between story clusters.
- Keep database functions SECURITY INVOKER and service-role-only.

## Review Focus

- A missing observation or stale promotion job must fail loudly instead of appearing promoted.
- Same-job retries must remain idempotent.
- Moving source evidence when the destination already has that source must not violate the source table primary key or lose citation counts.
- A failed membership reassignment must remain transactionally atomic.

---

### Task 1: Make discovery assignment claimable and observable

**Files:**
- Modify: `supabase/functions/promote-discovery/repository.ts`
- Test: `supabase/functions/tests/promote-discovery/repository_test.ts`

**Interfaces:**
- Consumes: `assignObservation(observationId, storyClusterId, sourceObservationId, promotionJobId?)`
- Produces: assignment accepts unclaimed or same-job rows, returns an updated representation, and throws on a zero-row update.

- [ ] Add a regression test for a new observation with null promotion_job_id and for zero-row assignment.
- [ ] Run the targeted Deno test and confirm it fails before implementation.
- [ ] Update the conditional PATCH and require at least one returned row.
- [ ] Run the targeted test and the promote-discovery test suite.

### Task 2: Preserve source evidence when cluster membership moves

**Files:**
- Create: one Supabase migration generated with `supabase migration new`
- Test: `supabase/tests/database/028_member_evidence_reassignment_test.sql`

**Interfaces:**
- Consumes: `public.upsert_story_cluster_member(uuid,uuid,text,numeric,jsonb)`, `public.reassign_story_cluster_post(uuid,uuid,text)`
- Produces: both RPCs move the membership and any evidence first-cited by that post atomically; same-source destination evidence is merged.

- [ ] Add pgTAP assertions for a move with unique source evidence and a move with destination-source overlap.
- [ ] Run the database test and confirm the regression reproduces before the migration.
- [ ] Add a private SECURITY INVOKER helper and update both membership RPCs to use it.
- [ ] Run database tests, Supabase advisors, and targeted Edge Function tests.

### Finish

- [ ] Review the complete diff and verify the migration against production schema.
- [ ] Deploy through the production migration path only after tests and review pass.
- [ ] Re-run the relevant promotion and Intelligence pipeline and verify database state and readiness.

