import { validateGenerationConfig, type GenerationConfig } from "./config.ts";
import type { CandidateEvidenceInput, JsonValue } from "./types.ts";
import type { ExistingPipelineState } from "./notion_projection.ts";

export type GenerationJobStatus = "QUEUED" | "GENERATING" | "READY" | "BLOCKED_EVIDENCE" | "CLASSIFICATION_UNCERTAIN" | "FAILED_VALIDATION" | "FAILED_PROVIDER";
export type TriggerType = "AUTO_PRIORITY" | "NOTION_SELECTED" | "MANUAL";

export interface GenerationJob {
  readonly id: string;
  readonly candidate_id: string;
  readonly input_fingerprint: string;
  readonly trigger_type: TriggerType;
  status: GenerationJobStatus;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  repair_attempted: boolean;
  creative_brief_id: string | null;
  last_error_category: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreativeBriefInsert {
  readonly candidate_id: string;
  readonly version: number;
  readonly headline: string;
  readonly angle: string;
  readonly format: string;
  readonly slide_count: number;
  readonly slides_json: Record<string, unknown>;
  readonly design_json: Record<string, unknown>;
  readonly caption_draft: string;
  readonly cta: string;
  readonly status: "DRAFT" | "READY";
  readonly content_mode: string;
  readonly match_phase: string | null;
  readonly generation_config_id: string;
  readonly input_fingerprint: string;
  readonly evidence_snapshot: unknown;
  readonly hooks_json: unknown;
  readonly grounding_json: unknown;
  readonly generation_metadata: unknown;
  readonly generation_quality: string;
  readonly model_name: string;
  readonly generated_at: string;
}

export interface StoredCreativeBrief extends CreativeBriefInsert {
  readonly id: string;
}

export interface GenerationRepository {
  getCandidateEvidence(candidateId: string): Promise<CandidateEvidenceInput | null>;
  getActiveConfig(): Promise<unknown>;
  findReadyBrief(candidateId: string, inputFingerprint: string): Promise<StoredCreativeBrief | null>;
  getJob(candidateId: string, inputFingerprint: string): Promise<GenerationJob | null>;
  insertJob(input: Omit<GenerationJob, "id">): Promise<GenerationJob>;
  acquireLease(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<boolean>;
  updateJob(jobId: string, patch: Partial<GenerationJob>): Promise<void>;
  nextRevision(candidateId: string): Promise<number>;
  insertCreativeBrief(input: CreativeBriefInsert): Promise<StoredCreativeBrief>;
  listPriorityCandidateIds?(): Promise<readonly string[]>;
  getPipelineState?(candidateId: string): Promise<ExistingPipelineState | null>;
  savePipelineState?(state: { candidate_id: string; creative_brief_id: string; revision: number; notion_page_id: string; sync_hash: string | null; production_status: ExistingPipelineState["production_status"] }): Promise<void>;
  getDailyIntelligencePageId?(candidateId: string): Promise<string | null>;
}

export interface ProjectNotionRepository {
  getCreativeBrief(creativeBriefId: string): Promise<StoredCreativeBrief | null>;
  getPipelineState(candidateId: string): Promise<ExistingPipelineState | null>;
  savePipelineState(state: { candidate_id: string; creative_brief_id: string; revision: number; notion_page_id: string; sync_hash: string | null; production_status: ExistingPipelineState["production_status"] }): Promise<void>;
  getDailyIntelligencePageId(candidateId: string): Promise<string | null>;
}

interface RestRepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceKey: string;
  readonly request?: typeof fetch;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function candidateFromRow(row: Record<string, unknown>): CandidateEvidenceInput["candidate"] {
  return {
    id: string(row.id), story_cluster_id: string(row.story_cluster_id), ranking_date: string(row.ranking_date),
    rank: number(row.rank), priority_score: number(row.priority_score), data_confidence: number(row.data_confidence),
    first_mover_flag: bool(row.first_mover_flag), must_cover_flag: bool(row.must_cover_flag),
    korea_coverage_status: row.korea_coverage_status === "KNOWN" ? "KNOWN" : "UNCERTAIN", score_version: string(row.score_version),
    score_inputs: object(row.score_inputs) as Record<string, JsonValue>,
  };
}

function jobFromRow(row: Record<string, unknown>): GenerationJob {
  return {
    id: string(row.id), candidate_id: string(row.candidate_id), input_fingerprint: string(row.input_fingerprint),
    trigger_type: row.trigger_type === "NOTION_SELECTED" ? "NOTION_SELECTED" : row.trigger_type === "MANUAL" ? "MANUAL" : "AUTO_PRIORITY",
    status: string(row.status) as GenerationJobStatus, lease_owner: typeof row.lease_owner === "string" ? row.lease_owner : null,
    lease_expires_at: typeof row.lease_expires_at === "string" ? row.lease_expires_at : null, attempt_count: number(row.attempt_count) ?? 0,
    repair_attempted: bool(row.repair_attempted), creative_brief_id: typeof row.creative_brief_id === "string" ? row.creative_brief_id : null,
    last_error_category: typeof row.last_error_category === "string" ? row.last_error_category : null,
    created_at: string(row.created_at), updated_at: string(row.updated_at), completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
  };
}

export function createRestGenerationRepository(options: RestRepositoryOptions): GenerationRepository & ProjectNotionRepository {
  const fetchImpl = options.request ?? fetch;
  const base = `${options.supabaseUrl.replace(/\/$/u, "")}/rest/v1`;
  async function request(path: string, init: RequestInit = {}, schema?: string): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("apikey", options.serviceKey);
    headers.set("authorization", `Bearer ${options.serviceKey}`);
    headers.set("content-type", "application/json");
    if (schema) headers.set("accept-profile", schema);
    if (init.body && schema) headers.set("content-profile", schema);
    const response = await fetchImpl(`${base}${path}`, { ...init, headers });
    if (!response.ok) throw new Error("DATABASE_REQUEST_FAILED");
    return response.status === 204 ? null : await response.json();
  }

