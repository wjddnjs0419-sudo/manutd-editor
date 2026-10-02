import type { ManutdEditorCarouselDraft, EditorialSlide } from "../editorial-style/types.ts";
import { isManchesterUnitedRelevant } from "../m8/manchester_united_relevance.ts";
import { displayStoryTitle } from "../m8/story_display.ts";
import { editorialTrustLabel, editorialTrustState, type EditorialTrustState } from "./editorial_trust.ts";

export interface EditorialEvidence {
  evidence_id: string;
  source_name: string;
  claim_text: string;
  status: "SUPPORTED" | "REPORTED" | "CONTRADICTED";
  canonical_url: string | null;
  editorial_role?: string | null;
}

export interface EditorialStoryInput {
  story_cluster_id: string;
  candidate_id: string | null;
  ranking_date: string;
  ranking_version: string;
  canonical_title: string;
  summary: string | null;
  rank: number | null;
  editorial_score: number;
  information_gap_score: number;
  discovery_audience_signal_score: number;
  fact_grounding_score: number;
  grounding_status: string;
  news_eligible: boolean;
  source_names: string[];
  evidence: EditorialEvidence[];
  story_fingerprint: string;
  latest_brief_id: string | null;
  trend_score?: number | null;
  trend_state?: string | null;
  trend_source_count?: number | null;
  trend_platform_count?: number | null;
  platform_count?: number | null;
  opportunity_labels?: string[];
}

