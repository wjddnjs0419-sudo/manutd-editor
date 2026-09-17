# Milestone 2 Meta Ingestion Vertical Slice Design

## Objective

Implement one production-shaped ingestion path for the single Instagram account `@utdreport`:

```text
n8n Schedule (Milestone 3)
  -> Supabase Edge Function
  -> Meta Business Discovery API
  -> Supabase Postgres
```

Milestone 2 implements and verifies the Edge Function, Meta response normalization, and atomic database ingestion. It does not create the n8n schedule or workflow.

## Scope

The vertical slice must:

- query `@utdreport` with Meta Business Discovery;
- update `source_accounts.instagram_account_id` with the real Instagram account ID;
- collect the latest media;
- accept `IMAGE`, `CAROUSEL_ALBUM`, and Reels represented by `media_type = VIDEO` and `media_product_type = REELS`;
- keep Reel `view_count` nullable when Meta does not return it;
- upsert `raw_posts` without duplicating an external post;
- create exactly one initial `post_metric_snapshots` row for each collected post;
- prevent partial domain writes when Meta validation or database persistence fails;
- remain idempotent when an invocation is retried or its response is lost; and
- keep Meta access and database persistence independently testable.

Carousel child assets and subsequent metric snapshots are outside this milestone. A carousel is stored as one parent `raw_posts` row, with the complete Meta object retained in `raw_payload` for later child processing.

## Selected Architecture

The Edge Function fetches and validates the complete Meta batch before invoking one Postgres RPC. The RPC performs the account update, post upserts, and initial snapshot inserts in a single transaction.

This is preferred over sequential `supabase-js` table calls because sequential calls cannot guarantee rollback across tables. It is preferred over a direct Postgres connection from the Edge runtime because the direct connection would add unnecessary connection and secret-management complexity.

```text
POST /functions/v1/collect-instagram
  -> authenticate collector secret
  -> validate configuration
  -> fetch Business Discovery response
  -> validate and normalize entire response
  -> deduplicate normalized media by external post ID
  -> invoke ingest RPC once
       -> lock @utdreport source account row
       -> update source account discovery state
       -> upsert raw posts
       -> insert missing initial snapshots
  -> return a structured collection summary
```

## Edge Function Boundaries

The implementation separates orchestration from external systems:

- `index.ts`: HTTP method handling, invocation authentication, environment wiring, safe HTTP responses.
- `collector.ts`: application use case that composes the Meta client, normalizer, and repository.
- `meta_client.ts`: Business Discovery request construction, response decoding, error classification, and retry policy.
- `normalizer.ts`: strict conversion from the Meta response into database-independent account and post DTOs.
- `repository.ts`: the single Supabase RPC call and database error translation.
- `types.ts`: narrow interfaces and DTOs shared across those boundaries.

The collector consumes interfaces rather than concrete network clients. Unit tests can therefore provide deterministic fakes without calling Meta or Supabase.

## Meta Request and Normalization

The Meta client requests the Business Discovery account fields needed by this slice: account ID, username, follower count, and a limited page of recent media with ID, caption, permalink, timestamps, type/product type, engagement counters, optional view count, and raw media metadata.

The number of requested media items is a bounded configuration value with a conservative default. Pagination beyond the first requested page is outside Milestone 2.

The normalizer enforces the following contract:

- the discovered username must case-insensitively equal `utdreport`;
- account ID and every post ID must be nonblank strings;
- media timestamp and media type are required;
- engagement counts, when present, must be nonnegative integers;
- `IMAGE` and `CAROUSEL_ALBUM` are accepted;
- a Reel is accepted as `VIDEO` plus `REELS`;
- other media combinations fail validation;
- missing Reel view count becomes `null` rather than an error;
- duplicate media IDs in one Meta response collapse to one normalized post; and
- the unmodified per-post Meta object is retained as `raw_payload`.

The normalized collection timestamp is created once per invocation and reused for all rows in that batch. `post_age_minutes` is the nonnegative whole-minute difference between this timestamp and the published timestamp.

## Atomic Database Ingestion

The Edge Function calls one public-schema RPC through Supabase REST. The function locates `source_accounts.username = 'utdreport'` and locks that row with `FOR UPDATE`, serializing concurrent invocations for the same account.

Inside the transaction, the RPC:

1. verifies that the target account exists, is active, and is the fixed Milestone 2 account;
2. validates the JSON account and post payload again at the database boundary;
3. updates the real Instagram account ID, capability flags, successful probe time, and clears the probe error;
4. upserts each `raw_posts` row using `(source_account_id, external_post_id)`;
5. refreshes mutable raw-post fields, counters, payload, and `collected_at` on conflict; and
6. inserts a metric snapshot only when the resolved raw post has no existing snapshot.

The existing unique raw-post constraint provides durable post deduplication. The source-account row lock makes the snapshot existence check safe against concurrent calls. A retry after a successful commit may refresh `raw_posts`, but it does not create another initial snapshot.

Future milestones may add subsequent metric snapshots. Therefore Milestone 2 does not add a uniqueness constraint that permits only one lifetime snapshot per post.

## RPC Security

The ingest function uses `SECURITY INVOKER`. The migration explicitly revokes `EXECUTE` from `PUBLIC`, `anon`, and `authenticated`, then grants it only to `service_role`.

The function uses `SET search_path = ''` and fully qualifies every schema object even though it is not a definer function. This keeps name resolution deterministic and preserves a safe default if the implementation later changes.

