import type {
  AnalysisContract,
  ContentUnderstandingOutput,
  ContentUnderstandingStatus,
  MediaAssetType,
} from "./types.ts";

export type AnalysisRepositoryErrorCode =
  | "DATABASE_CONFIGURATION_ERROR"
  | "DATABASE_NETWORK_ERROR"
  | "DATABASE_HTTP_ERROR"
  | "DATABASE_INVALID_RESPONSE";

export class AnalysisRepositoryError extends Error {
  constructor(
    readonly code: AnalysisRepositoryErrorCode,
    readonly status: number | null,
  ) {
    super(status === null ? code : `${code} (${status})`);
    this.name = "AnalysisRepositoryError";
  }
}

export interface AnalysisCandidateAsset {
  readonly mediaAssetId: string;
  readonly assetType: MediaAssetType;
  readonly carouselIndex: number | null;
  readonly storagePath: string | null;
  readonly mimeType: string | null;
  readonly sha256: string | null;
}

export interface AnalysisCandidate {
  readonly rawPostId: string;
  readonly caption: string | null;
  readonly mediaType: string;
  readonly mediaProductType: string | null;
  readonly assets: readonly AnalysisCandidateAsset[];
  readonly existingFingerprints: readonly string[];
}

export interface AnalysisSaveInput {
  readonly rawPostId: string;
  readonly status: ContentUnderstandingStatus;
  readonly contract: AnalysisContract;
  readonly inputFingerprint: string;
  readonly output: ContentUnderstandingOutput;
  readonly errorCategory: string | null;
  readonly analyzedAt: string;
}

export interface AnalysisRepository {
  listCandidates(
    asOf: Date,
    limit: number,
    contract: AnalysisContract,
  ): Promise<readonly AnalysisCandidate[]>;
  save(input: AnalysisSaveInput): Promise<void>;
}

export interface AnalysisRepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey?: string;
  readonly secretKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MEDIA_TYPES = new Set<MediaAssetType>([
  "IMAGE",
  "CAROUSEL_CHILD",
  "THUMBNAIL",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDate(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AnalysisRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
  }
  return value.toISOString();
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new AnalysisRepositoryError("DATABASE_INVALID_RESPONSE", response.status);
  }
}

function decodeAsset(value: unknown, status: number): AnalysisCandidateAsset | null {
  if (!record(value) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) return null;
  if (!MEDIA_TYPES.has(value.asset_type as MediaAssetType)) return null;
  const carouselIndex = value.carousel_index === null || value.carousel_index === undefined
    ? null
    : Number.isSafeInteger(value.carousel_index) && (value.carousel_index as number) >= 0
    ? value.carousel_index as number
    : null;
  const storagePath = typeof value.storage_path === "string" && value.storage_path.trim() !== ""
    ? value.storage_path
    : null;
  const mimeType = typeof value.mime_type === "string" ? value.mime_type : null;
  const sha256 = typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
    ? value.sha256.toLowerCase()
    : null;
  if (value.carousel_index !== null && value.carousel_index !== undefined && carouselIndex === null) {
    throw new AnalysisRepositoryError("DATABASE_INVALID_RESPONSE", status);
  }
  return {
    mediaAssetId: value.id,
    assetType: value.asset_type as MediaAssetType,
    carouselIndex,
    storagePath,
    mimeType,
    sha256,
  };
}

function decodeCandidate(value: unknown, status: number): AnalysisCandidate {
  if (
    !record(value) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id) ||
    typeof value.media_type !== "string" || value.media_type.trim() === ""
  ) {
    throw new AnalysisRepositoryError("DATABASE_INVALID_RESPONSE", status);
  }
  const rawAssets = Array.isArray(value.media_assets) ? value.media_assets : [];
  const assets = rawAssets
    .map((asset) => decodeAsset(asset, status))
    .filter((asset): asset is AnalysisCandidateAsset => asset !== null)
    .sort((left, right) => (left.carouselIndex ?? -1) - (right.carouselIndex ?? -1) || left.mediaAssetId.localeCompare(right.mediaAssetId));
  return {
    rawPostId: value.id,
    caption: value.caption === null || value.caption === undefined ? null : typeof value.caption === "string" ? value.caption : null,
    mediaType: value.media_type,
    mediaProductType: value.media_product_type === null || value.media_product_type === undefined
      ? null
      : typeof value.media_product_type === "string" ? value.media_product_type : null,
    assets,
    existingFingerprints: [],
  };
}

