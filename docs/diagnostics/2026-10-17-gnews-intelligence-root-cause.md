# Google News and Intelligence Production Root Cause

- Hourly Google News discovery and publisher URL resolution run, but assignment PATCH filters for the current promotion_job_id even though unclaimed rows have NULL. PostgREST returns no rows with `return=minimal`, and the repository reports success.
- Intelligence upserts `story_cluster_posts.story_cluster_id` on raw-post conflict. `story_cluster_sources` has a RESTRICT composite FK from `(story_cluster_id, first_cited_post_id)` to the membership table, so reassignment fails while source evidence still points to the old cluster.
- Morning brief returns 503 when intelligence readiness is degraded/failed. Current readiness failures correspond to the membership FK violation.
