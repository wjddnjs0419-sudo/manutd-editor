# M9 End-to-End Production Readiness

## Reused paths

- M6's owner-only Telegram console already selects canonical M8 stories and invokes the existing Creative Generation edge function. That function retains the current OpenAI Responses provider, evidence checks, DRAFT/READY policy, usage accounting, deduplication, and daily Exploration cap.
- M8 already supplies publisher URLs and source evidence. M9 derives photo-search subjects from the saved brief; the collector/acquirer already keeps publisher provenance, checks duplicate photos, runs MediaPipe on CPU, and records crop/review details.
- Pillow already renders the existing 1080×1350 FULL_BLEED design, Pretendard type, gradients, and fixed CTA. The manual GitHub Actions worker and service-role-only M9 job RPCs already exist.
- PR #8's READY-only automation is a separate path and is unchanged.

## Wiring completed here

- A Telegram `GENERATE_CAROUSEL` action now reports that the article and sources are being checked while the existing Creative Generation call runs. Once an Exploration DRAFT is saved, the same owner request dispatches the existing cloud workflow in `owner_review` mode; if dispatch is unavailable, the saved DRAFT keeps its manual preview action. No second AI provider was added.
- M9 generation and DRAFT preview callbacks are accepted only from the configured owner in that owner's private chat. Read-only M6 console actions retain their existing behavior. Duplicate `update_id` handling remains before the application callback.
- The photo pipeline now accepts a reviewed selection for each content page (2–6) instead of requiring exactly two. Exploration's existing content-mode limits remain the final gate.
- The workflow installs the pinned MediaPipe/Pillow CPU dependencies. DRAFT dispatches use only the dedicated `m9-e2e-test` GitHub Environment secrets; they never fall back to the generic M9 secrets.
- Every rendered content PNG and the byte-identical fixed CTA is uploaded under the unique job path. The worker requires a private bucket, downloads each object again, compares SHA-256, and confirms the anonymous public-object URL is denied before marking the job uploaded.
- The private job manifest now retains job/brief/story IDs, content mode, generated time, ordered object paths and hashes, caption, publisher/source, photo credits, render manifest, review flags, and provider usage. The service-role-only `m9_get_preview` RPC returns that manifest for follow-up delivery.
- An explicit owner DRAFT review sends the PNG bytes unchanged in order as a Telegram document group, then sends the copyable Korean caption separately. Telegram message length is split safely; uncertain sends are not retried. The older READY send path remains compatible.
- GitHub Actions has bounded runtime/concurrency, no scheduled run, no automatic retry, and a failure status message for an owner-requested DRAFT job. The renderer continues to fail closed for missing content, failed render, or incomplete Storage verification.

## Existing gaps that remain intentionally outside the worker

- M6 article generation is synchronous in the Supabase Edge Function. It is cloud-side and does not need the MacBook, but it is not a separate queued OpenAI job. The saved DRAFT is handed to M9 by a second explicit Telegram preview action.
- The M9 worker does not invoke OpenAI. OpenAI generation remains in the existing Creative Generation path and runs only when the owner requests a carousel. The worker records the saved brief's provider usage; it cannot create a brief if that upstream function is unavailable.
- The private Storage bucket and fixed CTA must exist in the test Supabase project. The repository contains the M9 job/RPC migrations, but this task did not apply migrations to any remote project.
- Code changes in a Draft PR are not live in the Supabase Telegram edge function or the default-branch workflow until a separate deployment/merge. Neither happened here.

## Configuration required before an isolated live test

1. Create a disposable Supabase project; apply the repository schema and M9 job/RPC migrations there, including `20261012160000_m9_preview_manifest_rpc.sql`. Create `manutd-card-assets` as a **private** bucket and copy the already-approved fixed CTA into `assets/cta.png`. Do not point the DRAFT workflow at the production project.
2. Create a GitHub Environment named `m9-e2e-test` and set these environment secrets:
   - `M9_TEST_SUPABASE_URL`
   - `M9_TEST_SUPABASE_SERVICE_ROLE_KEY`
   - `M9_TEST_TELEGRAM_BOT_TOKEN` (the existing bot token, only after the owner approves this test use)
   - `M9_TEST_TELEGRAM_OWNER_USER_ID` (the confirmed numeric private-chat ID)
3. Configure the existing Supabase edge-function secrets used by M6/Creative Generation and the Telegram dispatcher: the approved OpenAI test key/budget, existing Telegram bot configuration, `M9_GITHUB_ACTIONS_TOKEN`, `M9_GITHUB_REPOSITORY`, and `M9_GITHUB_WORKFLOW_REF`. Do not replace or reveal production keys.
4. Only after a mock end-to-end run passes, the disposable Storage bucket and owner chat are confirmed, and the owner explicitly starts the one-article test, use one Telegram private-chat request. The M9 worker makes no OpenAI call; the first Telegram generation action is the only step that can incur OpenAI cost.

At the start of this task, GitHub exposed only the names of the generic `M9_SUPABASE_*` and `M9_TELEGRAM_*` secrets; their values and destination could not be inspected. No GitHub Environment or test-specific M9 secrets were present. Consequently, this change did not dispatch the private-preview workflow or contact OpenAI, Supabase Storage, or Telegram. The no-secret CPU-validation workflow remains safe to run separately.