function row(input: AnalysisSaveInput): Record<string, unknown> {
  return {
    raw_post_id: input.rawPostId,
    status: input.status,
    analysis_version: input.contract.analysisVersion,
    model: input.contract.model,
    prompt_version: input.contract.promptVersion,
    input_fingerprint: input.inputFingerprint,
    caption_summary: input.output.captionSummary,
    visual_summary: input.output.visualSummary,
    combined_summary: input.output.combinedSummary,
    entities: input.output.entities,
    topics: input.output.topics,
    on_image_text: input.output.onImageText,
    important_numbers: input.output.importantNumbers,
    source_names: input.output.sourceNames,
    claims: input.output.claims,
    content_type: input.output.contentType,
    visual_format: input.output.visualFormat,
    analysis_confidence: input.output.analysisConfidence,
    evidence_state: input.output.evidenceState,
    error_category: input.errorCategory,
    analyzed_at: input.analyzedAt,
  };
}

export function createAnalysisRepository(options: AnalysisRepositoryOptions): AnalysisRepository {
  const serviceRoleKey = options.serviceRoleKey ?? options.secretKey;
  if (options.supabaseUrl.trim() === "" || !serviceRoleKey || serviceRoleKey.trim() === "") {
    throw new AnalysisRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
  }
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const headers = {
    apikey: serviceRoleKey,
  };

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });
    } catch {
      throw new AnalysisRepositoryError("DATABASE_NETWORK_ERROR", null);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AnalysisRepositoryError("DATABASE_HTTP_ERROR", response.status);
    }
    return response;
  }

  return {
    async listCandidates(asOf, limit, contract): Promise<readonly AnalysisCandidate[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AnalysisRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
      }
      const asOfIso = parseDate(asOf);
      const windowStart = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const query = new URLSearchParams({
        select: "id,caption,media_type,media_product_type,media_assets(id,asset_type,carousel_index,storage_path,mime_type,sha256)",
        created_at: `gte.${windowStart}`,
        order: "created_at.desc,id.asc",
        limit: String(limit),
      });
      query.append("created_at", `lte.${asOfIso}`);
      const rawResponse = await request(`/rest/v1/raw_posts?${query.toString()}`, { method: "GET" });
      const raw = await parseJson(rawResponse);
      if (!Array.isArray(raw)) throw new AnalysisRepositoryError("DATABASE_INVALID_RESPONSE", rawResponse.status);
      const candidates = raw.map((value) => decodeCandidate(value, rawResponse.status));
      if (candidates.length === 0) return candidates;

      const ids = candidates.map((candidate) => candidate.rawPostId).join(",");
      const existingQuery = new URLSearchParams({
        select: "raw_post_id,input_fingerprint",
        analysis_version: `eq.${contract.analysisVersion}`,
        raw_post_id: `in.(${ids})`,
      });
      const existingResponse = await request(`/rest/v1/content_understandings?${existingQuery.toString()}`, {
        method: "GET",
        headers: {
          "accept-profile": "app_private",
          "content-profile": "app_private",
        },
      });
      const existing = await parseJson(existingResponse);
      if (!Array.isArray(existing)) throw new AnalysisRepositoryError("DATABASE_INVALID_RESPONSE", existingResponse.status);
      const fingerprints = new Map<string, string[]>();
      for (const value of existing) {
        if (!record(value) || typeof value.raw_post_id !== "string" || typeof value.input_fingerprint !== "string") continue;
        const list = fingerprints.get(value.raw_post_id) ?? [];
        list.push(value.input_fingerprint);
        fingerprints.set(value.raw_post_id, list);
      }
      return candidates.map((candidate) => ({
        ...candidate,
        existingFingerprints: fingerprints.get(candidate.rawPostId) ?? [],
      }));
    },

    async save(input): Promise<void> {
      if (
        !UUID_PATTERN.test(input.rawPostId) || input.contract.analysisVersion.trim() === "" ||
        input.contract.model.trim() === "" || input.contract.promptVersion.trim() === "" ||
        input.inputFingerprint.trim() === "" || input.analyzedAt.trim() === ""
      ) {
        throw new AnalysisRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
      }
      await request(
        "/rest/v1/content_understandings?on_conflict=raw_post_id%2Canalysis_version%2Cinput_fingerprint",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-profile": "app_private",
            "accept-profile": "app_private",
            prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify(row(input)),
        },
      );
    },
  };
}
