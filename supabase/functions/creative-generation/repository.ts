import { validateGenerationConfig, type GenerationConfig } from "./config.ts";
import type { CandidateEvidenceInput, JsonValue } from "./types.ts";
import type { ExistingPipelineState } from "./notion_projection.ts";
import type { ExplorationArticleEvidenceInput } from "./types.ts";
import { businessDate } from "../_shared/m6/business_date.ts";

export type GenerationJobStatus = "QUEUED" | "GENERATING" | "READY" | "DRAFT" | "BLOCKED_EVIDENCE" | "CLASSIFICATION_UNCERTAIN" | "FAILED_VALIDATION" | "FAILED_PROVIDER";
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
  generation_intent?: "STANDARD" | "EXPLORATION";
  exploration_fingerprint?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  provider_calls?: number;
  retry_count?: number;
  estimated_cost_usd?: number | null;
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
  readonly style_profile?: string;
  readonly style_version?: string;
  readonly exploration_fingerprint?: string;
  readonly provider_calls?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly estimated_cost_usd?: number | null;
}

export interface StoredCreativeBrief extends CreativeBriefInsert {
  readonly id: string;
}

export interface GenerationRepository {
  getCandidateEvidence(candidateId: string): Promise<CandidateEvidenceInput | null>;
  getActiveConfig(): Promise<unknown>;
  findReadyBrief(candidateId: string, inputFingerprint: string): Promise<StoredCreativeBrief | null>;
  findExplorationBrief?(explorationFingerprint: string): Promise<StoredCreativeBrief | null>;
  findExistingBriefForStory?(storyClusterId: string, publisherUrls: readonly string[]): Promise<StoredCreativeBrief | null>;
  getJob(candidateId: string, inputFingerprint: string): Promise<GenerationJob | null>;
  getJobById?(jobId: string): Promise<GenerationJob | null>;
  insertJob(input: Omit<GenerationJob, "id">): Promise<GenerationJob>;
  reserveExplorationJob?(input: { candidate_id: string; exploration_fingerprint: string; trigger_type: TriggerType; now: Date; daily_limit: number }): Promise<{ status: "RESERVED" | "EXISTING" | "DAILY_LIMIT"; job_id?: string }>;
  acquireLease(jobId: string, leaseOwner: string, now: Date, leaseUntil: Date): Promise<boolean>;
  updateJob(jobId: string, patch: Partial<GenerationJob>): Promise<void>;
  nextRevision(candidateId: string): Promise<number>;
  insertCreativeBrief(input: CreativeBriefInsert): Promise<StoredCreativeBrief>;
  listPriorityCandidateIds?(rankingDate: string): Promise<readonly string[]>;
  listExplorationCandidateIds?(now: Date): Promise<readonly string[]>;
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
  readonly now?: () => Date;
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

function date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function m8GroundedSources(
  claimsValue: unknown,
  evidenceValue: unknown,
  observationsValue: unknown,
  informationSourcesValue: unknown,
): CandidateEvidenceInput["sources"] {
  const verifiedClaims = new Map<string, { scope: CandidateEvidenceInput["sources"][number]["claim_scope"]; modality: CandidateEvidenceInput["sources"][number]["claim_modality"] }>();
  if (Array.isArray(claimsValue)) for (const value of claimsValue) {
    const row = object(value);
    if (typeof row.id === "string" && row.grounding_status === "VERIFIED") verifiedClaims.set(row.id, {
      scope: row.claim_scope === "PUBLISHER_REPORT" || row.claim_scope === "EVENT" ? row.claim_scope : undefined,
      modality: ["CONFIRMED", "RUMOR", "PREDICTION", "DENIAL", "OPINION", "UNKNOWN"].includes(String(row.claim_modality)) ? row.claim_modality as CandidateEvidenceInput["sources"][number]["claim_modality"] : undefined,
    });
  }
  const sourceNames = new Map<string, { name: string; entityType: string; reliability: number | null }>();
  if (Array.isArray(informationSourcesValue)) for (const value of informationSourcesValue) {
    const row = object(value);
    if (typeof row.id !== "string" || typeof row.canonical_name !== "string") continue;
    sourceNames.set(row.id, {
      name: row.canonical_name,
      entityType: string(row.entity_type),
      reliability: number(row.reliability_score),
    });
  }
  const observations = new Map<string, { sourceId: string; title: string; canonicalUrl: string; publishedAt: string | null; metadata: Record<string, unknown> }>();
  if (Array.isArray(observationsValue)) for (const value of observationsValue) {
    const row = object(value);
    if (typeof row.id !== "string" || typeof row.information_source_id !== "string" || typeof row.title !== "string" || typeof row.canonical_url !== "string") continue;
    observations.set(row.id, { sourceId: row.information_source_id, title: row.title, canonicalUrl: row.canonical_url, publishedAt: typeof row.published_at === "string" ? row.published_at : null, metadata: object(row.metadata) });
  }
  const grounded: CandidateEvidenceInput["sources"][number][] = [];
  if (Array.isArray(evidenceValue)) for (const value of evidenceValue) {
    const row = object(value);
    if (typeof row.claim_id !== "string" || !verifiedClaims.has(row.claim_id) || row.is_grounding !== true || row.relation !== "SUPPORTS" || typeof row.evidence_text !== "string" || !row.evidence_text.trim()) continue;
    if (row.editorial_role !== "FACT_PRIMARY" && row.editorial_role !== "FACT_INDEPENDENT") continue;
    if (typeof row.source_observation_id !== "string") continue;
    const observation = observations.get(row.source_observation_id);
    if (!observation) continue;
    const source = sourceNames.get(observation.sourceId);
    if (!source) continue;
    const claim = verifiedClaims.get(row.claim_id)!;
    grounded.push({
      source_id: `m8-claim:${row.claim_id}:observation:${row.source_observation_id}`,
      canonical_name: source.name,
      entity_type: source.entityType,
      reliability_score: source.reliability,
      evidence_text: row.evidence_text.slice(0, 2_000),
      first_cited_post_id: null,
      citation_count: 1,
      claim_id: row.claim_id,
      editorial_role: row.editorial_role,
      relation: row.relation,
      is_grounding: row.is_grounding,
      claim_scope: claim.scope,
      claim_modality: claim.modality,
      canonical_url: observation.canonicalUrl,
      google_news_original_url: typeof observation.metadata.google_news_original_url === "string" ? observation.metadata.google_news_original_url : null,
      published_at: observation.publishedAt,
      verified: true,
    });
  }
  return grounded.sort((left, right) => left.source_id.localeCompare(right.source_id));
}

function m8ExplorationArticles(
  claimsValue: unknown,
  evidenceValue: unknown,
  observationsValue: unknown,
  informationSourcesValue: unknown,
  discoveryValue: unknown,
): ExplorationArticleEvidenceInput[] {
  const claimIds = new Set<string>();
  const modalities = new Map<string, ExplorationArticleEvidenceInput["modality"]>();
  if (Array.isArray(claimsValue)) for (const value of claimsValue) {
    const row = object(value);
    if (typeof row.id !== "string") continue;
    claimIds.add(row.id);
    if (["CONFIRMED", "RUMOR", "PREDICTION", "DENIAL", "OPINION", "UNKNOWN"].includes(String(row.claim_modality))) {
      modalities.set(row.id, row.claim_modality as ExplorationArticleEvidenceInput["modality"]);
    }
  }

  const sourceNames = new Map<string, string>();
  if (Array.isArray(informationSourcesValue)) for (const value of informationSourcesValue) {
    const row = object(value);
    if (typeof row.id === "string" && typeof row.canonical_name === "string") sourceNames.set(row.id, row.canonical_name);
  }

  const sourceRows = new Map<string, Record<string, unknown>>();
  if (Array.isArray(observationsValue)) for (const value of observationsValue) {
    const row = object(value);
    if (typeof row.id === "string") sourceRows.set(row.id, row);
  }

  const relatedSourceIds = new Set<string>();
  const modalityBySource = new Map<string, ExplorationArticleEvidenceInput["modality"]>();
  if (Array.isArray(evidenceValue)) for (const value of evidenceValue) {
    const row = object(value);
    if (typeof row.source_observation_id !== "string" || typeof row.claim_id !== "string" || !claimIds.has(row.claim_id)) continue;
    relatedSourceIds.add(row.source_observation_id);
    const modality = modalities.get(row.claim_id);
    if (modality && (!modalityBySource.has(row.source_observation_id) || modality !== "CONFIRMED")) modalityBySource.set(row.source_observation_id, modality);
  }

  const discoveryRows = Array.isArray(discoveryValue) ? discoveryValue.map(object) : [];
  for (const row of discoveryRows) if (typeof row.source_observation_id === "string") relatedSourceIds.add(row.source_observation_id);

  const result = new Map<string, ExplorationArticleEvidenceInput>();
  for (const sourceId of relatedSourceIds) {
    const source = sourceRows.get(sourceId);
    const discovery = discoveryRows.find((row) => row.source_observation_id === sourceId);
    const metadata = object(source?.metadata);
    const discoveryMetadata = object(discovery?.metadata);
    const extractionStatus = source && (metadata.article_extraction_status === "EXTRACTED" || metadata.article_enrichment === "EXTRACTED")
      ? "EXTRACTED"
      : discovery?.article_extraction_status === "EXTRACTED" ? "EXTRACTED"
      : typeof metadata.article_extraction_status === "string" ? metadata.article_extraction_status
      : typeof discovery?.article_extraction_status === "string" ? discovery.article_extraction_status
      : "NOT_EXTRACTED";
    const articleText = extractionStatus === "EXTRACTED"
      ? (typeof metadata.article_content_excerpt === "string" ? metadata.article_content_excerpt : typeof source?.excerpt === "string" ? source.excerpt : typeof discovery?.article_content_excerpt === "string" ? discovery.article_content_excerpt : null)
      : null;
    const canonicalUrl = typeof source?.canonical_url === "string" ? source.canonical_url : typeof discovery?.article_final_url === "string" ? discovery.article_final_url : typeof discovery?.resolved_publisher_url === "string" ? discovery.resolved_publisher_url : typeof discovery?.canonical_url === "string" ? discovery.canonical_url : "";
    const publisherName = typeof source?.information_source_id === "string"
      ? sourceNames.get(source.information_source_id) ?? (typeof discovery?.source_canonical_name === "string" ? discovery.source_canonical_name : "")
      : typeof discovery?.source_canonical_name === "string" ? discovery.source_canonical_name : "";
    const publishedAt = typeof source?.published_at === "string" ? source.published_at : typeof discovery?.published_at === "string" ? discovery.published_at : null;
    const observedAt = typeof source?.observed_at === "string" ? source.observed_at : typeof discovery?.last_observed_at === "string" ? discovery.last_observed_at : null;
    const contentFingerprint = typeof source?.content_fingerprint === "string" ? source.content_fingerprint : typeof discovery?.content_fingerprint === "string" ? discovery.content_fingerprint : "";
    const sourceTitle = typeof source?.title === "string" ? source.title : typeof discovery?.title === "string" ? discovery.title : "";
    if (!canonicalUrl || !contentFingerprint || (!articleText && !sourceTitle)) continue;
    result.set(sourceId, {
      source_observation_id: sourceId,
      publisher_name: publisherName,
      canonical_url: canonicalUrl,
      published_at: publishedAt,
      observed_at: observedAt,
      extraction_status: extractionStatus,
      article_text: articleText,
      content_fingerprint: contentFingerprint,
      modality: modalityBySource.get(sourceId) ?? (typeof discoveryMetadata.claim_modality === "string" && ["CONFIRMED", "RUMOR", "PREDICTION", "DENIAL", "OPINION", "UNKNOWN"].includes(discoveryMetadata.claim_modality) ? discoveryMetadata.claim_modality as ExplorationArticleEvidenceInput["modality"] : "UNKNOWN"),
      verified: false,
    });
  }
  return [...result.values()].sort((left, right) => (right.published_at ?? "").localeCompare(left.published_at ?? "") || left.source_observation_id.localeCompare(right.source_observation_id));
}

function candidateFromRow(row: Record<string, unknown>, editorialRanking?: CandidateEvidenceInput["candidate"]["editorial_ranking"]): CandidateEvidenceInput["candidate"] {
  return {
    id: string(row.id), story_cluster_id: string(row.story_cluster_id), ranking_date: string(row.ranking_date),
    rank: number(row.rank), priority_score: number(row.priority_score), data_confidence: number(row.data_confidence),
    first_mover_flag: typeof row.first_mover_flag === "boolean" ? row.first_mover_flag : null,
    must_cover_flag: typeof row.must_cover_flag === "boolean" ? row.must_cover_flag : null,
    korea_coverage_status: row.korea_coverage_status === "KNOWN" ? "KNOWN" : "UNCERTAIN", score_version: typeof row.score_version === "string" ? row.score_version : null,
    score_inputs: object(row.score_inputs) as Record<string, JsonValue>,
    ...(editorialRanking ? { editorial_ranking: editorialRanking } : {}),
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
    ...(row.generation_intent === "EXPLORATION" ? { generation_intent: "EXPLORATION" as const } : { generation_intent: "STANDARD" as const }),
    exploration_fingerprint: typeof row.exploration_fingerprint === "string" ? row.exploration_fingerprint : null,
    input_tokens: number(row.input_tokens) ?? 0, output_tokens: number(row.output_tokens) ?? 0,
    provider_calls: number(row.provider_calls) ?? 0, retry_count: number(row.retry_count) ?? 0,
    estimated_cost_usd: number(row.estimated_cost_usd),
  };
}

export function createRestGenerationRepository(options: RestRepositoryOptions): GenerationRepository & ProjectNotionRepository {
  const fetchImpl = options.request ?? fetch;
  const base = `${options.supabaseUrl.replace(/\/$/u, "")}/rest/v1`;
  const now = options.now ?? (() => new Date());
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
      const editorialValue = await request(`/editorial_rankings?select=story_cluster_id,ranking_date,ranking_version,rank,editorial_score,news_eligible&story_cluster_id=eq.${encodeURIComponent(string(candidateRow.story_cluster_id))}&ranking_date=eq.${encodeURIComponent(string(candidateRow.ranking_date))}&order=calculated_at.desc&limit=1`, {}, "app_private");
      const editorialRow = Array.isArray(editorialValue) ? object(editorialValue[0]) : {};
      const editorialRanking = typeof editorialRow.ranking_date === "string" ? {
        story_cluster_id: string(editorialRow.story_cluster_id), ranking_date: string(editorialRow.ranking_date),
        ranking_version: string(editorialRow.ranking_version), rank: number(editorialRow.rank),
        editorial_score: number(editorialRow.editorial_score), news_eligible: editorialRow.news_eligible === true,
      } : undefined;
      const candidate = candidateFromRow(candidateRow, editorialRanking);
      const clusterRow = await getOne(`/story_clusters?select=id,canonical_title,status,first_seen_at,last_seen_at&id=eq.${encodeURIComponent(candidate.story_cluster_id)}&limit=1`);
      if (!clusterRow) return null;
      const [postRows, sourceRows, m8Claims, discoveryRows] = await Promise.all([
        request(`/story_cluster_posts?select=raw_post_id,raw_posts(id,source_account_id,caption,permalink,published_at,media_type,source_accounts(username,region))&story_cluster_id=eq.${encodeURIComponent(candidate.story_cluster_id)}&order=raw_post_id.asc`),
        request(`/story_cluster_sources?select=information_source_id,first_cited_post_id,citation_count,evidence_text,information_sources(canonical_name,entity_type,reliability_score)&story_cluster_id=eq.${encodeURIComponent(candidate.story_cluster_id)}&order=information_source_id.asc`),
        request(`/story_claims?select=id,grounding_status,claim_scope,claim_modality&story_cluster_id=eq.${encodeURIComponent(candidate.story_cluster_id)}&limit=2000`, {}, "app_private"),
        request(`/discovery_observations?select=id,source_observation_id,provider_id,source_canonical_name,canonical_url,article_final_url,resolved_publisher_url,title,article_extraction_status,article_content_excerpt,published_at,last_observed_at,content_fingerprint,metadata&story_cluster_id=eq.${encodeURIComponent(candidate.story_cluster_id)}&order=published_at.desc.nullslast&limit=100`, {}, "app_private"),
      ]);
      const claimIds = Array.isArray(m8Claims) ? m8Claims.map(object).map((row) => string(row.id)).filter(Boolean) : [];
      const claimFilter = claimIds.length > 0 ? `&claim_id=in.(${claimIds.map(encodeURIComponent).join(",")})` : "&claim_id=eq.__none__";
      const m8Evidence = await request(`/claim_evidence?select=claim_id,source_observation_id,editorial_role,relation,is_grounding,evidence_text${claimFilter}`, {}, "app_private");
      const observationIds = new Set<string>();
      if (Array.isArray(m8Evidence)) for (const value of m8Evidence) {
        const id = object(value).source_observation_id;
        if (typeof id === "string") observationIds.add(id);
      }
      if (Array.isArray(discoveryRows)) for (const value of discoveryRows) {
        const id = object(value).source_observation_id;
        if (typeof id === "string") observationIds.add(id);
      }
      const observationFilter = [...observationIds].map(encodeURIComponent).join(",");
      const m8Observations = observationFilter
        ? await request(`/source_observations?select=id,information_source_id,editorial_role,external_id,canonical_url,title,excerpt,published_at,observed_at,content_fingerprint,metadata&id=in.(${observationFilter})`, {}, "app_private")
        : [];
      const informationSourceIds = Array.isArray(m8Observations)
        ? [...new Set(m8Observations.map(object).map((row) => string(row.information_source_id)).filter(Boolean))]
        : [];
      const informationSourceFilter = informationSourceIds.map(encodeURIComponent).join(",");
      const m8InformationSources = informationSourceFilter
        ? await request(`/information_sources?select=id,canonical_name,entity_type,reliability_score&id=in.(${informationSourceFilter})`)
        : [];
      const posts = Array.isArray(postRows) ? postRows.map((row) => {
        const value = object(row); const post = object(value.raw_posts); const account = object(post.source_accounts);
        return { raw_post_id: string(post.id || value.raw_post_id), source_account_id: string(post.source_account_id), account_username: string(account.username), region: string(account.region), caption: typeof post.caption === "string" ? post.caption : null, permalink: typeof post.permalink === "string" ? post.permalink : null, published_at: string(post.published_at), media_type: string(post.media_type) };
      }).filter((post) => post.raw_post_id) : [];
      const legacySources = Array.isArray(sourceRows) ? sourceRows.map((row) => {
        const value = object(row); const source = object(value.information_sources);
        return { source_id: string(value.information_source_id), canonical_name: string(source.canonical_name), entity_type: string(source.entity_type), reliability_score: number(source.reliability_score), evidence_text: typeof value.evidence_text === "string" ? value.evidence_text : null, first_cited_post_id: typeof value.first_cited_post_id === "string" ? value.first_cited_post_id : null, citation_count: number(value.citation_count) ?? 0 };
      }).filter((source) => source.source_id) : [];
      const m8Sources = m8GroundedSources(m8Claims, m8Evidence, m8Observations, m8InformationSources);
      const sources = [...legacySources, ...m8Sources.filter((source) => !legacySources.some((legacy) => legacy.source_id === source.source_id))];
      const explorationArticles = m8ExplorationArticles(m8Claims, m8Evidence, m8Observations, m8InformationSources, discoveryRows);
      return { candidate, story: { id: string(clusterRow.id), canonical_title: typeof clusterRow.canonical_title === "string" ? clusterRow.canonical_title : null, status: string(clusterRow.status), first_seen_at: string(clusterRow.first_seen_at), last_seen_at: string(clusterRow.last_seen_at) }, posts, sources, exploration_articles: explorationArticles };
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
    async findExplorationBrief(explorationFingerprint) {
      const row = await getOne(`/creative_briefs?select=*&exploration_fingerprint=eq.${encodeURIComponent(explorationFingerprint)}&status=in.(DRAFT,SELECTED,BRIEF_READY,DESIGNING,READY,PUBLISHED)&limit=1`);
      return row ? row as unknown as StoredCreativeBrief : null;
    },
    async findExistingBriefForStory(storyClusterId, publisherUrls) {
      void publisherUrls;
      const candidates = await request(`/content_candidates?select=id&story_cluster_id=eq.${encodeURIComponent(storyClusterId)}&limit=1000`);
      const candidateIds = Array.isArray(candidates) ? candidates.map(object).map((row) => string(row.id)).filter(Boolean) : [];
      if (candidateIds.length === 0) return null;
      const candidateFilter = candidateIds.map(encodeURIComponent).join(",");
      const row = await getOne(`/creative_briefs?select=*&candidate_id=in.(${candidateFilter})&status=in.(DRAFT,SELECTED,BRIEF_READY,DESIGNING,READY,PUBLISHED)&order=generated_at.desc.nullslast,created_at.desc&limit=1`);
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
    async getJobById(jobId) {
      const row = await getOne(`/creative_generation_jobs?select=*&id=eq.${encodeURIComponent(jobId)}&limit=1`, "app_private");
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
    async reserveExplorationJob(input) {
      const value = await request("/rpc/reserve_editorial_exploration_generation", {
        method: "POST",
        body: JSON.stringify({
          p_candidate_id: input.candidate_id,
          p_exploration_fingerprint: input.exploration_fingerprint,
          p_trigger_type: input.trigger_type,
          p_at: input.now.toISOString(),
          p_daily_limit: input.daily_limit,
        }),
      });
      const row = Array.isArray(value) ? object(value[0]) : object(value);
      const status = row.status === "RESERVED" || row.status === "EXISTING" || row.status === "DAILY_LIMIT" ? row.status : "DAILY_LIMIT";
      return { status, ...(typeof row.job_id === "string" ? { job_id: row.job_id } : {}) };
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
    async listPriorityCandidateIds(rankingDate) {
      const rankingValue = await request(`/editorial_rankings?select=story_cluster_id,ranking_date,rank,news_eligible&ranking_date=eq.${encodeURIComponent(rankingDate)}&news_eligible=eq.true&order=rank.asc&limit=100`, {}, "app_private");
      const rankings = Array.isArray(rankingValue) ? rankingValue.map(object).filter((row) => typeof row.story_cluster_id === "string" && row.ranking_date === rankingDate && row.news_eligible === true && typeof row.rank === "number") : [];
      const storyIds = [...new Set(rankings.map((row) => string(row.story_cluster_id)))];
      if (storyIds.length === 0) return [];
      const inFilter = `(${storyIds.map((id) => encodeURIComponent(id)).join(",")})`;
      const [candidateValue, clusterValue] = await Promise.all([
        request(`/content_candidates?select=id,story_cluster_id,ranking_date&ranking_date=eq.${encodeURIComponent(rankingDate)}&story_cluster_id=in.${inFilter}&limit=500`),
        request(`/story_clusters?select=id,last_seen_at&id=in.${inFilter}&limit=500`),
      ]);
      const asOf = now().getTime();
      const freshIds = new Set(Array.isArray(clusterValue) ? clusterValue.map(object).filter((row) => {
        const seen = date(row.last_seen_at)?.getTime();
        return typeof row.id === "string" && seen !== undefined && seen <= asOf && seen >= asOf - 72 * 60 * 60 * 1000;
      }).map((row) => string(row.id)) : []);
      const candidateByStory = new Map<string, string>();
      if (Array.isArray(candidateValue)) for (const item of candidateValue) {
        const row = object(item);
        if (typeof row.id === "string" && typeof row.story_cluster_id === "string" && row.ranking_date === rankingDate && freshIds.has(row.story_cluster_id)) candidateByStory.set(row.story_cluster_id, row.id);
      }
      return rankings.sort((left, right) => Number(left.rank) - Number(right.rank)).flatMap((row) => {
        const candidateId = candidateByStory.get(string(row.story_cluster_id));
        return candidateId ? [candidateId] : [];
      });
    },
    async listExplorationCandidateIds(at) {
      const cutoff = new Date(at.getTime() - 72 * 60 * 60 * 1000).toISOString();
      const observations = await request(`/discovery_observations?select=story_cluster_id,published_at&story_cluster_id=not.is.null&published_at=gte.${encodeURIComponent(cutoff)}&published_at=lte.${encodeURIComponent(at.toISOString())}&order=published_at.desc&limit=1000`, {}, "app_private");
      const storyIds: string[] = [];
      const seenStories = new Set<string>();
      if (Array.isArray(observations)) for (const value of observations) {
        const row = object(value);
        if (typeof row.story_cluster_id === "string" && !seenStories.has(row.story_cluster_id)) {
          seenStories.add(row.story_cluster_id);
          storyIds.push(row.story_cluster_id);
        }
      }
      if (storyIds.length === 0) return [];
      const inFilter = `(${storyIds.map(encodeURIComponent).join(",")})`;
      const candidates = await request(`/content_candidates?select=id,story_cluster_id&ranking_date=eq.${encodeURIComponent(businessDate(at, "Asia/Seoul"))}&story_cluster_id=in.${inFilter}&limit=1000`);
      const candidateByStory = new Map<string, string>();
      if (Array.isArray(candidates)) for (const value of candidates) {
        const row = object(value);
        if (typeof row.story_cluster_id === "string" && typeof row.id === "string") candidateByStory.set(row.story_cluster_id, row.id);
      }
      return storyIds.flatMap((storyId) => candidateByStory.has(storyId) ? [candidateByStory.get(storyId)!] : []);
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
