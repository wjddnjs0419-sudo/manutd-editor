import type { StoryClusterEvaluation } from "./ai_classifier.ts";
import { businessDate } from "../_shared/m6/business_date.ts";

export type EvaluationRepositoryErrorCode =
  | "DATABASE_CONFIGURATION_ERROR"
  | "DATABASE_NETWORK_ERROR"
  | "DATABASE_HTTP_ERROR";

export class EvaluationRepositoryError extends Error {
  constructor(
    readonly code: EvaluationRepositoryErrorCode,
    readonly status: number | null,
  ) {
    super(status === null ? code : `${code} (${status})`);
    this.name = "EvaluationRepositoryError";
  }
}

export interface EvaluationRepositoryDeps {
  readonly supabaseUrl: string;
  readonly serviceRoleKey?: string;
  readonly secretKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface EvaluationRepository {
  saveEvaluation(evaluation: StoryClusterEvaluation): Promise<void>;
}

const DECISIONS = new Set([
  "SAME_STORY",
  "DIFFERENT_STORY",
  "MANUAL_REVIEW",
  "ERROR",
]);
const MAX_REASON_LENGTH = 1_000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEvaluation(value: StoryClusterEvaluation): boolean {
  return object(value) &&
    typeof value.rawPostId === "string" && value.rawPostId.trim() !== "" &&
    typeof value.candidateClusterId === "string" &&
    value.candidateClusterId.trim() !== "" &&
    (value.deterministicScore === null ||
      typeof value.deterministicScore === "number" &&
        Number.isFinite(value.deterministicScore)) &&
    DECISIONS.has(value.decision) &&
    (value.sameStory === null || typeof value.sameStory === "boolean") &&
    (value.confidence === null ||
      typeof value.confidence === "number" &&
        Number.isFinite(value.confidence) &&
        value.confidence >= 0 && value.confidence <= 1) &&
    (value.reason === null ||
      typeof value.reason === "string" &&
        value.reason.length <= MAX_REASON_LENGTH) &&
    typeof value.model === "string" && value.model.trim() !== "" &&
    typeof value.promptVersion === "string" &&
    value.promptVersion.trim() !== "" &&
    typeof value.dictionaryVersion === "string" &&
    value.dictionaryVersion.trim() !== "" &&
    typeof value.classifierVersion === "string" &&
    value.classifierVersion.trim() !== "" &&
    typeof value.inputHash === "string" && value.inputHash.trim() !== "" &&
    object(value.inputSnapshot) &&
    (value.result === null || object(value.result));
}

function row(evaluation: StoryClusterEvaluation): Record<string, unknown> {
  return {
    raw_post_id: evaluation.rawPostId,
    candidate_cluster_id: evaluation.candidateClusterId,
    deterministic_score: evaluation.deterministicScore,
    decision: evaluation.decision,
    same_story: evaluation.sameStory,
    confidence: evaluation.confidence,
    reason: evaluation.reason,
    model: evaluation.model,
    prompt_version: evaluation.promptVersion,
    dictionary_version: evaluation.dictionaryVersion,
    classifier_version: evaluation.classifierVersion,
    input_hash: evaluation.inputHash,
    input_snapshot: evaluation.inputSnapshot,
    result: evaluation.result,
    ...(evaluation.evaluatedAt ? { evaluated_at: evaluation.evaluatedAt } : {}),
  };
}

export function createEvaluationRepository(
  deps: EvaluationRepositoryDeps,
): EvaluationRepository {
  const serviceRoleKey = deps.serviceRoleKey ?? deps.secretKey;
  if (
    deps.supabaseUrl.trim() === "" || !serviceRoleKey ||
    serviceRoleKey.trim() === ""
  ) {
    throw new EvaluationRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
  }

  const baseUrl = deps.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const savedKeys = new Set<string>();

  async function saveEvaluation(
    evaluation: StoryClusterEvaluation,
  ): Promise<void> {
    if (!validEvaluation(evaluation)) {
      throw new EvaluationRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
    }

    const key = [
      evaluation.rawPostId,
      evaluation.candidateClusterId,
      evaluation.classifierVersion,
      evaluation.inputHash,
    ].join("\u0000");
    if (savedKeys.has(key)) return;
    savedKeys.add(key);

    try {
      const response = await fetchImpl(
        `${baseUrl}/rest/v1/story_cluster_evaluations?on_conflict=raw_post_id%2Ccandidate_cluster_id%2Cclassifier_version%2Cinput_hash`,
        {
          method: "POST",
          headers: {
            apikey: serviceRoleKey as string,
            "content-type": "application/json",
            "accept-profile": "app_private",
            "content-profile": "app_private",
            prefer: "resolution=ignore-duplicates,return=minimal",
          },
          body: JSON.stringify(row(evaluation)),
        },
      );
      if (!response.ok) {
        throw new EvaluationRepositoryError(
          "DATABASE_HTTP_ERROR",
          response.status,
        );
      }
    } catch (error) {
      savedKeys.delete(key);
      if (error instanceof EvaluationRepositoryError) throw error;
      throw new EvaluationRepositoryError("DATABASE_NETWORK_ERROR", null);
    }
  }

  return { saveEvaluation };
}

export async function saveEvaluation(
  evaluation: StoryClusterEvaluation,
  deps: EvaluationRepositoryDeps,
): Promise<void> {
  await createEvaluationRepository(deps).saveEvaluation(evaluation);
}

export type IntelligenceRegion = "GLOBAL" | "KR";

export interface EligibleAccount {
  readonly id: string;
  readonly username: string;
  readonly region: IntelligenceRegion;
  readonly active: true;
  readonly apiSupported: true;
  readonly priorityWeight: number;
  readonly lastProbeAt: string | null;
  readonly probeError: string | null;
}

export interface EligibleAccountSnapshot {
  readonly runAt: string;
  readonly eligible: readonly EligibleAccount[];
  readonly pendingCapabilityAccountIds: readonly string[];
  readonly unsupportedAccountIds: readonly string[];
  readonly freshSuccessfulAccountIds: readonly string[];
}

export interface RecentRawPost {
  readonly id: string;
  readonly sourceAccountId: string;
  readonly caption: string;
  readonly mediaType: string;
  readonly publishedAt: string;
  readonly collectedAt: string;
  readonly likeCount: number | null;
  readonly commentsCount: number | null;
  readonly followersCountAtCollection: number | null;
  readonly createdAt: string;
  readonly sourceAccount?: {
    readonly id: string;
    readonly username: string;
    readonly region: IntelligenceRegion;
    readonly priorityWeight: number;
  };
}

export interface ClusterMemberContext {
  readonly rawPostId: string;
  readonly createdAt: string;
  readonly matchMethod: string;
  readonly matchConfidence: number | null;
}

export interface StoryClusterContext {
  readonly id: string;
  readonly canonicalTitle: string;
  readonly status: "OPEN" | "ACTIVE" | "STALE" | "ARCHIVED";
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly signature: Record<string, unknown>;
  readonly members: readonly ClusterMemberContext[];
}

export interface InformationSourceRecord {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly instagramUsername: string | null;
  readonly reliabilityScore: number;
}

export interface MembershipInput {
  readonly rawPostId: string;
  readonly clusterId: string;
  readonly matchMethod: "SEED" | "DETERMINISTIC" | "AI" | "MANUAL";
  readonly matchConfidence: number;
  readonly signature: Record<string, unknown>;
}

export interface ClusterSourceInput {
  readonly clusterId: string;
  readonly informationSourceId: string;
  readonly firstCitedPostId: string;
  readonly citationCount?: number;
  readonly extractionConfidence?: number;
  readonly evidenceText?: string;
}

export interface IntelligenceRepository {
  loadEligibleAccounts(runAt: Date | string): Promise<EligibleAccountSnapshot>;
  listRecentPosts(runAt: Date | string): Promise<readonly RecentRawPost[]>;
  listClusterContexts(): Promise<readonly StoryClusterContext[]>;
  listInformationSources(): Promise<readonly InformationSourceRecord[]>;
  createCluster(input: {
    canonicalTitle: string;
    firstSeenAt: string;
    lastSeenAt: string;
    signature: Record<string, unknown>;
  }): Promise<string>;
  upsertMembership(input: MembershipInput): Promise<void>;
  saveEvaluation(evaluation: StoryClusterEvaluation): Promise<void>;
  upsertClusterSources(inputs: readonly ClusterSourceInput[]): Promise<void>;
  calculateCandidates(runAt: Date | string): Promise<number>;
  tryAcquireRun(
    runId: string,
    now: Date | string,
    leaseUntil: Date | string,
  ): Promise<boolean>;
  renewRun(runId: string, leaseUntil: Date | string): Promise<boolean>;
  releaseRun(runId: string): Promise<void>;
}

export interface IntelligenceRepositoryOptions extends EvaluationRepositoryDeps {
  readonly serviceRoleKey?: string;
  readonly secretKey?: string;
  readonly businessTimezone?: string;
}

function validDate(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new EvaluationRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
  }
  return date;
}

