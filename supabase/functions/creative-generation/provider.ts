import type { ClassifierConfig, GenerationConfig } from "./config.ts";
import { classifierPrompt, generationPrompt, repairPrompt } from "./prompts.ts";
import type {
  AiClassification,
} from "./classifier.ts";
import type { ContentMode, CreativeBriefOutput, GenerationIntent, MatchPhase } from "./types.ts";

export interface ProviderPromptInput {
  readonly content_mode: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly evidence_snapshot: unknown;
  readonly generation_intent?: GenerationIntent;
}

export interface ProviderRequestOptions {
  readonly maxRetries?: number;
}

export interface CreativeGenerationProvider {
  classify(text: string, config: ClassifierConfig, requestOptions?: ProviderRequestOptions): Promise<AiClassification>;
  generate(input: ProviderPromptInput): Promise<CreativeBriefOutput>;
  repair(input: ProviderPromptInput, output: CreativeBriefOutput, errors: readonly string[]): Promise<CreativeBriefOutput>;
  configure?(config: GenerationConfig): void;
  getUsageStats?(): ProviderUsageStats;
}

export interface ProviderUsageStats {
  readonly provider_calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly retry_count: number;
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

// Locally defined codes only: never forward upstream messages or arbitrary codes.
export type ProviderFailureCode = "HTTP_AUTH" | "HTTP_MODEL" | "HTTP_REQUEST" |
  "HTTP_RATE_LIMIT" | "HTTP_USAGE_LIMIT" | "HTTP_QUOTA" | "HTTP_SERVER" | "HTTP_OTHER" |
  "TIMEOUT" | "NETWORK" | "INVALID_RESPONSE_JSON" | "INVALID_OUTPUT_JSON" |
  "MISSING_OUTPUT" | "UNKNOWN";

function httpFailureCode(status?: number): ProviderFailureCode {
  if (status === 401 || status === 403) return "HTTP_AUTH";
  if (status === 404) return "HTTP_MODEL";
  if (status === 400 || status === 422) return "HTTP_REQUEST";
  if (status === 429) return "HTTP_USAGE_LIMIT";
  if (status !== undefined && status >= 500) return "HTTP_SERVER";
  return status === undefined ? "UNKNOWN" : "HTTP_OTHER";
}

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly status?: number;
  readonly code: ProviderFailureCode;

  constructor(category: ProviderErrorCategory, status?: number, code?: ProviderFailureCode) {
    super(category);
    this.name = "ProviderError";
    this.category = category;
    this.status = status;
    this.code = code ?? (category === "PROVIDER_TIMEOUT" ? "TIMEOUT" : httpFailureCode(status));
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
    style_profile: { type: "string", enum: ["manutd_editor"] },
    style_version: { type: "string", enum: ["manutd-editor-v1"] },
    content_mode: { type: "string", enum: ["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"] },
    match_phase: { type: ["string", "null"], enum: ["PRE_MATCH", "LIVE", "POST_MATCH", null] },
    generation_quality: { type: "string", enum: ["FULL", "PARTIAL"] },
    angle: { type: "string" },
    key_takeaway: { type: "string" },
    hooks: {
      type: "array",
      minItems: 3,
      maxItems: 3,
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
          index: { type: "integer" },
          purpose: { type: "string" },
          role: { type: "string", enum: ["HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION"] },
          headline: { type: "string" },
          highlight: { type: ["string", "null"] },
          body: { type: "string" },
          closing_line: { type: ["string", "null"] },
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
        required: ["slide_number", "index", "purpose", "role", "headline", "highlight", "body", "closing_line", "claims", "visual_direction"],
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
        properties: { evidence_id: { type: "string" }, label: { type: "string" }, url: { type: ["string", "null"] } },
        required: ["evidence_id", "label", "url"],
      },
    },
    editor_warning: { type: ["string", "null"] },
    internal_grounding: {
      type: "object",
      additionalProperties: false,
      properties: {
        evidence_ids: { type: "array", items: { type: "string" } },
        source_caveats: { type: "array", items: { type: "string" } },
        unsupported_claims: { type: "array", items: { type: "string" } },
      },
      required: ["evidence_ids", "source_caveats", "unsupported_claims"],
    },
  },
  required: ["schema_version", "style_profile", "style_version", "content_mode", "match_phase", "generation_quality", "angle", "key_takeaway", "hooks", "slides", "caption", "sources", "editor_warning", "internal_grounding"],
} as const;

function outputText(body: unknown, status: number): string {
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
  throw new ProviderError("MALFORMED_PROVIDER_RESPONSE", status, "MISSING_OUTPUT");
}

function parseOutput<T>(body: unknown, status: number): T {
  try {
    return JSON.parse(outputText(body, status)) as T;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("MALFORMED_PROVIDER_RESPONSE", status, "INVALID_OUTPUT_JSON");
  }
}

