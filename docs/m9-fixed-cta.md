# M9: Fixed CTA (approved 2026-10-11)

**Decision:** reuse the already-approved Figma CTA image as an immutable final carousel slide. Do **not** regenerate the last slide using AI, Pillow, or prompts for every story.

- Corrected Figma base: file `E25nG2ygwWaTkGjUQ8gQFK`, page-1 frame `125:284` (`BRUNO TRANSFER CTA`).
- Corrected asset: `CTA_MANUTD_EDITOR_v1.png`, 1080 × 1350 PNG.
- The Figma screenshot's embedded phone UI originally said `manutd_ediotor`. The approved corrected PNG changes that embedded username to `manutd_editor`; other artwork and upper CTA text are preserved.
- Supabase Storage **bucket is configurable** (`M9_CTA_STORAGE_BUCKET`, suggested `manutd-card-assets`); object path is fixed at `assets/cta.png`.

## One-time asset upload (blocked pending correct Supabase project)

The currently connected Supabase account exposes **Date-Navi only**. Do not upload ManUtd assets to that unrelated project.

Once the right ManUtd project and its storage bucket are accessible, download the approved corrected PNG and run:

```bash
export SUPABASE_URL="https://YOUR_MANUTD_REF.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="YOUR_SERVICE_ROLE_KEY"
export M9_CTA_STORAGE_BUCKET="manutd-card-assets"
node scripts/upload-m9-cta.mjs ./CTA_MANUTD_EDITOR_v1.png
```

Use a private environment for the service role key. Ensure the bucket exists and set suitable read/signed-URL permissions. The script validates PNG format and 1080×1350 dimensions. It does not overwrite an existing CTA.

## Render pipeline contract

After generating the news photos, call `appendFixedCta(renderedSlides, bucket)` from `_shared/m9/fixed_cta.ts`. It appends **one** metadata entry pointing to `assets/cta.png`, as the last slide. It protects ordering, duplicate CTAs, and the Telegram 10-item photo-album limit.

The upcoming M9 renderer must retrieve this object from Supabase Storage (using a short-lived signed URL for private buckets), then include it as the last PNG in Telegram media group **without editing pixels**. This module is intentionally preparatory: the repository currently generates text briefs, not a complete media-rendering pipeline.

**Not yet done:** Storage upload to ManUtd project, production renderer hook, Telegram media group upload, runtime deployment. Merge only after a real asset and Storage project are available, and test with a generated deck.
