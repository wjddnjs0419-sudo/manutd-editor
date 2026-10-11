# M9 Automated private Telegram preview worker

Status (2026-10-12 KST): **implemented and locally exercised on live Guardian photo sources; NOT deployed to production**.

## Confirmed operating flow

`original article URLs + explicit subject aliases` → `scripts/m9_collect_media.ts` (publisher-first real photo candidate discovery, 1920px signed srcsets) → `scripts/m9_acquire_photos.py` (bounded trusted-image-CDN download, original bytes and SHA-256 provenance) → `scripts/m9_preview_workflow.py` (loads existing public.creative_briefs row, maps EXACT slide headlines/body without inventing claims, invokes Pillow cover/body renderer, uploads 2 PNGs to private Supabase Storage, signs both plus fixed CTA, then **optional owner-only** Telegram `sendMediaGroup` preview).

`scripts/m9_run_pipeline.py` runs the entire chain with one command. `scripts/m9_render_news_deck.py` continues to use approved Figma COVER_NEWS v3 + BODY_NEWS v1 designs, with `assets/cta.png` always static and never regenerated.

### Sample source request

```json
{
  "publisher_article_urls": [
    "https://www.theguardian.com/football/2026/oct/10/michael-carrick-manchester-united-tottenham-roberto-de-zerbi",
    "https://www.theguardian.com/football/2026/oct/10/manchester-united-tottenham-premier-league-match-report"
  ],
  "official_article_urls": [],
  "slots": [
    { "slot": "COVER_NEWS", "subject_aliases": ["Michael Carrick"] },
    { "slot": "BODY_NEWS", "subject_aliases": ["Dominic Solanke"] }
  ],
  "allowed_image_hosts": ["i.guim.co.uk"]
}
```

Use exact, operator-approved publisher CDNs; **never** derive the host allowlist from untrusted HTML.

### Local full pipeline (no network writes to Supabase or Telegram)

Requires Python 3.11+, `Pillow`, Deno 2 and a locally installed Korean font and brand logo (do not redistribute font assets). `--cta` optional in CLI, but recommended for complete local visual review.

```bash
python3 -m pip install Pillow
python3 scripts/m9_run_pipeline.py --request ./request.json \
  --brief-json ./brief.json --workdir ./m9-preview \
  --font /local/path/KoreanBold.otf --logo /local/path/manutd-logo.png \
  --cta /local/path/cta.png
```

The creative brief comes from actual `creative_briefs.slides_json` **object** shape `{ "slides": [...] }`; `hooks_json` contains text. This code uses existing brief prose. It does not create fresh football claims or automatically fix headline overflow; those cases fail for editor review.

### Private upload only (no Telegram)

1. Deploy the **staged, unapplied** migration `supabase/migrations/20261012000100_m9_preview_jobs.sql` after review. It creates only the service-role-accessible `app_private.m9_preview_jobs` unique job table.
2. Confirm private Supabase bucket `manutd-card-assets` with fixed CTA `assets/cta.png`; it already exists in the connected Manutd Editor Supabase project.
3. Configure the worker in a trusted secret-management environment; never commit secrets:

```bash
export SUPABASE_URL='https://<YOUR_PROJECT_REF>.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='<FROM_SECRET_MANAGER>'
python3 scripts/m9_run_pipeline.py --request ./request.json \
  --brief-id '<EXISTING_CREATIVE_BRIEFS_UUID>' \
  --workdir ./m9-preview --font /local/path/KoreanBold.otf \
  --logo /local/path/manutd-logo.png --upload
```

Uploads only the **two newly rendered PNGs** to immutable per-job Storage paths under `manutd-card-assets/previews/<job_uuid>/slide_0X.png`. The existing CTA object is **not re-uploaded**.

### Optional owner-only private Telegram preview

After the generated album is visually reviewed in a sandbox and rights/identity metadata acknowledged, configure these secrets in the Python worker host (NOT the repo):

```bash
export TELEGRAM_BOT_TOKEN='<FROM_SECRET_MANAGER>'
export TELEGRAM_OWNER_USER_ID='<OWNER_PRIVATE_CHAT_ID>'
export M9_ENABLE_TELEGRAM_PREVIEW='YES'
```

Append `--send-telegram --chat-id "$TELEGRAM_OWNER_USER_ID"` to the upload command above. Only an exact owner chat ID may receive the album. All three private storage object links are signed BEFORE dispatch. Each unique job is claimed first with a DB `job_key` constraint. States: `CLAIMED → RENDERED → UPLOADED → SENDING → SENT`, or `FAILED / SEND_UNCERTAIN`. A duplicate claim fails. **Never auto-retry any SENDING/SEND_UNCERTAIN job**, since Telegram may have posted already.

**NOTE:** A private Telegram preview is NOT approval to publish any copyrighted news photo on Instagram. The photo metadata records original agency/article URLs and always marks redistribution rights UNVERIFIED unless separately verified.

## Verification

- Actual October 10, 2026 Guardian article HTML was fetched in the test sandbox. Deno collected 16 image candidates, selected credited Carrick (Phil Noble/Reuters) and Solanke (Dave Thompson/AP), verified both at 1920×1536.
- Python downloaded signed publisher JPEGs (no Wikimedia, no generated photos). **One-command CLI rendered three 1080×1350 slides** including byte-identical static CTA.
- **Deno tests:** 32 passed / 0 failed. **Python tests:** 18 passed / 0 failed. Tests include dedupe, upload/signing/Telegram mock contracts, failure handling, and photo SHA-256 checks.
- **Not executed:** a live Supabase `m9_preview_jobs` migration, an actual PNG Storage write through this worker, or a Telegram Bot API send. Current production collection, grounding and Telegram webhook remain unchanged.

## Missing for fully unattended news-to-Telegram production

- The **article URLs and subject aliases currently originate in an explicit, verified input request**. A new owner-authorized boundary must map the active `content_candidate → creative_briefs → grounded source observations → named player aliases` automatically and produce this request without making up subjects.
- Provision a **persistent Python-capable worker host/queue scheduler** with installed font/branding and secrets; Supabase Edge Functions alone cannot execute Pillow.
- Verify migration with a staging project, prove actual signed-photo and Storage upload, and send ONE explicitly authorized private Telegram test album. Check image layout, credits, error states and dedupe before merging PR #7 or activating schedules.
- Optional `PLAYER_PROFILE` renderer integration remains separately pending; current automated sample generates COVER, BODY and CTA only.
