# M9: Fixed CTA (approved 2026-10-11)

**Decision:** reuse the already-approved Figma CTA image as an immutable final carousel slide. Do **not** regenerate the last slide using AI, Pillow, or prompts for every story.

- Corrected Figma base: file `E25nG2ygwWaTkGjUQ8gQFK`, page-1 frame `125:284` (`BRUNO TRANSFER CTA`).
- Corrected asset: `CTA_MANUTD_EDITOR_v1.png`, 1080 × 1350 PNG.
- The Figma screenshot's embedded phone UI originally said `manutd_ediotor`. The approved corrected PNG changes that embedded username to `manutd_editor`; other artwork and upper CTA text are preserved.
- Supabase Storage **bucket is configurable** (`M9_CTA_STORAGE_BUCKET`, suggested `manutd-card-assets`); object path is fixed at `assets/cta.png`.

## CTA uploaded to the correct Supabase project (verified 2026-10-11)

Project: `byymtttpwmllqvggnddm` (`Manutd editor`). Private bucket: `manutd-card-assets`. Storage object: **`assets/cta.png`**, MIME `image/png`, byte size `1,189,471`. The user uploaded the approved corrected CTA and moved/renamed it to match the contract. The object record has been verified in `storage.objects`. The hash and pixel dimensions have not been verified from Storage bytes (only the original approved PNG's metadata). No re-upload is necessary.

For rebuilding the asset in a fresh ManUtd environment only, download the approved corrected PNG and run:

```bash
export SUPABASE_URL="https://YOUR_MANUTD_REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
export M9_CTA_STORAGE_BUCKET="manutd-card-assets"
node scripts/upload-m9-cta.mjs ./CTA_MANUTD_EDITOR_v1.png
```

Use a private environment for the service role key. Ensure the bucket exists and set suitable read/signed-URL permissions. The script validates PNG format and 1080×1350 dimensions. It does not overwrite an existing CTA.

## Render pipeline contract

After generating the news photos, call `appendFixedCta(renderedSlides, bucket)` from `_shared/m9/fixed_cta.ts`. It appends **one** metadata entry pointing to `assets/cta.png`, as the last slide. It protects ordering, duplicate CTAs, and the Telegram 10-item photo-album limit.

The `_shared/m9/telegram_album.ts` module now provides a Supabase signed-URL adapter and a Telegram Bot API `sendMediaGroup` adapter to deliver that private image as the final album item. It signs every rendered image before sending; if signing fails, nothing is sent. The adapter does **not** yet run in the live Telegram webhook, because the main M9 news-photo renderer and a job trigger are not deployed.

**Validation:** Node 24 mock tests passed: ordered slides including CTA, signer preflight, no partial sends on missing images, one `sendMediaGroup` call, no automatic retry on ambiguous network errors, and 10-photo limit. The Deno test suite, actual Supabase signed-URL retrieval, actual Telegram Bot API posting and live pipeline wiring are not yet validated.

**Still pending:** Render actual per-story images, persist them, wire `deliverM9Carousel` into an owner-authorized Telegram command with a proper job lifecycle/dedupe, verify signed URLs and perform a deliberately requested test send. Keep this PR as a draft until those integration checks complete.
