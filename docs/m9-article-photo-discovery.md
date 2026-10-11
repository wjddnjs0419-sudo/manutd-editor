# M9.1 — Original news photos + current official club photos

The pipeline **does not use Wikimedia as its primary source**. It first opens the original publisher URL already resolved from Google News, extracts article images, then uses relevant official Manchester United article URLs when supplied. No generative image synthesis.

## Code components

1. `article_photo_candidates.ts`: parse NewsArticle JSON-LD, OG/Twitter images and article figure images. Preserve article URL, optional photographer credit, article publication timestamp and separate photo capture/create timestamp if explicitly stated.
2. `photo_quality.ts`: inspect only up to 128 KiB of remote PNG/JPEG/WebP bytes to read true pixel dimensions. Require configured trusted media hosts; reject redirects, local hosts, unsupported image formats and unresponsive endpoints.
3. `photo_harvest.ts`: combine publisher discovery, de-duplicated one-time image byte probes and cover/body/player-profile ranking. Input includes canonical publisher article URLs, optional official article URLs, and subject aliases from the validated news brief. It returns up to three ranked candidates per slot, and a review-needed status.
4. `fixed_cta.ts`: append the already uploaded, approved static CTA image as the last carousel slide once there are rendered PNGs.

### Example application boundary (pseudocode)

Call `harvestArticlePhotos` from a future owner-authenticated M9 worker with:

    job.publisher_article_urls = [resolvedPublisherArticleUrl]
    job.official_article_urls = [relevantManchesterUnitedArticleUrl] // optional
    job.slots = [{slot: 'COVER_NEWS', subject_aliases: ['Bruno Fernandes']}]
    options.allowedImageHosts = ['TRUSTED_PUBLISHER_IMAGE_CDN_HOST', 'TRUSTED_OFFICIAL_IMAGE_CDN_HOST']

**Configure verified image CDN hostnames explicitly.** Never derive an automatic allowlist from attacker-controlled article HTML. First classify article/photo candidates; then verify actual photo content and usage rights before reuse.

## Exact boundaries

- This chooses **candidate metadata**, not an automatic legal or editorial approval.
- Candidate subject matching uses alt/caption text or filename hints, **not machine-vision proof that the photo depicts the right footballer**.
- Article publication date is not photo capture date. If the image capture date is unknown, the result flags `PHOTO_CAPTURE_DATE_UNKNOWN`. Photos older than a year flag `ARCHIVE_PHOTO`.
- Low-resolution images, unknown subject association and unavailable/blocked media hosts do not become selected candidates.
- Every shortlisted candidate is marked `requires_review: true`, `can_auto_publish: false`, `rights_status: UNVERIFIED`.
- Noncommercial publishing and attribution do not by themselves establish permission to redistribute a copyrighted news photo. Capture source, credit and permission/license basis for the final publish decision.

## Verification (2026-10-11)

- Deno 2.9.7: `deno test --allow-net tests/m9/`: **25 passed, 0 failed** across fixed CTA, photo discovery, image byte/quality checks, combined photo harvest, Telegram media album adapter.
- Tests use representative mocked HTML and PNG/JPEG/WebP byte headers. These are genuine parsing and request-shaping tests **but not a live photo provider success-rate benchmark**.
- The correct private Manutd editor Supabase Storage object `manutd-card-assets/assets/cta.png` has been verified in `storage.objects` (PNG, 1,189,471 bytes).
- No M9 code has been deployed to production Edge Functions. No copyrighted news photos have been posted.

## Remaining

- Live-site trial on multiple publishers, responsive `srcset` photo handling, fallback domains for inaccessible image CDNs, stronger player/photo visual verification.
- Photo candidate persistence/review UI and permitted high-resolution image download/crop/background removal, then per-story PNG renderer and Supabase rendered image uploads.
- Wire renderer jobs and owner-authorized Telegram media-group delivery into the existing agent with dedupe/idempotency, test actual delivery and deploy after approval.
