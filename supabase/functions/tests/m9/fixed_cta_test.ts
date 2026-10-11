import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { appendFixedCta, M9_CTA_OBJECT_PATH } from "../../_shared/m9/fixed_cta.ts";

const cover = {
  slide_number: 1,
  kind: "COVER_NEWS" as const,
  storage_bucket: "rendered",
  storage_path: "jobs/job1/cover.png",
  mime_type: "image/png" as const,
};

Deno.test("appends one fixed CTA after the rendered slides", () => {
  const slides = appendFixedCta([cover], "card-assets");
  assertEquals(slides.map((s) => s.kind), ["COVER_NEWS", "CTA"]);
  assertEquals(slides[1]?.slide_number, 2);
  assertEquals(slides[1]?.storage_bucket, "card-assets");
  assertEquals(slides[1]?.storage_path, M9_CTA_OBJECT_PATH);
  assertEquals(cover.storage_path, "jobs/job1/cover.png");
});

Deno.test("re-appending CTA is idempotent", () => {
  const slides = appendFixedCta([cover], "card-assets");
  assertEquals(appendFixedCta(slides, "card-assets"), slides);
});

Deno.test("rejects misplaced or wrong CTA assets", () => {
  const cta = appendFixedCta([cover], "card-assets")[1]!;
  assertThrows(() => appendFixedCta([cta, { ...cover, slide_number: 2 }], "card-assets"), Error, "M9_CTA_MUST_BE_LAST");
  assertThrows(() => appendFixedCta([cover, { ...cta, storage_path: "assets/old.png" }], "card-assets"), Error, "M9_CTA_ASSET_MISMATCH");
});

Deno.test("rejects empty and non-sequential rendered slide decks", () => {
  assertThrows(() => appendFixedCta([]), Error, "M9_SLIDES_EMPTY");
  assertThrows(() => appendFixedCta([{ ...cover, slide_number: 2 }]), Error, "M9_SLIDE_NUMBERS_NOT_SEQUENTIAL");
});

Deno.test("protects the Telegram 10-photo limit", () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ ...cover, slide_number: i + 1, kind: i === 0 ? "COVER_NEWS" as const : "BODY_NEWS" as const }));
  assertThrows(() => appendFixedCta(ten), Error, "M9_TELEGRAM_ALBUM_TOO_LARGE");
  const nine = ten.slice(0, 9);
  assertEquals(appendFixedCta(nine).length, 10);
});