  async function getOne(path: string, schema?: string): Promise<Record<string, unknown> | null> {
    const value = await request(path, {}, schema);
    return Array.isArray(value) && value.length > 0 ? object(value[0]) : null;
  }

  return {
    async getCandidateEvidence(candidateId) {
      const candidateRow = await getOne(`/content_candidates?select=*&id=eq.${encodeURIComponent(candidateId)}&limit=1`);
      if (!candidateRow) return null;
      const candidate = candidateFromRow(candidateRow);
      const clusterRow = await getOne(`/story_clusters?select=id,canonical_title,status,first_seen_at,last_seen_at&id=eq.${encodeURIComponent(candidate.story_cluster_id)}&limit=1`);
      if (!clusterRow) return null;
      const postRows = await request(`/story_cluster_posts?select=raw_post_id,raw_posts(id,source_account_id,caption,permalink,published_at,media_type,source_accounts(username,region))&story_cluster_id=eq.${encodeURIComponent(candidate.story_cluster_id)}&order=raw_post_id.asc`);
      const sourceRows = await request(`/story_cluster_sources?select=information_source_id,first_cited_post_id,citation_count,evidence_text,information_sources(canonical_name,entity_type,reliability_score)&story_cluster_id=eq.${encodeURIComponent(candidate.story_cluster_id)}&order=information_source_id.asc`);
      const posts = Array.isArray(postRows) ? postRows.map((row) => {
        const value = object(row); const post = object(value.raw_posts); const account = object(post.source_accounts);
        return { raw_post_id: string(post.id || value.raw_post_id), source_account_id: string(post.source_account_id), account_username: string(account.username), region: string(account.region), caption: typeof post.caption === "string" ? post.caption : null, permalink: typeof post.permalink === "string" ? post.permalink : null, published_at: string(post.published_at), media_type: string(post.media_type) };
      }).filter((post) => post.raw_post_id) : [];
      const sources = Array.isArray(sourceRows) ? sourceRows.map((row) => {
        const value = object(row); const source = object(value.information_sources);
        return { source_id: string(value.information_source_id), canonical_name: string(source.canonical_name), entity_type: string(source.entity_type), reliability_score: number(source.reliability_score), evidence_text: typeof value.evidence_text === "string" ? value.evidence_text : null, first_cited_post_id: typeof value.first_cited_post_id === "string" ? value.first_cited_post_id : null, citation_count: number(value.citation_count) ?? 0 };
      }).filter((source) => source.source_id) : [];
      return { candidate, story: { id: string(clusterRow.id), canonical_title: typeof clusterRow.canonical_title === "string" ? clusterRow.canonical_title : null, status: string(clusterRow.status), first_seen_at: string(clusterRow.first_seen_at), last_seen_at: string(clusterRow.last_seen_at) }, posts, sources };
    },
    async getActiveConfig() {
      const row = await getOne("/creative_generation_configs?is_active=eq.true&order=effective_from.desc&limit=1");
      if (!row) throw new Error("GENERATION_CONFIG_NOT_FOUND");
      return validateGenerationConfig(row);
    },
    async findReadyBrief(candidateId, inputFingerprint) {
      const row = await getOne(`/creative_briefs?select=*&candidate_id=eq.${encodeURIComponent(candidateId)}&input_fingerprint=eq.${encodeURIComponent(inputFingerprint)}&status=eq.READY&limit=1`);
      return row ? row as unknown as StoredCreativeBrief : null;
    },
    async getCreativeBrief(creativeBriefId) {
      const row = await getOne(`/creative_briefs?select=*&id=eq.${encodeURIComponent(creativeBriefId)}&status=eq.READY&limit=1`);
      return row ? row as unknown as StoredCreativeBrief : null;
    },
    async getJob(candidateId, inputFingerprint) {
      const row = await getOne(`/creative_generation_jobs?select=*&candidate_id=eq.${encodeURIComponent(candidateId)}&input_fingerprint=eq.${encodeURIComponent(inputFingerprint)}&limit=1`, "app_private");
      return row ? jobFromRow(row) : null;
    },
    async insertJob(input) {
      try {
        const value = await request("/creative_generation_jobs", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(input) }, "app_private");
        return jobFromRow(object(Array.isArray(value) ? value[0] : value));
      } catch {
        const existing = await this.getJob(input.candidate_id, input.input_fingerprint);
        if (!existing) throw new Error("GENERATION_JOB_INSERT_FAILED");
        return existing;
      }
    },
    async acquireLease(jobId, leaseOwner, now, leaseUntil) {
      const value = await request("/rpc/try_acquire_creative_generation_job", { method: "POST", body: JSON.stringify({ p_job_id: jobId, p_lease_owner: leaseOwner, p_now: now.toISOString(), p_lease_until: leaseUntil.toISOString() }) });
      return value === true || value === "true";
    },
    async updateJob(jobId, patch) {
      await request(`/creative_generation_jobs?id=eq.${encodeURIComponent(jobId)}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(patch) }, "app_private");
    },
    async nextRevision(candidateId) {
      const value = await request(`/creative_briefs?select=version&candidate_id=eq.${encodeURIComponent(candidateId)}&order=version.desc&limit=1`);
      const row = Array.isArray(value) ? object(value[0]) : {};
      return (number(row.version) ?? 0) + 1;
    },
    async insertCreativeBrief(input) {
      const value = await request("/creative_briefs", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(input) });
      return object(Array.isArray(value) ? value[0] : value) as unknown as StoredCreativeBrief;
    },
    async listPriorityCandidateIds() {
      const value = await request("/content_candidates?select=id&or=(first_mover_flag.eq.true,must_cover_flag.eq.true)&order=priority_score.desc&limit=100");
      return Array.isArray(value) ? value.map((entry) => string(object(entry).id)).filter(Boolean) : [];
    },
    async getPipelineState(candidateId) {
      const value = await request(`/creative_pipeline_sync_state?select=notion_page_id,production_status,revision&candidate_id=eq.${encodeURIComponent(candidateId)}&order=revision.desc&limit=1`, {}, "app_private");
      const row = Array.isArray(value) ? object(value[0]) : {};
      if (!row.notion_page_id || typeof row.notion_page_id !== "string") return null;
      const status = row.production_status === "EDITABLE" || row.production_status === "LOCKED" || row.production_status === "APPROVED" ? row.production_status : "UNKNOWN";
      return { notion_page_id: row.notion_page_id, production_status: status, current_revision: number(row.revision) };
    },
    async savePipelineState(state) {
      await request("/creative_pipeline_sync_state?on_conflict=creative_brief_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(state) }, "app_private");
    },
    async getDailyIntelligencePageId(candidateId) {
      const value = await request(`/notion_sync_state?select=notion_page_id&candidate_id=eq.${encodeURIComponent(candidateId)}&limit=1`, {}, "app_private");
      const row = Array.isArray(value) ? object(value[0]) : {};
      return typeof row.notion_page_id === "string" ? row.notion_page_id : null;
    },
  };
}