function tokenUsage(body: unknown): { input_tokens: number; output_tokens: number } {
  if (!body || typeof body !== "object") return { input_tokens: 0, output_tokens: 0 };
  const usage = (body as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return { input_tokens: 0, output_tokens: 0 };
  const value = usage as Record<string, unknown>;
  const input = value.input_tokens ?? value.prompt_tokens;
  const output = value.output_tokens ?? value.completion_tokens;
  return {
    input_tokens: typeof input === "number" && input >= 0 ? input : 0,
    output_tokens: typeof output === "number" && output >= 0 ? output : 0,
  };
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
  let model = options.model ?? "gpt-5.6-terra";
  let reasoning = options.reasoning ?? "medium";
  let maxOutputTokens = options.maxOutputTokens ?? 5000;
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1/responses";
  let providerCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let retryCount = 0;

  async function request<T>(body: Record<string, unknown>, requestOptions?: ProviderRequestOptions): Promise<T> {
    const requestedRetries = requestOptions?.maxRetries;
    const requestMaxRetries = typeof requestedRetries === "number" && Number.isFinite(requestedRetries)
      ? Math.max(0, Math.floor(requestedRetries))
      : maxRetries;
    for (let attempt = 0; attempt <= requestMaxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        providerCalls += 1;
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
          } catch (error) {
            // Aborted/failed body reads are transport errors, not malformed JSON.
            if (controller.signal.aborted || !(error instanceof SyntaxError)) throw error;
            throw new ProviderError("MALFORMED_PROVIDER_RESPONSE", response.status, "INVALID_RESPONSE_JSON");
          }
          const usage = tokenUsage(parsed);
          inputTokens += usage.input_tokens;
          outputTokens += usage.output_tokens;
          return parseOutput<T>(parsed, response.status);
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === requestMaxRetries) {
          let code = httpFailureCode(response.status);
          if (response.status === 429) {
            try {
              const failure = await response.json();
              if (failure?.error?.code === "insufficient_quota") code = "HTTP_QUOTA";
              if (failure?.error?.code === "rate_limit_exceeded") code = "HTTP_RATE_LIMIT";
            } catch (error) {
              if (controller.signal.aborted) throw error;
              // A non-JSON error body does not erase the known HTTP status.
            }
          }
          throw new ProviderError("FAILED_PROVIDER", response.status, code);
        }
        retryCount += 1;
        await sleep(retryAfterMilliseconds(response.headers) || Math.min(1000 * (2 ** attempt), 5000));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        if (attempt === requestMaxRetries) {
          const timedOut = controller.signal.aborted;
          throw new ProviderError(timedOut ? "PROVIDER_TIMEOUT" : "FAILED_PROVIDER", undefined,
            timedOut ? "TIMEOUT" : error instanceof TypeError ? "NETWORK" : "UNKNOWN");
        }
        retryCount += 1;
        await sleep(Math.min(1000 * (2 ** attempt), 5000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ProviderError("FAILED_PROVIDER");
  }

  return {
    getUsageStats(): ProviderUsageStats {
      return { provider_calls: providerCalls, input_tokens: inputTokens, output_tokens: outputTokens, retry_count: retryCount };
    },
    configure(config: GenerationConfig) {
      const configured = config.generation_config;
      if (typeof configured.model === "string" && configured.model.trim()) model = configured.model;
      if (typeof configured.reasoning === "string" && configured.reasoning.trim()) reasoning = configured.reasoning;
      if (typeof configured.max_output_tokens === "number") maxOutputTokens = configured.max_output_tokens;
    },
    async classify(text: string, config: ClassifierConfig, requestOptions?: ProviderRequestOptions): Promise<AiClassification> {
      return await request<AiClassification>(requestBody(config.model, config.reasoning, classifierPrompt(text), "content_classification", CLASSIFIER_SCHEMA, 500), requestOptions);
    },
    async generate(input: ProviderPromptInput): Promise<CreativeBriefOutput> {
      const requestOptions = input.generation_intent === "EXPLORATION" ? { maxRetries: 0 } : undefined;
      return await request<CreativeBriefOutput>(requestBody(model, reasoning, generationPrompt(input.content_mode, input.match_phase, input.evidence_snapshot, input.generation_intent), "creative_brief", CREATIVE_SCHEMA, maxOutputTokens), requestOptions);
    },
    async repair(input: ProviderPromptInput, output: CreativeBriefOutput, errors: readonly string[]): Promise<CreativeBriefOutput> {
      const requestOptions = input.generation_intent === "EXPLORATION" ? { maxRetries: 0 } : undefined;
      return await request<CreativeBriefOutput>(requestBody(model, reasoning, repairPrompt(input.content_mode, input.match_phase, input.evidence_snapshot, output, errors, input.generation_intent), "creative_brief_repair", CREATIVE_SCHEMA, maxOutputTokens), requestOptions);
    },
  };
}
