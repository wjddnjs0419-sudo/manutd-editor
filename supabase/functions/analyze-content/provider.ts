import type { ContentUnderstandingConfig } from "./config.ts";
import { contentUnderstandingPrompt } from "./prompts.ts";
import { validateAnalysisOutput } from "./validation.ts";
import type {
  AnalysisMediaInput,
  ContentUnderstandingOutput,
  VisualFormat,
} from "./types.ts";

export interface ContentUnderstandingInput {
  readonly caption: string | null;
  readonly visualFormat: VisualFormat;
  readonly media: readonly AnalysisMediaInput[];
}

export interface ContentUnderstandingProvider {
  analyze(input: ContentUnderstandingInput): Promise<ContentUnderstandingOutput>;
}

export interface ContentUnderstandingProviderOptions {
  readonly apiKey: string;
  readonly config: ContentUnderstandingConfig;
  readonly maxRetries?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type ProviderErrorCategory =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UPSTREAM_5XX"
  | "PROVIDER_UPSTREAM"
  | "MALFORMED_PROVIDER_RESPONSE";

export class ProviderError extends Error {
  constructor(
    readonly category: ProviderErrorCategory,
    readonly statusClass: string | null = null,
  ) {
    super(category);
    this.name = "ProviderError";
  }
}

const EVIDENCE_STATE_SCHEMA = {
  type: "string",
  enum: ["OBSERVED", "INFERRED", "UNAVAILABLE"],
} as const;

const CONTENT_UNDERSTANDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    captionSummary: { type: ["string", "null"], maxLength: 4000 },
    visualSummary: { type: ["string", "null"], maxLength: 4000 },
    combinedSummary: { type: ["string", "null"], maxLength: 4000 },
    entities: { type: "array", maxItems: 64, items: { type: "string", maxLength: 160 } },
    topics: { type: "array", maxItems: 64, items: { type: "string", maxLength: 160 } },
    onImageText: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", maxLength: 4000 },
          slideIndex: { type: ["integer", "null"] },
          confidence: { type: ["number", "null"] },
        },
        required: ["text", "slideIndex", "confidence"],
      },
    },
    importantNumbers: { type: "array", maxItems: 64, items: { type: "string", maxLength: 160 } },
    sourceNames: { type: "array", maxItems: 64, items: { type: "string", maxLength: 160 } },
    claims: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string", maxLength: 160 },
          predicate: { type: "string", maxLength: 160 },
          object: { type: "string", maxLength: 160 },
          text: { type: "string", maxLength: 4000 },
          origin: { type: "string", enum: ["caption", "image", "carousel_slide", "thumbnail"] },
          confidence: { type: "number" },
          evidence: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                slideIndex: { type: ["integer", "null"] },
                mediaAssetId: { type: ["string", "null"], maxLength: 160 },
              },
              required: ["slideIndex", "mediaAssetId"],
            },
          },
        },
        required: ["subject", "predicate", "object", "text", "origin", "confidence", "evidence"],
      },
    },
    contentType: { type: ["string", "null"], maxLength: 160 },
    visualFormat: { type: "string", enum: ["IMAGE", "CAROUSEL", "THUMBNAIL_ONLY", "NO_MEDIA"] },
    analysisConfidence: { type: ["number", "null"] },
    evidenceState: {
      type: "object",
      additionalProperties: false,
      properties: {
        captionSummary: EVIDENCE_STATE_SCHEMA,
        visualSummary: EVIDENCE_STATE_SCHEMA,
        combinedSummary: EVIDENCE_STATE_SCHEMA,
        entities: EVIDENCE_STATE_SCHEMA,
        topics: EVIDENCE_STATE_SCHEMA,
        onImageText: EVIDENCE_STATE_SCHEMA,
        claims: EVIDENCE_STATE_SCHEMA,
      },
      required: ["captionSummary", "visualSummary", "combinedSummary", "entities", "topics", "onImageText", "claims"],
    },
  },
  required: ["captionSummary", "visualSummary", "combinedSummary", "entities", "topics", "onImageText", "importantNumbers", "sourceNames", "claims", "contentType", "visualFormat", "analysisConfidence", "evidenceState"],
} as const;

function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

function retryAfterMilliseconds(headers: Headers): number {
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds * 1000, 30_000)) : 0;
}

function outputText(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.output_text === "string") return record.output_text;
    if (Array.isArray(record.output)) {
      for (const item of record.output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
            return (part as Record<string, string>).text;
          }
        }
      }
    }
  }
  throw new ProviderError("MALFORMED_PROVIDER_RESPONSE");
}

function slideCount(input: ContentUnderstandingInput): number {
  if (input.visualFormat === "NO_MEDIA") return 0;
  if (input.visualFormat === "CAROUSEL") {
    return Math.max(0, ...input.media.map((media) => (media.carouselIndex ?? -1) + 1));
  }
  return input.media.length > 0 ? 1 : 0;
}

function requestBody(input: ContentUnderstandingInput, config: ContentUnderstandingConfig): Record<string, unknown> {
  return {
    model: config.model,
    store: false,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: contentUnderstandingPrompt(input, config.promptVersion) },
        ...input.media.map((media) => ({ type: "input_image", image_url: media.dataUrl, detail: "high" })),
      ],
    }],
    max_output_tokens: 5_000,
    text: {
      format: {
        type: "json_schema",
        name: "content_understanding",
        strict: true,
        schema: CONTENT_UNDERSTANDING_SCHEMA,
      },
    },
  };
}

export function createContentUnderstandingProvider(
  options: ContentUnderstandingProviderOptions,
): ContentUnderstandingProvider {
  if (options.apiKey.trim() === "") throw new Error("OPENAI_API_KEY is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";

  async function request(body: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.config.timeoutMs);
      try {
        const response = await fetchImpl(baseUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          try {
            return await response.json();
          } catch {
            throw new ProviderError("MALFORMED_PROVIDER_RESPONSE", statusClass(response.status));
          }
        }
        const responseClass = statusClass(response.status);
        if (response.status === 429) {
          if (attempt === maxRetries) throw new ProviderError("PROVIDER_RATE_LIMITED", responseClass);
          await sleep(retryAfterMilliseconds(response.headers) || Math.min(1_000 * (2 ** attempt), 5_000));
          continue;
        }
        if (response.status >= 500) {
          if (attempt === maxRetries) throw new ProviderError("PROVIDER_UPSTREAM_5XX", responseClass);
          await sleep(Math.min(1_000 * (2 ** attempt), 5_000));
          continue;
        }
        throw new ProviderError("PROVIDER_UPSTREAM", responseClass);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (attempt === maxRetries) {
          throw new ProviderError(controller.signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UPSTREAM");
        }
        await sleep(Math.min(1_000 * (2 ** attempt), 5_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ProviderError("PROVIDER_UPSTREAM");
  }

  return {
    async analyze(input): Promise<ContentUnderstandingOutput> {
      if (input.media.length > options.config.maxSlides) {
        throw new ProviderError("MALFORMED_PROVIDER_RESPONSE");
      }
      const body = await request(requestBody(input, options.config));
      try {
        const parsed = JSON.parse(outputText(body)) as unknown;
        return validateAnalysisOutput(parsed, {
          visualFormat: input.visualFormat,
          slideCount: slideCount(input),
        });
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("MALFORMED_PROVIDER_RESPONSE");
      }
    },
  };
}
