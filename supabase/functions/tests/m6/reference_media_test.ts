import { assertEquals } from "jsr:@std/assert@1.0.8";
import {
  createReferenceSignedUrl,
  selectRepresentativeReference,
  type CandidateReferencePost,
} from "../../_shared/m6/reference_media.ts";

const post = (overrides: Partial<CandidateReferencePost> = {}): CandidateReferencePost => ({
  raw_post_id: "post-a",
  username: "utdreport",
  permalink: "https://www.instagram.com/p/a/",
  published_at: "2026-09-19T10:00:00Z",
  media_type: "IMAGE",
  media_product_type: null,
  match_confidence: 0.8,
  cited_source_reliability: 7,
  media_assets: [],
  ...overrides,
});

Deno.test("selects the same representative from shuffled inputs using exact tie-breaks", () => {
  const posts = [
    post({ raw_post_id: "post-z", match_confidence: 0.8, cited_source_reliability: 9, published_at: "2026-09-20T10:00:00Z" }),
    post({ raw_post_id: "post-a", match_confidence: 0.8, cited_source_reliability: 9, published_at: "2026-09-20T10:00:00Z" }),
    post({ raw_post_id: "post-b", match_confidence: 0.9, cited_source_reliability: 1 }),
  ];
  assertEquals(selectRepresentativeReference(posts)?.raw_post_id, "post-b");
  assertEquals(selectRepresentativeReference([posts[1], posts[0]])?.raw_post_id, "post-a");
});

Deno.test("cached media wins and chooses Reel thumbnail or first carousel child", () => {
  const reel = post({ media_type: "VIDEO", media_product_type: "REELS", media_assets: [
    { id: "video", asset_type: "VIDEO", carousel_index: null, storage_path: "video" },
    { id: "thumb", asset_type: "THUMBNAIL", carousel_index: null, storage_path: "thumb" },
  ] });
  const carousel = post({ raw_post_id: "carousel", media_type: "CAROUSEL_ALBUM", media_assets: [
    { id: "child-2", asset_type: "CAROUSEL_CHILD", carousel_index: 2, storage_path: "child-2" },
    { id: "child-1", asset_type: "CAROUSEL_CHILD", carousel_index: 1, storage_path: "child-1" },
  ] });
  const reference = selectRepresentativeReference([post(), reel, carousel]);
  assertEquals(reference?.raw_post_id, "carousel");
  assertEquals(reference?.media_asset_id, "child-1");
  assertEquals(selectRepresentativeReference([reel])?.media_asset_id, "thumb");
});

Deno.test("keeps permalink when no cached asset exists", () => {
  const reference = selectRepresentativeReference([post({ media_assets: [{ id: "missing", asset_type: "IMAGE", carousel_index: null, storage_path: null }] })]);
  assertEquals(reference?.media_asset_id, null);
  assertEquals(reference?.permalink, "https://www.instagram.com/p/a/");
});

Deno.test("creates a short-lived signed URL and degrades safely on storage failure", async () => {
  const storage = { from: (bucket: string) => ({ createSignedUrl: async (path: string, expires: number) => ({ data: { signedUrl: `${bucket}/${path}/${expires}` }, error: null }) }) };
  assertEquals(await createReferenceSignedUrl({ id: "asset", storage_path: "path" }, storage), "instagram-analysis/path/600");
  const failing = { from: () => ({ createSignedUrl: async () => ({ data: null, error: new Error("private") }) }) };
  assertEquals(await createReferenceSignedUrl({ id: "asset", storage_path: "path" }, failing), null);
});
