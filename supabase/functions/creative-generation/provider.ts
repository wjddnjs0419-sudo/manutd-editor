import type { ClassifierConfig } from "./config.ts";
import { classifierPrompt, generationPrompt, repairPrompt } from "./prompts.ts";
import type {
  AiClassification,
} from "./classifier.ts";
import type {
  ContentMode,
  CreativeBriefOutput,
  JsonValue,
  MatchPhase,
} from "./types.ts";

export interface ProviderPromptInput {
  readonly content_mode: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly evidence_snapshot: JsonValue;
}

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly maxOutputTokens?: number;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type ProviderErrorCategory = "FAILED_PROVIDER" | "PROVIDER_TIMEOUT" | "MALFORMED_PROVIDER_RESPONSE";

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly status?: number;

  constructor(category: ProviderErrorCategory, status?: number) {
    super(category);
    this.name = "ProviderError";
    this.category = category;
    this.status = status;
  }
}

const CLASSIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    content_mode: { type: "string", enum: ["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"] },
    match_phase: { type: ["string", "null"], enum: ["PRE_MATCH", "LIVE", "POST_MATCH", null] },
    confidence: { type: "number" },
    reason_code: { type: "string" },
  },
  required: ["content_mode", "match_phase", "confidence", "reason_code"],
} as const;

const CREATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", enum: ["1.0"] },
    content_mode: { type: "string", enum: ["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"] },
    match_phase: { type: ["string", "null"], enum: ["PRE_MATCH", "LIVE", "POST_MATCH", null] },
    generation_quality: { type: "string", enum: ["FULL", "PARTIAL"] },
    angle: { type: "string" },
    key_takeaway: { type: "string" },
    hooks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
      },
    },
    slides: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          slide_number: { type: "integer" },
          purpose: { type: "string" },
          headline: { type: "string" },
          body: { type: "string" },
          claims: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                claim_id: { type: "string" },
                type: { type: "string", enum: ["FACT", "INFERENCE"] },
                text: { type: "string" },
                evidence_ids: { type: "array", items: { type: "string" } },
              },
              required: ["claim_id", "type", "text", "evidence_ids"],
            },
          },
          visual_direction: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject: { type: "string" },
              image_type: { type: "string" },
              layout_intent: { type: "string" },
              stat_emphasis: { type: ["string", "null"] },
              text_hierarchy: { type: "array", items: { type: "string" } },
            },
            required: ["subject", "image_type", "layout_intent", "stat_emphasis", "text_hierarchy"],
          },
        },
        required: ["slide_number", "purpose", "headline", "body", "claims", "visual_direction"],
      },
    },
    caption: {
      type: "object",
      additionalProperties: false,
      properties: { body: { type: "string" }, cta: { type: "string" } },
      required: ["body", "cta"],
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { evidence_id: { type: "string" }, label: { type: "string" } },
        required: ["evidence_id", "label"],
      },
    },
  },
  required: ["schema_version", "content_mode", "match_phase", "generation_quality", "angle", "key_takeaway", "hooks", "slides", "caption", "sources"],
} as const;

function outputText(body: unknown): string {
  if (body && typeof body === "object") {
    const object = body as Record<string, unknown>;
    if (typeof object.output_text === "string") return object.output_text;
    if (Array.isArray(object.output)) {
      for (const item of object.output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (!part || typeof part !== "object") continue;
          const candidate = part as Record<string, unknown>;
          if (typeof candidate.text === "string") return candidate.text;
        }
      }
    }
  }
  throw new ProviderError("MALFORMED_PROVIDER_RESPONSE");
}

function parseOutput<T>(body: unknown): T {
  try {
    return JSON.parse(outputText(body)) as T;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_PROVIDER_RESPONSE");
  }
}

function retryAfterMilliseconds(headers: Headers): number {
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds * 1000, 30_000)) : 0;
}

function requestBody(
  model: string,
  reasoning: string,
  prompt: string,
  name: string,
  schema: unknown,
  maxOutputTokens: number,
): Record<string, unknown> {
  return {
    model,
    store: false,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    reasoning: { effort: reasoning },
    max_output_tokens: maxOutputTokens,
    text: { format: { type: "json_schema", name, strict: true, schema } },
  };
}

export function createOpenAIProvider(options: OpenAIProviderOptions) {
  if (!options.apiKey) throw new Error("OPENAI_API_KEY is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const model = options.model ?? "gpt-5.6-terra";
  const reasoning = options.reasoning ?? "medium";
  const maxOutputTokens = options.maxOutputTokens ?? 5000;
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";

  async function request<T>(body: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(baseUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          let parsed: unknown;
          try {
            parsed = await response.json();
          } catch {
            throw new ProviderError("MALFORMED_PROVIDER_RESPONSE", response.status);
          }
          return parseOutput<T>(parsed);
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === maxRetries) throw new ProviderError("FAILED_PROVIDER", response.status);
        await sleep(retryAfterMilliseconds(response.headers) || Math.min(1000 * (2 ** attempt), 5000));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (attempt === maxRetries) throw new ProviderError(error instanceof DOMException && error.name === "AbortError" ? "PROVIDER_TIMEOUT" : "FAILED_PROVIDER");
        await sleep(Math.min(1000 * (2 ** attempt), 5000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ProviderError("FAILED_PROVIDER");
  }

  return {
    async classify(text: string, config: ClassifierConfig): Promise<AiClassification> {
      return await request<AiClassification>(requestBody(config.model, config.reasoning, classifierPrompt(text), "content_classification", CLASSIFIER_SCHEMA, 500));
    },
    async generate(input: ProviderPromptInput): Promise<CreativeBriefOutput> {
      return await request<CreativeBriefOutput>(requestBody(model, reasoning, generationPrompt(input.content_mode, input.match_phase, input.evidence_snapshot), "creative_brief", CREATIVE_SCHEMA, maxOutputTokens));
    },
    async repair(input: ProviderPromptInput, output: CreativeBriefOutput, errors: readonly string[]): Promise<CreativeBriefOutput> {
      return await request<CreativeBriefOutput>(requestBody(model, reasoning, repairPrompt(input.content_mode, input.match_phase, input.evidence_snapshot, output, errors), "creative_brief_repair", CREATIVE_SCHEMA, maxOutputTokens));
    },
  };
}
