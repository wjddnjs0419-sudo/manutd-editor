# M9.1 — Actual news and recent official photos

Decision: Do NOT use Wikimedia as the default photo provider. Start from already resolved ORIGINAL publisher article URLs, then use a relevant official Manchester United news/article URL as a secondary source.

## Pipeline

1. Existing `trend-discovery/article_enrichment.ts` resolves Google News intermediate links to actual publisher URLs.
2. New `_shared/m9/article_photo_candidates.ts` extracts metadata for real article images: `NewsArticle.image` (JSON-LD), `og:image`, Twitter-card images, and `<figure><img>`.
3. Return image candidates with source article URL, image URL, image attribution if given in image metadata/caption, article publication time, and separate photo creation time if known.
4. Rank article images first and official club article images second. After this module, a future worker must check actual image bytes/dimensions, actual subject, event/date relevance, crop suitability and usage rights.
5. Send short-listed images for editorial selection, then pass the chosen asset to code-based cover/body/player profile renderers; reuse the already approved static CTA PNG.

## Provenance / legal distinction

- All outputs have `rights_status: UNVERIFIED` — extraction and attribution alone do not grant redistribution or derivative rights.
- An article dated today can still contain an archival photograph. Do not claim that `article_published_at` is photo capture date.
- Never automatically create image references if no candidates found; return empty.
- Avoid a photo from a different player, opponent, match, or old kit without clear contextual labeling.
- Preserve credits and originating URLs. Where use rights are not established, seek permission/license or escalate to human review. Noncommercial intent/credit can be part of fair-use analysis but are not automatic authorization.

## Status

- Candidate extraction implementation plus unit tests added to PR #7; Node 24 smoke tests of real parsing logic passed using representative HTML fixtures.
- No browsing providers were scraped in production; no external news photograph was downloaded or posted.
- Remaining M9.1: automatically find relevant club pages for article context, capture `srcset`/responsive full-size variants, verify network image headers, freshness/subject and rights, persist candidates and expose Telegram approval workflow.
- Still missing M9.2 renderer worker and M9.3 live Telegram dispatch.
