export interface CachedReferenceAsset {
  id: string;
  asset_type: "IMAGE" | "CAROUSEL_CHILD" | "VIDEO" | "THUMBNAIL";
  carousel_index: number | null;
  storage_path: string | null;
}

export interface CandidateReferencePost {
  raw_post_id: string;
  username: string;
  permalink: string | null;
  published_at: string;
  media_type: string;
  media_product_type: string | null;
  match_confidence: number | null;
  cited_source_reliability: number | null;
  media_assets: readonly CachedReferenceAsset[];
}

export interface RepresentativeReference {
  raw_post_id: string;
  username: string;
  permalink: string | null;
  media_asset_id: string | null;
  media_storage_path?: string | null;
}

function usable(asset: CachedReferenceAsset | undefined): CachedReferenceAsset | null {
  return asset?.storage_path ? asset : null;
}

function selectedAsset(post: CandidateReferencePost): CachedReferenceAsset | null {
  const assets = post.media_assets;
  if (post.media_type === "CAROUSEL_ALBUM") {
    return assets
      .filter((asset) => asset.asset_type === "CAROUSEL_CHILD" && asset.storage_path)
      .sort((left, right) => (left.carousel_index ?? Number.MAX_SAFE_INTEGER) - (right.carousel_index ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id))[0] ?? null;
  }
  if (post.media_type === "VIDEO" || post.media_product_type === "REELS" || post.media_type === "REELS") {
    return usable(assets.find((asset) => asset.asset_type === "THUMBNAIL")) ??
      usable(assets.find((asset) => asset.asset_type === "IMAGE")) ??
      usable(assets.find((asset) => asset.asset_type === "VIDEO"));
  }
  if (post.media_type === "IMAGE") return usable(assets.find((asset) => asset.asset_type === "IMAGE"));
  return null;
}

function comparePosts(left: CandidateReferencePost, right: CandidateReferencePost): number {
  const leftAsset = selectedAsset(left);
  const rightAsset = selectedAsset(right);
  const media = Number(Boolean(rightAsset)) - Number(Boolean(leftAsset));
  if (media !== 0) return media;
  const confidence = (right.match_confidence ?? -Infinity) - (left.match_confidence ?? -Infinity);
  if (confidence !== 0) return confidence;
  const reliability = (right.cited_source_reliability ?? -Infinity) - (left.cited_source_reliability ?? -Infinity);
  if (reliability !== 0) return reliability;
  const published = Date.parse(right.published_at) - Date.parse(left.published_at);
  if (published !== 0) return published;
  return left.raw_post_id.localeCompare(right.raw_post_id);
}

export function selectRepresentativeReference(
  posts: readonly CandidateReferencePost[],
): RepresentativeReference | null {
  const selected = [...posts].sort(comparePosts)[0];
  if (!selected) return null;
  const asset = selectedAsset(selected);
  return {
    raw_post_id: selected.raw_post_id,
    username: selected.username,
    permalink: selected.permalink,
    media_asset_id: asset?.id ?? null,
    media_storage_path: asset?.storage_path ?? null,
  };
}

export interface StorageLike {
  from(bucket: string): {
    createSignedUrl(path: string, expiresIn: number): Promise<{ data: { signedUrl?: string } | null; error: unknown }>
  };
}

export async function createReferenceSignedUrl(
  asset: { id: string; storage_path: string | null },
  storage: StorageLike,
  expiresInSeconds = 600,
): Promise<string | null> {
  if (!asset.storage_path) return null;
  try {
    const { data, error } = await storage.from("instagram-analysis").createSignedUrl(asset.storage_path, expiresInSeconds);
    return error || !data?.signedUrl ? null : data.signedUrl;
  } catch {
    return null;
  }
}
