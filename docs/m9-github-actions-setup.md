# M9 manual GitHub Actions worker — setup and review

Status (2026-10-12 KST): **prepared on DRAFT PR #7, not yet deployed/triggered**. The private Supabase `app_private.m9_preview_jobs` migration **HAS already been applied** to Manutd editor (`byymtttpwmllqvggnddm`) on 2026-10-12. No M9 job row or Telegram message has been created in production.

## Why GitHub Actions?

The M9 slide renderer is Python Pillow, whereas the existing Supabase Edge Functions run Deno. A manual GitHub Actions workflow can run Python and Deno together without creating a continuously running Vercel server. The workflow is **manual only**, not scheduled, and is intended for a private review album only.

## Before you run

1. Review and merge PR #7 only after you are happy with the M9 implementation. GitHub requires a `workflow_dispatch` workflow file on the default branch before the Actions `Run workflow` control can reliably appear.
2. Go to GitHub repository **Settings → Secrets and variables → Actions → New repository secret**. Add the following four repository secrets. NEVER put their values into source files, chat messages, issue descriptions, Actions inputs or pull-request comments:
   - `M9_SUPABASE_URL`: `https://byymtttpwmllqvggnddm.supabase.co`.
   - `M9_SUPABASE_SERVICE_ROLE_KEY`: the **service_role/secret** key from the correct Manutd editor project; NOT an anon or publishable key. Keep it in GitHub Secrets only.
   - `M9_TELEGRAM_BOT_TOKEN`: the existing Telegram editorial bot token from its owner.
   - `M9_TELEGRAM_OWNER_USER_ID`: numeric ID of the bot owner's PRIVATE Telegram chat. Group chats are not accepted by design.
3. Confirm the original fixed CTA still exists at private `manutd-card-assets/assets/cta.png` and matches SHA256 `65d40cfa3421d343616eeb6d8412c1feac3aa1d051c3793f8086a0710ccfa88c`. The workflow checks both that hash and the 1080×1350 PNG size.
4. The original Figma-approved brand mark is already supplied in the repository as `assets/manutd_editor_logo.png`, resized losslessly to 86px for the header. The Korean font is fetched during each run and is NOT checked in or uploaded as an artifact.

## Safe 2-step operator flow

Open **GitHub → Actions → M9 private card-news preview → Run workflow**.

### Step A — upload private images only

Select `mode = upload_preview`, enter the `brief_id` from an existing verified `creative_briefs` record, and set exact trusted photo CDN hostname(s) in `approved_image_hosts` (comma-separated), e.g., `i.guim.co.uk` for a Guardian article. Do not supply wildcard CDN domains.

Expected result: `COVER_NEWS` and `BODY_NEWS` PNGs are uploaded under private `manutd-card-assets/previews/<stable-job-id>/`, and the original static CTA is referenced separately. The DB job row becomes `UPLOADED`. There is **no Telegram delivery** at this stage. To review the two generated images, open the Supabase Storage dashboard for Manutd editor, select `manutd-card-assets`, find the new `previews/` folder and inspect image contents. Review names, image reuse permission/licensing and article correctness.

The workflow does not attach photos to public GitHub artifacts. Private bucket access is required to inspect them.

### Step B — send the already-uploaded album

After visually reviewing the uploaded PNGs and accepting internal use of the supplied editorial photo samples, run the SAME workflow and SAME `brief_id` again with `mode = send_uploaded`. That path **does not recollect, render, or upload** photographs. It only signs the existing two PNGs + fixed CTA and sends one `sendMediaGroup` Telegram review album to the configured owner's private chat.

State transition is guarded: `UPLOADED → SENDING → SENT`, or `SEND_UNCERTAIN`. Ambiguous network sends must NEVER be retried automatically; inspect the Telegram chat and DB row before deciding anything. The same brief and version cannot be sent a second time.

## Cases correctly requiring manual intervention

- Multiple footballers named in a single cover visual-direction subject (e.g. Fred + Ten Hag) -> `M9_AMBIGUOUS_PHOTO_SUBJECT_PAGE_1` instead of choosing the wrong player.
- No safe direct publisher URL / unresolvable Google News wrapper -> source discovery stops.
- Unknown subject, missing image captions, blocked CDN / non-image response, short image dimensions -> no upload.
- Existing creative brief has a cover/body headline exceeding the approved Figma safe text region -> fail for copy editing (never silently truncate a football claim).
- Missing permission to redistribute publisher images -> no automatic Instagram posting; this system is PRIVATE editor-review delivery only.

## What remains outside this PR

- The existing news processing pipeline does **not** automatically launch Actions for every new brief yet. This workflow is explicitly manual and is run against an existing brief ID.
- The full `PLAYER_PROFILE` template requires a separate production renderer integration; here only cover/body/fixed CTA are assembled.
- A staging/integration run with the REAL configured GitHub Actions secrets and a deliberately approved Telegram owner chat has **not been performed**.
- Later: connect an owner-validated Telegram `render` callback to safely enqueue workflow or deploy an always-on Python job runner. Do not expose service-role keys in Telegram callbacks.

## Test evidence

- `deno test --allow-net supabase/functions/tests/m9/`: 32 passed / 0 failed.
- `python -m unittest discover -s scripts/tests -p 'test_m9*.py'`: 33 passed / 0 failed.
- GitHub Actions YAML parsed successfully and approved CTA SHA verified on the test sandbox.
- Deno/Python one-command smoke using two real Guardian source articles produced three 1080×1350 PNGs, without Storage upload or Telegram send.
