import type { GroundingClaim, GroundingClaimPage, GroundingEvidence, GroundingObservation, GroundingPageOptions, GroundingRepository } from "./types.ts";
import { GROUNDING_DEFAULT_LIMIT, GROUNDING_MAX_LIMIT, isGroundingCursor } from "./contract.ts";

interface RepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly request?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): string {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) throw new Error("INVALID_GROUNDING_CURSOR");
  return new TextDecoder().decode(Uint8Array.from(value.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16)));
}

interface AnalysisResume {
  readonly postId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly claimFingerprint: string;
}

function analysisCursor(value: AnalysisResume): string {
  return `a2:${hex(value.postId)}:${hex(value.createdAt)}:${hex(value.id)}:${hex(value.claimFingerprint)}`;
}

function parseAnalysisCursor(cursor: string | null): AnalysisResume | null {
  if (!cursor?.startsWith("a2:")) return null;
  const parts = cursor.split(":");
  if (parts.length !== 5) throw new Error("INVALID_GROUNDING_CURSOR");
  return { postId: unhex(parts[1]!), createdAt: unhex(parts[2]!), id: unhex(parts[3]!), claimFingerprint: unhex(parts[4]!) };
}

export function createGroundingRepository(options: RepositoryOptions): GroundingRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("Database configuration is required");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.request ?? fetch;
  async function request(path: string, init: RequestInit, profile?: string): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { apikey: options.serviceRoleKey, ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}), ...init.headers } });
    if (!response.ok) { await response.body?.cancel(); throw new Error("DATABASE_HTTP_ERROR"); }
    const body = await response.text();
    return body.trim() === "" ? null : JSON.parse(body);
  }
  return {
    async listClaims(input?: GroundingPageOptions | Date): Promise<GroundingClaimPage> {
      const options = input instanceof Date ? { asOf: input } : input ?? {};
      const limit = Number.isInteger(options.limit) && (options.limit ?? 0) >= 1 ? Math.min(options.limit!, GROUNDING_MAX_LIMIT) : GROUNDING_DEFAULT_LIMIT;
      if (options.storyClusterIds?.length === 0) return { claims: [], hasMore: false, nextCursor: null };
      const cursor = options.cursor ?? null;
      if (cursor && !isGroundingCursor(cursor)) throw new Error("INVALID_GROUNDING_CURSOR");
      const resume = parseAnalysisCursor(cursor);
      const scope = options.storyClusterIds ? `in.(${options.storyClusterIds.join(",")})` : null;
      const scopedIds = options.storyClusterIds ? new Set(options.storyClusterIds) : null;
      const asOf = options.asOf?.toISOString();
      const collected: { key: string; cursor: string; claim: GroundingClaim }[] = [];
      const seenKeys = new Set<string>();
      const get = async (table: string, parameters: URLSearchParams, profile?: string): Promise<unknown> =>
        await request(`/rest/v1/${table}?${parameters}`, { method: "GET" }, profile);

      // Extracted claims are ordered by post, analysis row, and fingerprint.
      // Analysis rows have their own bounded scan budget so a single post cannot
      // turn one Edge invocation into an unbounded historical replay.
      if (!cursor?.startsWith("d:")) {
        let lastPost = resume?.postId ?? (cursor ? cursor.split(":")[1] : null);
        let includeCursorPost = Boolean(resume || cursor?.startsWith("a:"));
        let postsScanned = 0;
        let analysisRowsScanned = 0;
        let analysisContinuation: string | null = null;
        const postScanLimit = 25;
        const analysisScanLimit = 100;
        while (collected.length <= limit) {
          const membershipLimit = Math.min(limit + 1, postScanLimit - postsScanned);
          const membershipQuery = new URLSearchParams({ select: "story_cluster_id,raw_post_id", order: "raw_post_id.asc", limit: String(membershipLimit) });
          if (scope) membershipQuery.set("story_cluster_id", scope);
          if (asOf) membershipQuery.set("created_at", `lte.${asOf}`);
          if (lastPost) membershipQuery.set("raw_post_id", `${includeCursorPost ? "gte" : "gt"}.${lastPost}`);
          const memberships = await get("story_cluster_posts", membershipQuery);
          if (!Array.isArray(memberships) || memberships.length === 0) break;
          let progressed = false;
          const ordered = memberships.filter((item) => record(item) && string(item.raw_post_id) && string(item.story_cluster_id) && (!scopedIds || scopedIds.has(item.story_cluster_id as string)))
            .sort((a, b) => String(a.raw_post_id) < String(b.raw_post_id) ? -1 : String(a.raw_post_id) > String(b.raw_post_id) ? 1 : 0);
          for (const membership of ordered) {
            const postId = membership.raw_post_id as string;
            if (lastPost && (postId < lastPost || (!includeCursorPost && postId === lastPost))) continue;
            progressed = true;
            postsScanned += 1;
            const clusterId = membership.story_cluster_id as string;
            const byKey = new Map<string, { cursor: string; claim: GroundingClaim }>();
            let analysisAfter: { id: string; createdAt: string } | null = resume?.postId === postId ? { id: resume.id, createdAt: resume.createdAt } : null;
            let includeAnalysisAnchor = Boolean(resume?.postId === postId);
            let resumeCursor: string | null = resume?.postId === postId ? cursor : null;
            while (true) {
              const remaining = analysisScanLimit - analysisRowsScanned;
              if (remaining <= 0) {
                if (!resumeCursor) throw new Error("GROUNDING_ANALYSIS_CURSOR_INVALID");
                analysisContinuation = resumeCursor;
                break;
              }
              const analysisLimit = Math.min(100, remaining);
              const analysisQuery = new URLSearchParams({ select: "id,created_at,raw_post_id,claims", raw_post_id: `eq.${postId}`, status: "in.(SUCCEEDED,PARTIAL)", order: "created_at.asc,id.asc", limit: String(analysisLimit) });
              if (analysisAfter) {
                analysisQuery.set("or", includeAnalysisAnchor
                  ? `(created_at.gt.${analysisAfter.createdAt},and(created_at.eq.${analysisAfter.createdAt},id.gte.${analysisAfter.id}))`
                  : `(created_at.gt.${analysisAfter.createdAt},and(created_at.eq.${analysisAfter.createdAt},id.gt.${analysisAfter.id}))`);
              }
              if (asOf) analysisQuery.set("created_at", `lte.${asOf}`);
              const analyses = await get("content_understandings", analysisQuery, "app_private");
              if (!Array.isArray(analyses) || analyses.length === 0) break;
              analysisRowsScanned += analyses.length;
              for (const analysis of analyses) {
                if (!record(analysis) || analysis.raw_post_id !== postId || !Array.isArray(analysis.claims)) continue;
                const analysisId = string(analysis.id);
                const createdAt = string(analysis.created_at);
                if (!analysisId || !createdAt) continue;
                analysisAfter = { id: analysisId, createdAt };
                includeAnalysisAnchor = false;
                resumeCursor = analysisCursor({ postId, createdAt, id: analysisId, claimFingerprint: "" });
                const rowFingerprints: string[] = [];
                for (const item of analysis.claims) {
                  if (!record(item)) continue;
                  const subject = string(item.subject); const predicate = string(item.predicate); const object = string(item.object); const claimText = string(item.text);
                  if (!subject || !predicate || !object || !claimText) continue;
                  const claimFingerprint = await fingerprint({ clusterId, rawPostId: postId, subject, predicate, object, claimText });
                  const key = `a:${postId}:${claimFingerprint}`;
                  if (cursor?.startsWith("a:") && key <= cursor) continue;
                  if (resume && resume.postId === postId && resume.createdAt === createdAt && resume.id === analysisId && claimFingerprint <= resume.claimFingerprint) continue;
                  rowFingerprints.push(claimFingerprint);
                  const origin = item.origin === "image" || item.origin === "carousel_slide" || item.origin === "thumbnail" ? item.origin : "caption";
                  const itemCursor = analysisCursor({ postId, createdAt, id: analysisId, claimFingerprint });
                  if (!byKey.has(key)) byKey.set(key, { cursor: itemCursor, claim: { storyClusterId: clusterId, rawPostId: postId, claimFingerprint, subject, predicate, object, claimText, origin, extractionConfidence: number(item.confidence) } });
                }
                const lastFingerprint = [...rowFingerprints].sort().at(-1);
                if (lastFingerprint) resumeCursor = analysisCursor({ postId, createdAt, id: analysisId, claimFingerprint: lastFingerprint });
              }
              if (byKey.size > limit || analysisRowsScanned >= analysisScanLimit) {
                if (byKey.size <= limit && !resumeCursor) throw new Error("GROUNDING_ANALYSIS_CURSOR_INVALID");
                if (byKey.size <= limit) analysisContinuation = resumeCursor;
                break;
              }
              if (analyses.length < analysisLimit) break;
            }
            for (const [key, value] of [...byKey].sort(([, a], [, b]) => a.cursor < b.cursor ? -1 : a.cursor > b.cursor ? 1 : 0)) {
              if (!seenKeys.has(key)) { seenKeys.add(key); collected.push({ key, cursor: value.cursor, claim: value.claim }); }
              if (collected.length > limit) break;
            }
            lastPost = postId;
            includeCursorPost = false;
            if (collected.length > limit || analysisContinuation) break;
          }
          if (collected.length > limit || analysisContinuation) break;
          // A post cursor is exclusive: every claim in this post was collected.
          // Returning it even on an empty page prevents empty memberships from
          // turning a small claim batch into an unbounded scan.
          if (postsScanned >= postScanLimit) return { claims: collected.map((item) => item.claim), hasMore: true, nextCursor: `p:${lastPost}` };
          if (!progressed || ordered.length < membershipLimit) break;
        }
        if (analysisContinuation) {
          return { claims: collected.map((item) => item.claim), hasMore: true, nextCursor: analysisContinuation };
        }
      }

      if (collected.length <= limit) {
        let lastId = cursor?.startsWith("d:") ? cursor.slice(2) : null;
        let discoveryRowsScanned = 0;
        const discoveryScanLimit = 500;
        while (collected.length <= limit && discoveryRowsScanned < discoveryScanLimit) {
          const discoveryLimit = Math.min(limit + 1 - collected.length, discoveryScanLimit - discoveryRowsScanned);
          const discoveryQuery = new URLSearchParams({ select: "id,story_cluster_id,raw_post_id,discovery_observation_id,claim_fingerprint,subject,predicate,object,claim_text,origin,extraction_confidence", discovery_observation_id: "not.is.null", order: "id.asc", limit: String(discoveryLimit) });
          if (scope) discoveryQuery.set("story_cluster_id", scope);
          if (asOf) discoveryQuery.set("created_at", `lte.${asOf}`);
          if (lastId) discoveryQuery.set("id", `gt.${lastId}`);
          const rows = await get("story_claims", discoveryQuery, "app_private");
          if (!Array.isArray(rows) || rows.length === 0) break;
          discoveryRowsScanned += rows.length;
          let progressed = false;
          for (const item of rows.filter(record).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) {
            const id = string(item.id);
            if (!id || (lastId && id <= lastId)) continue;
            progressed = true;
            lastId = id;
            const storyClusterId = string(item.story_cluster_id);
            const claimFingerprint = string(item.claim_fingerprint);
            const subject = string(item.subject);
            const predicate = string(item.predicate);
            const object = string(item.object);
            const claimText = string(item.claim_text);
            if (!storyClusterId || (scopedIds && !scopedIds.has(storyClusterId)) || !claimFingerprint || !subject || !predicate || !object || !claimText) continue;
            const rawPostId = string(item.raw_post_id);
            const discoveryObservationId = string(item.discovery_observation_id);
            if (!discoveryObservationId) continue;
            const key = `d:${id}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            const origin = item.origin === "image" || item.origin === "carousel_slide" || item.origin === "thumbnail" ? item.origin : rawPostId ? "caption" : "discovery_observation";
            collected.push({ key, cursor: key, claim: { storyClusterId, rawPostId, discoveryObservationId, claimFingerprint, subject, predicate, object, claimText, origin, extractionConfidence: number(item.extraction_confidence) } });
            if (collected.length > limit) break;
          }
          if (collected.length > limit || !progressed || rows.length < discoveryLimit) break;
        }
        if (collected.length <= limit && discoveryRowsScanned >= discoveryScanLimit && lastId) {
          return { claims: collected.map((item) => item.claim), hasMore: true, nextCursor: `d:${lastId}` };
        }
      }
      const page = collected.slice(0, limit);
      const hasMore = collected.length > limit;
      return { claims: page.map((item) => item.claim), hasMore, nextCursor: hasMore ? page.at(-1)?.cursor ?? null : null };
    },
    async listObservations(asOf?: Date) {
      const observationQuery = new URLSearchParams({ select: "id,information_source_id,editorial_role,title,excerpt,metadata", order: "created_at.desc,id.desc", limit: "500" });
      if (asOf) observationQuery.set("created_at", `lte.${asOf.toISOString()}`);
      const [value, sources] = await Promise.all([
        request(`/rest/v1/source_observations?${observationQuery}`, { method: "GET" }, "app_private"),
        request("/rest/v1/information_sources?select=id,canonical_name&limit=500", { method: "GET" }),
      ]);
      if (!Array.isArray(value)) return [];
      const sourceNames = new Map<string, string>();
      if (Array.isArray(sources)) for (const source of sources) if (record(source) && typeof source.id === "string" && typeof source.canonical_name === "string") sourceNames.set(source.id, source.canonical_name);
      return value.flatMap((item): GroundingObservation[] => {
        if (!record(item) || typeof item.id !== "string" || typeof item.editorial_role !== "string" || typeof item.title !== "string") return [];
        const metadata = record(item.metadata) ? item.metadata : {};
        const relation = metadata.relation === "CONTRADICTS" ? "CONTRADICTS" : "SUPPORTS";
        return [{ id: item.id, editorialRole: item.editorial_role as GroundingObservation["editorialRole"], canonicalName: typeof item.information_source_id === "string" ? sourceNames.get(item.information_source_id) ?? "Unknown source" : "Unknown source", title: item.title, excerpt: string(item.excerpt), relation }];
      });
    },
    async upsertClaim(claim, version) {
      const value = await request("/rest/v1/story_claims?on_conflict=story_cluster_id%2Cclaim_fingerprint%2Cgrounding_version", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ story_cluster_id: claim.storyClusterId, raw_post_id: claim.rawPostId, discovery_observation_id: claim.discoveryObservationId ?? null, claim_fingerprint: claim.claimFingerprint, subject: claim.subject, predicate: claim.predicate, object: claim.object, claim_text: claim.claimText, origin: claim.origin, extraction_confidence: claim.extractionConfidence, grounding_status: claim.status, grounding_confidence: claim.confidence, grounding_version: version, decision_reason: claim.decisionReason }) }, "app_private");
      if (!Array.isArray(value) || !record(value[0]) || typeof value[0].id !== "string") throw new Error("CLAIM_PERSISTENCE_ERROR");
      return value[0].id;
    },
    async upsertEvidence(claimId, evidence: GroundingEvidence) {
      await this.upsertEvidenceBatch(claimId, [evidence]);
    },
    async upsertEvidenceBatch(claimId, evidence: readonly GroundingEvidence[]) {
      const batchSize = 100;
      for (let offset = 0; offset < evidence.length; offset += batchSize) {
        const rows = evidence.slice(offset, offset + batchSize).map((item) => ({
          claim_id: claimId,
          source_observation_id: item.sourceObservationId,
          relation: item.relation,
          editorial_role: item.editorialRole,
          evidence_text: item.evidenceText,
          evidence_confidence: item.evidenceConfidence,
          is_grounding: item.isGrounding,
        }));
        await request("/rest/v1/claim_evidence?on_conflict=claim_id%2Csource_observation_id%2Crelation", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) }, "app_private");
      }
    },
  };
}