function parseResponseJson(value: string, status: number): unknown {
  if (value.trim() === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", status);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayResponse(value: unknown, status: number): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(record)) {
    throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", status);
  }
  return value;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function region(value: unknown): IntelligenceRegion {
  if (value !== "GLOBAL" && value !== "KR") {
    throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", null);
  }
  return value;
}

function accountFromRow(value: Record<string, unknown>): {
  id: string;
  username: string;
  region: IntelligenceRegion;
  active: boolean;
  apiSupported: boolean | null;
  priorityWeight: number;
  lastProbeAt: string | null;
  probeError: string | null;
} {
  if (
    typeof value.id !== "string" || typeof value.username !== "string" ||
    value.username.trim() === ""
  ) {
    throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", null);
  }
  const priorityWeight = numberOrNull(value.priority_weight);
  if (priorityWeight === null || priorityWeight <= 0) {
    throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", null);
  }
  return {
    id: value.id,
    username: value.username,
    region: region(value.region),
    active: value.active === true,
    apiSupported: value.api_supported === true
      ? true
      : value.api_supported === false
      ? false
      : null,
    priorityWeight,
    lastProbeAt: stringOrNull(value.last_probe_at),
    probeError: stringOrNull(value.probe_error),
  };
}

function postFromRow(value: Record<string, unknown>): RecentRawPost {
  const sourceAccount = record(value.source_accounts)
    ? accountFromRow(value.source_accounts)
    : undefined;
  if (
    typeof value.id !== "string" || typeof value.source_account_id !== "string" ||
    typeof value.published_at !== "string" || typeof value.collected_at !== "string" ||
    typeof value.media_type !== "string"
  ) {
    throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", null);
  }
  return {
    id: value.id,
    sourceAccountId: value.source_account_id,
    caption: typeof value.caption === "string" ? value.caption : "",
    mediaType: value.media_type,
    publishedAt: value.published_at,
    collectedAt: value.collected_at,
    likeCount: numberOrNull(value.like_count),
    commentsCount: numberOrNull(value.comments_count),
    followersCountAtCollection: numberOrNull(value.followers_count_at_collection),
    createdAt: typeof value.created_at === "string" ? value.created_at : value.collected_at,
    ...(sourceAccount ? {
      sourceAccount: {
        id: sourceAccount.id,
        username: sourceAccount.username,
        region: sourceAccount.region,
        priorityWeight: sourceAccount.priorityWeight,
      },
    } : {}),
  };
}

function rpcPayload(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (record(value) && typeof value.id === "string") return value.id;
  if (Array.isArray(value) && value.length > 0 && record(value[0])) {
    return typeof value[0].id === "string" ? value[0].id : null;
  }
  return null;
}

export function createIntelligenceRepository(
  options: IntelligenceRepositoryOptions,
): IntelligenceRepository {
  const serviceRoleKey = options.serviceRoleKey ?? options.secretKey;
  if (
    options.supabaseUrl.trim() === "" || !serviceRoleKey ||
    serviceRoleKey.trim() === ""
  ) {
    throw new EvaluationRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
  }
  const configuredServiceRoleKey = serviceRoleKey;
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const evaluationRepository = createEvaluationRepository({
    ...options,
    serviceRoleKey: configuredServiceRoleKey,
  });

  async function activeBusinessTimezone(): Promise<string> {
    if (options.businessTimezone?.trim()) return options.businessTimezone;
    const value = await jsonRequest("/rest/v1/telegram_agent_configs?select=timezone&is_active=eq.true&limit=1", { method: "GET" });
    if (Array.isArray(value) && record(value[0]) && typeof value[0].timezone === "string" && value[0].timezone.trim()) return value[0].timezone;
    return "Asia/Seoul";
  }

  async function request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          apikey: configuredServiceRoleKey,
          ...init.headers,
        },
      });
    } catch {
      throw new EvaluationRepositoryError("DATABASE_NETWORK_ERROR", null);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", response.status);
    }
    return response;
  }

  async function jsonRequest(path: string, init: RequestInit): Promise<unknown> {
    const response = await request(path, init);
    return parseResponseJson(await response.text(), response.status);
  }

  return {
    async loadEligibleAccounts(runAt): Promise<EligibleAccountSnapshot> {
      const at = validDate(runAt);
      const query = new URLSearchParams({
        select: "id,username,region,active,api_supported,priority_weight,last_probe_at,probe_error",
        active: "eq.true",
        order: "id.asc",
      });
      const value = await jsonRequest(`/rest/v1/source_accounts?${query}`, { method: "GET" });
      const accounts = arrayResponse(value, 200).map(accountFromRow);
      const eligible = accounts.filter((account): account is typeof account & { apiSupported: true } =>
        account.active && account.apiSupported === true
      ).map((account) => ({
        id: account.id,
        username: account.username,
        region: account.region,
        active: true as const,
        apiSupported: true as const,
        priorityWeight: account.priorityWeight,
        lastProbeAt: account.lastProbeAt,
        probeError: account.probeError,
      }));
      const freshSuccessfulAccountIds = eligible.filter((account) => {
        if (!account.lastProbeAt || account.probeError !== null) return false;
        const probeAt = new Date(account.lastProbeAt).getTime();
        return Number.isFinite(probeAt) &&
          probeAt >= at.getTime() - 90 * 60 * 1000 && probeAt <= at.getTime();
      }).map((account) => account.id);
      return {
        runAt: at.toISOString(),
        eligible,
        pendingCapabilityAccountIds: accounts.filter((account) => account.apiSupported === null).map((account) => account.id),
        unsupportedAccountIds: accounts.filter((account) => account.apiSupported === false).map((account) => account.id),
        freshSuccessfulAccountIds,
      };
    },

    async listRecentPosts(runAt): Promise<readonly RecentRawPost[]> {
      const at = validDate(runAt);
      const query = new URLSearchParams({
        select: "id,source_account_id,caption,media_type,published_at,collected_at,like_count,comments_count,followers_count_at_collection,created_at,source_accounts!inner(id,username,region,priority_weight,active,api_supported,last_probe_at,probe_error)",
        published_at: `gte.${new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString()}`,
        order: "published_at.asc,id.asc",
      });
      // PostgREST's second predicate is added explicitly so future posts cannot leak into a run.
      query.append("published_at", `lte.${at.toISOString()}`);
      const value = await jsonRequest(`/rest/v1/raw_posts?${query}`, { method: "GET" });
      return arrayResponse(value, 200).map(postFromRow);
    },

    async listClusterContexts(): Promise<readonly StoryClusterContext[]> {
      const query = new URLSearchParams({
        select: "id,canonical_title,status,first_seen_at,last_seen_at,signature_json,story_cluster_posts(raw_post_id,created_at,match_method,match_confidence)",
        order: "created_at.asc,id.asc",
      });
      const value = await jsonRequest(`/rest/v1/story_clusters?${query}`, { method: "GET" });
      return arrayResponse(value, 200).map((row) => {
        const members = Array.isArray(row.story_cluster_posts)
          ? row.story_cluster_posts.filter(record).map((member) => ({
            rawPostId: String(member.raw_post_id),
            createdAt: typeof member.created_at === "string" ? member.created_at : "",
            matchMethod: typeof member.match_method === "string" ? member.match_method : "UNSPECIFIED",
            matchConfidence: numberOrNull(member.match_confidence),
          }))
          : [];
        return {
          id: String(row.id),
          canonicalTitle: typeof row.canonical_title === "string" ? row.canonical_title : "",
          status: row.status as StoryClusterContext["status"],
          firstSeenAt: String(row.first_seen_at),
          lastSeenAt: String(row.last_seen_at),
          signature: record(row.signature_json) ? row.signature_json : {},
          members,
        };
      });
    },

    async listInformationSources(): Promise<readonly InformationSourceRecord[]> {
      const query = new URLSearchParams({
        select: "id,canonical_name,aliases,instagram_username,reliability_score",
        active: "eq.true",
        order: "canonical_name.asc",
      });
      const value = await jsonRequest(`/rest/v1/information_sources?${query}`, { method: "GET" });
      return arrayResponse(value, 200).map((row) => ({
        id: String(row.id),
        canonicalName: String(row.canonical_name),
        aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : [],
        instagramUsername: stringOrNull(row.instagram_username),
        reliabilityScore: numberOrNull(row.reliability_score) ?? 0,
      }));
    },

    async createCluster(input): Promise<string> {
      const value = await jsonRequest("/rest/v1/story_clusters", {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "return=representation" },
        body: JSON.stringify({
          canonical_title: input.canonicalTitle,
          first_seen_at: input.firstSeenAt,
          last_seen_at: input.lastSeenAt,
          signature_json: input.signature,
          signature_version: typeof input.signature.dictionary_version === "string" ? input.signature.dictionary_version : "entity-v1",
        }),
      });
      const id = rpcPayload(value);
      if (!id) throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", 200);
      return id;
    },

    async upsertMembership(input): Promise<void> {
      await jsonRequest("/rest/v1/rpc/upsert_story_cluster_member", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          p_raw_post_id: input.rawPostId,
          p_cluster_id: input.clusterId,
          p_match_method: input.matchMethod,
          p_match_confidence: input.matchConfidence,
          p_signature: input.signature,
        }),
      });
    },

    saveEvaluation: evaluationRepository.saveEvaluation,

    async upsertClusterSources(inputs): Promise<void> {
      for (const input of inputs) {
        await jsonRequest("/rest/v1/story_cluster_sources?on_conflict=story_cluster_id%2Cinformation_source_id", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify({
            story_cluster_id: input.clusterId,
            information_source_id: input.informationSourceId,
            first_cited_post_id: input.firstCitedPostId,
            citation_count: input.citationCount ?? 1,
            extraction_confidence: input.extractionConfidence ?? 1,
            ...(input.evidenceText ? { evidence_text: input.evidenceText } : {}),
          }),
        });
      }
    },

    async calculateCandidates(runAt): Promise<number> {
      const at = validDate(runAt);
      const rankingDate = businessDate(at, await activeBusinessTimezone());
      const value = await jsonRequest("/rest/v1/rpc/calculate_priority_candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p_run_at: at.toISOString(), p_ranking_date: rankingDate }),
      });
      if (typeof value === "number" && Number.isSafeInteger(value)) return value;
      if (record(value) && Number.isSafeInteger(value.count)) return value.count as number;
      throw new EvaluationRepositoryError("DATABASE_HTTP_ERROR", 200);
    },

    async tryAcquireRun(runId, now, leaseUntil): Promise<boolean> {
      const value = await jsonRequest("/rest/v1/rpc/try_acquire_intelligence_run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p_run_id: runId, p_now: validDate(now).toISOString(), p_lease_until: validDate(leaseUntil).toISOString() }),
      });
      return value === true || (record(value) && value.try_acquire_intelligence_run === true);
    },

    async renewRun(runId, leaseUntil): Promise<boolean> {
      const value = await jsonRequest("/rest/v1/rpc/renew_intelligence_run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p_run_id: runId, p_lease_until: validDate(leaseUntil).toISOString() }),
      });
      return value === true || (record(value) && value.renew_intelligence_run === true);
    },

    async releaseRun(runId): Promise<void> {
      await jsonRequest("/rest/v1/rpc/release_intelligence_run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p_run_id: runId }),
      });
    },
  };
}

export function createRepository(options: IntelligenceRepositoryOptions): IntelligenceRepository {
  return createIntelligenceRepository(options);
}

export function loadEligibleAccounts(
  repository: IntelligenceRepository,
  runAt: Date | string,
): Promise<EligibleAccountSnapshot> {
  return repository.loadEligibleAccounts(runAt);
}

export function upsertMembership(
  repository: IntelligenceRepository,
  input: MembershipInput,
): Promise<void> {
  return repository.upsertMembership(input);
}

export function calculateCandidates(
  repository: IntelligenceRepository,
  runAt: Date | string,
): Promise<number> {
  return repository.calculateCandidates(runAt);
}