`SECURITY DEFINER` is not needed because `service_role` already has the required table privileges. If a later migration introduces it, that migration must document the concrete privilege requirement, retain an empty search path, and fully qualify every relation and function.

## Edge Function Authentication and Secrets

The function is an external service-to-service endpoint. n8n will not receive a Supabase secret key.

The function is configured with `verify_jwt = false` because the caller does not receive a Supabase JWT or secret key. The caller sends `Authorization: Bearer <COLLECTOR_INVOKE_SECRET>`. The function performs a timing-safe comparison with the environment secret before any Meta or database call. A missing, malformed, or incorrect credential returns `401` without identifying which check failed.

The Edge Function alone reads the `default` key from the runtime-injected `SUPABASE_SECRET_KEYS` JSON dictionary and uses it only for the internal RPC call. A singular `SUPABASE_SECRET_KEY` is accepted as a local/CI fallback. The opaque `sb_secret_...` value is sent only in PostgREST's `apikey` header, never as an `Authorization` bearer token. Supabase maps it to the PostgreSQL `service_role`. Other required secrets and configuration are:

- `COLLECTOR_INVOKE_SECRET`;
- `META_ACCESS_TOKEN`;
- `META_BUSINESS_ACCOUNT_ID`;
- `META_API_VERSION`;
- `SUPABASE_URL`; and
- `SUPABASE_SECRET_KEYS` (or local/CI fallback `SUPABASE_SECRET_KEY`).

Secrets and tokens are never returned or logged. Structured logs contain only safe request IDs, attempt counts, HTTP status classes, normalized error codes, account username, and aggregate item counts. Raw authorization headers, access tokens, Supabase secret keys, and complete Meta error bodies are excluded.

The n8n workflow and secret provisioning in n8n remain outside Milestone 2.

## Failure and Retry Strategy

### Meta failures

Network errors, HTTP `429`, and HTTP `5xx` are retried up to three total attempts with exponential backoff and jitter. A valid `Retry-After` header takes precedence. Authentication, permission, and malformed-request errors are not retried.

No domain data is written until the full Meta response has been fetched and normalized successfully.

### Validation failures

One malformed or unsupported post fails the whole batch before the RPC call. This is an intentional Milestone 2 limitation that favors a small, observable, atomic vertical slice.

The normalization boundary returns item-specific validation information internally, so Milestone 3 can replace fail-fast behavior with a quarantine or rejected-item sink. At that point, one malformed or unsupported item must not block all valid items for an account or prevent other accounts from being collected.

### Database failures

Any error inside the RPC rolls back the account update, every raw-post upsert, and every snapshot insert. The repository may retry the idempotent RPC once for a transient network error or ambiguous response loss. Deterministic Postgres constraint and validation errors are not retried.

If the first RPC actually committed but its response was lost, the retry refreshes the same raw-post rows and observes that their initial snapshots already exist.

## HTTP Contract

Milestone 2 exposes one `POST` endpoint with no caller-selectable username. The account is fixed to `utdreport`, preventing this slice from becoming an unreviewed arbitrary-account collector.

Success returns a request identifier, account username, discovered account ID, received media count, deduplicated media count, inserted post count, updated post count, and inserted initial snapshot count.

Failure responses use a stable error code and safe message. They do not expose upstream response bodies, SQL details, stack traces, or secret material.

## Test Strategy

### Deno unit tests

- normalize `IMAGE`, `CAROUSEL_ALBUM`, and Reel media;
- preserve a nullable Reel view count;
- reject unsupported and malformed media;
- reject a mismatched discovered username;
- deduplicate repeated media IDs;
- verify fail-fast behavior for a malformed item;
- retry transient Meta failures and respect retry limits;
- avoid retrying permanent Meta failures;
- verify the collector does not call the repository after a Meta or normalization failure; and
- verify the HTTP handler rejects a missing or invalid collector secret without calling dependencies.

### pgTAP integration tests

- deny RPC execution to `PUBLIC`, `anon`, and `authenticated` and allow `service_role`;
- assert the RPC is `SECURITY INVOKER` with an empty configured search path;
- update the seeded `utdreport` account with its discovered ID;
- insert raw posts and initial snapshots atomically;
- map a nullable Reel view count through both tables;
- rerun an identical batch without increasing raw-post or snapshot counts;
- refresh an existing raw post while preserving its original snapshot;
- roll back the entire transaction when any input row violates the contract; and
- reject an account other than the fixed Milestone 2 target.

### Local and live verification

The completion gate is:

1. reset the local Supabase database from migrations and seed;
2. run the complete existing and new pgTAP suite;
3. run the complete Deno unit test suite;
4. serve and invoke the Edge Function locally with controlled dependencies where applicable;
5. lint the database schemas and review the migration diff; and
6. with secrets supplied through the environment, run one real `@utdreport` smoke collection and verify the account row, post rows, and exactly one initial snapshot per collected post.

If live credentials are unavailable in the execution environment, steps 1 through 5 remain mandatory and the live smoke step is reported as blocked rather than simulated.

## Milestone Boundary

Milestone 2 ends when the single-account Edge Function vertical slice is locally verified and the real `@utdreport` smoke test has either passed or has an explicit credentials-only blocker.

Milestone 3 may add n8n scheduling, multiple accounts, pagination, quarantine/rejected-item persistence, carousel child assets, probe-failure persistence, and subsequent metric snapshots. None of those extensions are introduced implicitly in this slice.
