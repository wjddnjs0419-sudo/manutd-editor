/**
 * M9: fixed CTA image contract for a future PNG carousel renderer.
 *
 * This module only appends a storage reference to an already rendered deck.
 * It intentionally never recreates the Figma CTA on each news story.
 */
export const M9_CTA_OBJECT_PATH = "assets/cta.png" as const;
export const M9_CTA_DEFAULT_BUCKET = "manutd-card-assets" as const;
export const M9_TELEGRAM_ALBUM_MAX = 10 as const;

export type M9SlideKind = "COVER_NEWS" | "BODY_NEWS" | "PLAYER_PROFILE" | "CTA";
export interface M9RenderedSlide {
  readonly slide_number: number;
  readonly kind: M9SlideKind;
  readonly storage_bucket: string;
  readonly storage_path: string;
  readonly mime_type: "image/png";
}

function validateSequential(slides: readonly M9RenderedSlide[]): void {
  if (slides.length === 0) throw new Error("M9_SLIDES_EMPTY");
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!;
    if (slide.slide_number !== i + 1) throw new Error("M9_SLIDE_NUMBERS_NOT_SEQUENTIAL");
    if (!slide.storage_bucket.trim() || !slide.storage_path.trim() || slide.mime_type !== "image/png") {
      throw new Error("M9_SLIDE_ASSET_INVALID");
    }
    if (slide.kind === "CTA" && i !== slides.length - 1) throw new Error("M9_CTA_MUST_BE_LAST");
  }
}

export function appendFixedCta(
  slides: readonly M9RenderedSlide[],
  storageBucket: string = M9_CTA_DEFAULT_BUCKET,
): M9RenderedSlide[] {
  validateSequential(slides);
  const bucket = storageBucket.trim();
  if (!bucket) throw new Error("M9_CTA_BUCKET_REQUIRED");
  if (slides.length > M9_TELEGRAM_ALBUM_MAX) throw new Error("M9_TELEGRAM_ALBUM_TOO_LARGE");

  const last = slides[slides.length - 1]!;
  if (last.kind === "CTA") {
    if (last.storage_bucket !== bucket || last.storage_path !== M9_CTA_OBJECT_PATH) {
      throw new Error("M9_CTA_ASSET_MISMATCH");
    }
    return [...slides]; // idempotent; do not append a second CTA
  }
  if (slides.length >= M9_TELEGRAM_ALBUM_MAX) throw new Error("M9_TELEGRAM_ALBUM_TOO_LARGE");

  return [...slides, {
    slide_number: slides.length + 1,
    kind: "CTA",
    storage_bucket: bucket,
    storage_path: M9_CTA_OBJECT_PATH,
    mime_type: "image/png",
  }];
}