export interface CanonicalStory {
  id: string;
  candidate_id: string | null;
  title: string;
  summary: string | null;
  ranking_date: string;
  ranking_version: string;
  rank: number | null;
  editorial_score: number;
  information_gap_score: number;
  hook_strength: number;
  shareability: number;
  source_confidence: number;
  grounding_status: string;
  news_eligible: boolean;
  sources: string[];
  source_count: number;
  evidence: EditorialEvidence[];
  story_fingerprint: string;
  latest_brief_id: string | null;
  recommended: boolean;
  trend_score: number | null;
  trend_state: string | null;
  trend_source_count: number;
  trend_platform_count: number;
  opportunity_labels: readonly string[];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface ConsoleView {
  text: string;
  inline_keyboard: InlineKeyboardButton[][];
}

export interface StoryPage {
  items: readonly CanonicalStory[];
  page: number;
  page_size: number;
  total: number;
  start: number;
  end: number;
  has_previous: boolean;
  has_next: boolean;
}

export interface EditorialConsoleRepositoryOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

export interface EditorialConsoleRepository {
  listCanonicalStories(rankingDate: string): Promise<readonly CanonicalStory[]>;
  listTrendingStories(rankingDate: string): Promise<readonly CanonicalStory[]>;
}

interface JsonObject {
  [key: string]: unknown;
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function array(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(object) : [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

function score10(value: number): string {
  return (value / 10).toFixed(1);
}

export function shortCallbackToken(value: string): string {
  return value.replaceAll("-", "").slice(0, 12);
}

export function findCanonicalStoryByToken(stories: readonly CanonicalStory[], token: string): CanonicalStory | null {
  const normalized = token.trim();
  const rankMatch = /^(\d+)번?$/u.exec(normalized);
  const rank = rankMatch ? Number(rankMatch[1]) : null;
  return stories.find((story) =>
    story.id === normalized ||
    story.candidate_id === normalized ||
    shortCallbackToken(story.id) === normalized ||
    (rank !== null && Number.isInteger(rank) && rank > 0 && story.rank === rank)
  ) ?? null;
}

export function callbackData(action: string, value: string): string {
  return `${action}:${shortCallbackToken(value)}`;
}

export function buildCanonicalStories(
  inputs: readonly EditorialStoryInput[],
  skippedFingerprints: ReadonlySet<string> = new Set(),
): readonly CanonicalStory[] {
  const grouped = new Map<string, EditorialStoryInput[]>();
  for (const input of inputs) {
    const existing = grouped.get(input.story_cluster_id) ?? [];
    existing.push(input);
    grouped.set(input.story_cluster_id, existing);
  }

  return [...grouped.values()]
    .map((group) => {
      const first = group[0]!;
      const sources = unique([
        ...group.flatMap((input) => input.source_names),
        ...group.flatMap((input) => input.evidence.map((item) => item.source_name)),
      ]);
      const evidenceById = new Map<string, EditorialEvidence>();
      for (const input of group) for (const evidence of input.evidence) evidenceById.set(evidence.evidence_id, evidence);
      return {
        id: first.story_cluster_id,
        candidate_id: first.candidate_id,
        title: displayStoryTitle(first.canonical_title),
        summary: first.summary,
        ranking_date: first.ranking_date,
        ranking_version: first.ranking_version,
        rank: first.rank,
        editorial_score: first.editorial_score,
        information_gap_score: first.information_gap_score,
        hook_strength: (first.information_gap_score + first.discovery_audience_signal_score) / 2,
        shareability: first.discovery_audience_signal_score,
        source_confidence: first.fact_grounding_score,
        grounding_status: first.grounding_status,
        news_eligible: first.news_eligible,
        sources,
        source_count: sources.length,
        evidence: [...evidenceById.values()],
        story_fingerprint: first.story_fingerprint,
        latest_brief_id: first.latest_brief_id,
        recommended: first.rank !== null && first.rank <= 5,
        trend_score: first.trend_score ?? null,
        trend_state: first.trend_state ?? null,
        trend_source_count: first.trend_source_count ?? sources.length,
        trend_platform_count: first.trend_platform_count ?? first.platform_count ?? 0,
        opportunity_labels: first.opportunity_labels ?? [],
      } satisfies CanonicalStory;
    })
    .filter((story) => !skippedFingerprints.has(story.story_fingerprint))
    .sort((left, right) => (left.rank === null ? 1 : right.rank === null ? -1 : left.rank - right.rank) || left.title.localeCompare(right.title, "ko"));
}

export function paginateStories(stories: readonly CanonicalStory[], page: number, pageSize = 5): StoryPage {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const total = stories.length;
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const offset = (safePage - 1) * safePageSize;
  const items = stories.slice(offset, offset + safePageSize);
  return {
    items,
    page: safePage,
    page_size: safePageSize,
    total,
    start: total === 0 ? 0 : offset + 1,
    end: total === 0 ? 0 : offset + items.length,
    has_previous: safePage > 1,
    has_next: offset + items.length < total,
  };
}

function pageHeader(label: string, page: StoryPage): string {
  return `${label} · ${page.start}–${page.end} / ${page.total}`;
}

function listButtons(page: StoryPage, mode: "recommended" | "all" | "trending"): InlineKeyboardButton[][] {
  const itemButtons = page.items.map((story, index) => ({ text: `${index + 1}`, callback_data: callbackData("idea:open", story.id) }));
  const navigation: InlineKeyboardButton[] = [];
  if (page.has_previous) navigation.push({ text: "◀ 이전", callback_data: `ideas:${mode}:${page.page - 1}` });
  if (page.has_next) navigation.push({ text: "다음 ▶", callback_data: `ideas:${mode}:${page.page + 1}` });
  navigation.push({ text: mode === "recommended" ? "📚 전체 소재" : "🔥 추천만 보기", callback_data: mode === "recommended" ? "ideas:all:1" : "ideas:recommended:1" });
  navigation.push({ text: "📈 지금 뜨는 소재", callback_data: "ideas:trending:1" });
  if (mode === "trending") navigation.push({ text: "🔎 더 찾아보기", callback_data: "discovery:more" });
  return [itemButtons, navigation];
}

function renderList(page: StoryPage, mode: "recommended" | "all"): ConsoleView {
  const title = mode === "recommended" ? "🔥 추천 소재" : "📚 오늘 수집된 소재";
  const lines = page.items.map((story, index) => `${index + 1}️⃣ ${story.title} ${editorialTrustLabel(editorialTrustState(story))}\n정보격차 ${score10(story.information_gap_score)} · 훅 ${score10(story.hook_strength)}`);
  return { text: `${pageHeader(title, page)}\n\n${lines.join("\n\n") || "현재 표시할 소재가 없습니다."}`, inline_keyboard: listButtons(page, mode) };
}

export function renderRecommendedList(page: StoryPage, mode: "recommended" | "all" = "recommended"): ConsoleView {
  return renderList(page, mode);
}

export function renderAllStoryList(page: StoryPage): ConsoleView {
  return renderList(page, "all");
}

export function renderTrendingList(page: StoryPage): ConsoleView {
  const lines = page.items.map((story, index) => {
    const state = story.trend_state ?? "STABLE";
    const icon = state === "BREAKING" || state === "HOT" ? "🔥" : state === "RISING" ? "↗" : state === "COOLING" ? "↘" : "→";
    return `${index + 1}. ${story.title}\n🔥 Trend ${story.trend_score ?? "—"} · 📰 Editorial ${story.editorial_score}\n${icon} ${state}\n${story.trend_source_count}개 출처 · ${story.trend_platform_count}개 플랫폼`;
  });
  const empty = page.total === 0 ? "현재 트렌드 소재가 없습니다. 🔎 더 찾아보기를 눌러 새 discovery run을 실행해 보세요." : lines.join("\n\n");
  return { text: `${pageHeader("📈 지금 뜨는 소재", page)}\n\n${empty}`, inline_keyboard: listButtons(page, "trending") };
}

export function renderStoryDetail(story: CanonicalStory): ConsoleView {
  const evidenceSources = unique(story.evidence.map((item) => item.source_name));
  const sourceNames = story.sources.length > 0 ? story.sources : evidenceSources;
  const sourceLine = sourceNames.length > 0 ? sourceNames.join(" / ") : "확인 중";
  const format = story.news_eligible ? "카드뉴스 초안" : "카드뉴스 초안 · 확인 수준 표시";
  return {
    text: `${story.recommended ? "🔥" : "📚"} ${story.title}\n${editorialTrustLabel(editorialTrustState(story))}\n\n${story.summary ?? "현재 상황을 확인하고 있습니다."}\n\n🔥 Trend ${story.trend_score ?? "—"} · 📰 Editorial ${story.editorial_score}\n${story.trend_state ?? "STABLE"} · ${story.trend_source_count}개 출처 · ${story.trend_platform_count}개 플랫폼\n\n정보격차 ${score10(story.information_gap_score)}\n훅 ${score10(story.hook_strength)}\n공유성 ${score10(story.shareability)}\n출처신뢰 ${score10(story.source_confidence)}\n\n추천 포맷:\n${format}\n\n주요 출처: ${sourceLine}`,
    inline_keyboard: [
      [
        { text: "📰 원문/출처", callback_data: callbackData("idea:evidence", story.id) },
        { text: "📱 카드뉴스", callback_data: callbackData("idea:carousel", story.id) },
      ],
      [{ text: "◀ 목록", callback_data: "idea:back:list" }],
    ],
  };
}

export function renderEvidenceView(story: CanonicalStory): ConsoleView {
  const render = (items: readonly EditorialEvidence[]) => items.length === 0 ? "없음" : items.map((item) => `✓ ${item.source_name}\n${item.claim_text}\n상태: ${item.status}${item.canonical_url ? `\n${item.canonical_url}` : ""}`).join("\n\n");
  const discovery = story.evidence.filter((item) => item.editorial_role?.startsWith("DISCOVERY_") === true);
  const fact = story.evidence.filter((item) => item.editorial_role?.startsWith("DISCOVERY_") !== true);
  return {
    text: `🔎 근거\n\n📈 발견 근거\n${render(discovery)}\n\n✅ 팩트 근거\n${render(fact)}`,
    inline_keyboard: [[{ text: "◀ 돌아가기", callback_data: callbackData("idea:open", story.id) }]],
  };
}

export function renderTextReel(story: CanonicalStory): ConsoleView {
  return {
    text: `🎬 TEXT_REEL 초안\n\n0–2초:\n${story.title}\n\n2–5초:\n${story.summary ?? "맨유 관련 새로운 상황"}\n\n5–9초:\n정보격차 ${score10(story.information_gap_score)} · 주요 출처 ${story.source_count}개\n\n9–12초:\n${story.sources[0] ?? "근거 확인 중"}\n\nCTA:\n이 상황, 어떻게 보시나요?`,
    inline_keyboard: [[{ text: "◀ 소재로 돌아가기", callback_data: callbackData("idea:open", story.id) }]],
  };
}

function slideText(slide: EditorialSlide): string {
  return [
    `[${slide.index}장]`,
    slide.headline,
    slide.highlight,
    slide.body,
    slide.closing_line,
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "").join("\n");
}

export function renderCarouselDraft(draft: ManutdEditorCarouselDraft, storyTitle?: string, trustState?: EditorialTrustState, evidence: readonly EditorialEvidence[] = []): ConsoleView {
  const body = draft.slides.map(slideText).join("\n\n");
  const warning = draft.editor_warning ? `\n\n편집자 메모\n${draft.editor_warning}` : "";
  const subject = storyTitle?.trim() ? `\n소재: ${storyTitle.trim()}` : "";
  const trust = trustState ? `\n신뢰 수준: ${editorialTrustLabel(trustState)}` : "";
  const sources = [...new Map(evidence.filter((item) => item.canonical_url).map((item) => [item.canonical_url!, item])).values()];
  const sourceText = sources.length > 0 ? `\n\n출처\n${sources.map((item) => `${item.source_name}: ${item.canonical_url}`).join("\n")}` : "";
  const imageDirections = draft.slides.flatMap((slide) => slide.visual_direction ? [`${slide.index}장: ${slide.visual_direction.subject} · ${slide.visual_direction.image_type} · ${slide.visual_direction.layout_intent}${slide.visual_direction.stat_emphasis ? ` · 강조: ${slide.visual_direction.stat_emphasis}` : ""}`] : []);
  const imageText = imageDirections.length > 0 ? `\n\n이미지 방향\n${imageDirections.join("\n")}` : "";
  const token = draft.creative_brief_id ?? draft.story_id;
  return {
    text: `📱 카드뉴스 초안${subject}${trust}\n\n${body}\n\n캡션\n${draft.caption.body}${draft.caption.cta ? `\n${draft.caption.cta}` : ""}${sourceText}${imageText}${warning}`,
    inline_keyboard: [
      [
        { text: "🔄 다른 훅", callback_data: callbackData("draft:rehook", token) },
        { text: "✏️ 수정", callback_data: callbackData("draft:edit", token) },
        { text: "✅ 초안 선택", callback_data: callbackData("draft:approve", token) },
      ],
      [
        { text: "🔎 근거", callback_data: callbackData("draft:evidence", token) },
        { text: "◀ 소재로 돌아가기", callback_data: "draft:back:list" },
      ],
    ],
  };
}

export function createEditorialConsoleRepository(options: EditorialConsoleRepositoryOptions): EditorialConsoleRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("CONFIGURATION");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const baseHeaders = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}`, accept: "application/json" };

  async function request(path: string, profile?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { headers: { ...baseHeaders, ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}) } });
    } catch {
      throw new Error("NETWORK");
    }
    if (!response.ok) throw new Error("HTTP");
    try {
      return await response.json();
    } catch {
      throw new Error("RESPONSE");
    }
  }

  return {
    async listCanonicalStories(rankingDate) {
      const [rankings, clusters, candidates, clusterSources, claims, claimEvidence, observations, informationSources, briefs, trendSnapshots] = await Promise.all([
        request(`/rest/v1/editorial_rankings?select=story_cluster_id,ranking_date,ranking_version,rank,editorial_score,information_gap_score,fact_grounding_score,discovery_audience_signal_score,grounding_status,news_eligible&ranking_date=eq.${encodeURIComponent(rankingDate)}&order=rank.asc.nullslast,editorial_score.desc`, "app_private"),
        request("/rest/v1/story_clusters?select=id,canonical_title,summary,status,signature_json&status=neq.ARCHIVED"),
        request(`/rest/v1/content_candidates?select=id,story_cluster_id,ranking_date&ranking_date=eq.${encodeURIComponent(rankingDate)}`),
        request("/rest/v1/story_cluster_sources?select=story_cluster_id,information_source_id,information_sources(canonical_name)"),
        request("/rest/v1/story_claims?select=id,story_cluster_id,claim_text,grounding_status", "app_private"),
        request("/rest/v1/claim_evidence?select=claim_id,source_observation_id,evidence_text,is_grounding", "app_private"),
        request("/rest/v1/source_observations?select=id,information_source_id,canonical_url,title,editorial_role", "app_private"),
        request("/rest/v1/information_sources?select=id,canonical_name&limit=500"),
        request("/rest/v1/creative_briefs?select=id,candidate_id,version,status&order=version.desc"),
        request(`/rest/v1/trend_snapshots?select=story_cluster_id,cluster_key,snapshot_at,trend_score,trend_state,source_count,platform_count,opportunity_labels,input_snapshot&snapshot_at=lte.${encodeURIComponent(`${rankingDate}T23:59:59.999Z`)}&order=snapshot_at.desc`, "app_private"),
      ]);

      const clusterById = new Map(array(clusters).flatMap((value) => typeof value.id === "string" && typeof value.canonical_title === "string" ? [[value.id, value]] as const : []));
      const candidateByCluster = new Map<string, string>();
      for (const value of array(candidates)) if (typeof value.id === "string" && typeof value.story_cluster_id === "string") candidateByCluster.set(value.story_cluster_id, value.id);
      const sourceNamesByCluster = new Map<string, string[]>();
      for (const value of array(clusterSources)) {
        const source = object(value.information_sources) ? value.information_sources : null;
        if (typeof value.story_cluster_id !== "string" || !source || typeof source.canonical_name !== "string") continue;
        sourceNamesByCluster.set(value.story_cluster_id, [...(sourceNamesByCluster.get(value.story_cluster_id) ?? []), source.canonical_name]);
      }
      const observationById = new Map<string, JsonObject>();
      for (const value of array(observations)) if (typeof value.id === "string") observationById.set(value.id, value);
      const informationSourceNameById = new Map<string, string>();
      for (const value of array(informationSources)) if (typeof value.id === "string" && typeof value.canonical_name === "string") informationSourceNameById.set(value.id, value.canonical_name);
      const evidenceByClaim = new Map<string, JsonObject[]>();
      for (const value of array(claimEvidence)) if (typeof value.claim_id === "string") evidenceByClaim.set(value.claim_id, [...(evidenceByClaim.get(value.claim_id) ?? []), value]);
      const evidenceByCluster = new Map<string, EditorialEvidence[]>();
      for (const claim of array(claims)) {
        if (typeof claim.id !== "string" || typeof claim.story_cluster_id !== "string" || typeof claim.claim_text !== "string") continue;
        const status = claim.grounding_status === "CONTRADICTED" ? "CONTRADICTED" : claim.grounding_status === "VERIFIED" ? "SUPPORTED" : "REPORTED";
        const related = evidenceByClaim.get(claim.id) ?? [];
        const source = related.find((item) => item.is_grounding === true) ?? related[0];
        const observation = source && typeof source.source_observation_id === "string" ? observationById.get(source.source_observation_id) : undefined;
        const entry: EditorialEvidence = {
          evidence_id: `claim:${claim.id}`,
          source_name: observation && typeof observation.information_source_id === "string" ? informationSourceNameById.get(observation.information_source_id) ?? (typeof observation.title === "string" ? observation.title : "M8 근거") : "M8 근거",
          claim_text: claim.claim_text,
          status,
          canonical_url: observation && typeof observation.canonical_url === "string" ? observation.canonical_url : null,
          editorial_role: observation && typeof observation.editorial_role === "string" ? observation.editorial_role : null,
        };
        evidenceByCluster.set(claim.story_cluster_id, [...(evidenceByCluster.get(claim.story_cluster_id) ?? []), entry]);
      }
      const latestBriefByCandidate = new Map<string, string>();
      for (const value of array(briefs)) if (typeof value.candidate_id === "string" && typeof value.id === "string" && !latestBriefByCandidate.has(value.candidate_id)) latestBriefByCandidate.set(value.candidate_id, value.id);
      const trendByCluster = new Map<string, JsonObject>();
      const trendByFingerprint = new Map<string, JsonObject>();
      for (const value of array(trendSnapshots)) {
        const key = typeof value.story_cluster_id === "string" ? value.story_cluster_id : typeof value.cluster_key === "string" ? value.cluster_key : null;
        if (key && !trendByCluster.has(key)) trendByCluster.set(key, value);
        const inputSnapshot = object(value.input_snapshot) ? value.input_snapshot : {};
        const fingerprints = Array.isArray(inputSnapshot.content_fingerprints) ? inputSnapshot.content_fingerprints.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
        for (const fingerprint of fingerprints) if (!trendByFingerprint.has(fingerprint)) trendByFingerprint.set(fingerprint, value);
      }

      const inputs: EditorialStoryInput[] = [];
      for (const ranking of array(rankings)) {
        if (typeof ranking.story_cluster_id !== "string") continue;
        const cluster = clusterById.get(ranking.story_cluster_id);
        if (!cluster || typeof ranking.ranking_date !== "string" || typeof ranking.ranking_version !== "string" || typeof cluster.canonical_title !== "string") continue;
        if (!isManchesterUnitedRelevant({ canonicalTitle: cluster.canonical_title, summary: cluster.summary, signature: cluster.signature_json })) continue;
        const editorialScore = number(ranking.editorial_score) ?? 0;
        const informationGap = number(ranking.information_gap_score) ?? 0;
        const audienceSignal = number(ranking.discovery_audience_signal_score) ?? 0;
        const candidateId = candidateByCluster.get(ranking.story_cluster_id) ?? null;
        const signature = object(cluster.signature_json) ? cluster.signature_json : {};
        const fingerprints = Array.isArray(signature.content_fingerprints) ? signature.content_fingerprints.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
        const trend = trendByCluster.get(ranking.story_cluster_id) ?? fingerprints.map((fingerprint) => trendByFingerprint.get(fingerprint)).find((value): value is JsonObject => value !== undefined);
        const opportunityLabels = Array.isArray(trend?.opportunity_labels) ? trend.opportunity_labels.filter((value): value is string => typeof value === "string") : [];
        inputs.push({
          story_cluster_id: ranking.story_cluster_id,
          candidate_id: candidateId,
          ranking_date: ranking.ranking_date,
          ranking_version: ranking.ranking_version,
          canonical_title: cluster.canonical_title,
          summary: string(cluster.summary),
          rank: number(ranking.rank),
          editorial_score: editorialScore,
          information_gap_score: informationGap,
          discovery_audience_signal_score: audienceSignal,
          fact_grounding_score: number(ranking.fact_grounding_score) ?? 0,
          grounding_status: string(ranking.grounding_status) ?? "INSUFFICIENT",
          news_eligible: ranking.news_eligible === true,
          source_names: sourceNamesByCluster.get(ranking.story_cluster_id) ?? [],
          evidence: evidenceByCluster.get(ranking.story_cluster_id) ?? [],
          story_fingerprint: `story:${ranking.story_cluster_id}:${ranking.ranking_date}:${ranking.ranking_version}`,
          latest_brief_id: candidateId ? latestBriefByCandidate.get(candidateId) ?? null : null,
          trend_score: number(trend?.trend_score),
          trend_state: string(trend?.trend_state),
          trend_source_count: number(trend?.source_count),
          trend_platform_count: number(trend?.platform_count),
          opportunity_labels: opportunityLabels,
        });
      }
      return buildCanonicalStories(inputs);
    },
    async listTrendingStories(rankingDate) {
      const stories = await this.listCanonicalStories(rankingDate);
      return [...stories]
        .filter((story) => story.trend_score !== null)
        .sort((left, right) => (right.trend_score ?? -1) - (left.trend_score ?? -1) || (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
    },
  };
}
