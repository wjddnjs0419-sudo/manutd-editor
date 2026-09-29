import type { GroundingClaim, GroundingEvidence, GroundingObservation, GroundingRepository } from "./types.ts";

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
    async listClaims() {
      const memberships = await request("/rest/v1/story_cluster_posts?select=story_cluster_id,raw_post_id&limit=500", { method: "GET" });
      const clusterByPost = new Map<string, string>();
      if (Array.isArray(memberships)) for (const item of memberships) if (record(item) && typeof item.raw_post_id === "string" && typeof item.story_cluster_id === "string") clusterByPost.set(item.raw_post_id, item.story_cluster_id);
      const analyses = await request("/rest/v1/content_understandings?select=raw_post_id,claims&status=in.(SUCCEEDED,PARTIAL)&order=created_at.desc&limit=500", { method: "GET" }, "app_private");
      const discoveryClaims = await request("/rest/v1/story_claims?select=id,story_cluster_id,raw_post_id,discovery_observation_id,claim_fingerprint,subject,predicate,object,claim_text,origin,extraction_confidence&discovery_observation_id=not.is.null&order=updated_at.desc&limit=2000", { method: "GET" }, "app_private");
      const claims: GroundingClaim[] = [];
      if (Array.isArray(analyses)) for (const analysis of analyses) {
        if (!record(analysis) || typeof analysis.raw_post_id !== "string") continue;
        const clusterId = clusterByPost.get(analysis.raw_post_id);
        if (!clusterId || !Array.isArray(analysis.claims)) continue;
        for (const item of analysis.claims) {
          if (!record(item)) continue;
          const subject = string(item.subject); const predicate = string(item.predicate); const object = string(item.object); const claimText = string(item.text);
          if (!subject || !predicate || !object || !claimText) continue;
          const origin = item.origin === "image" || item.origin === "carousel_slide" || item.origin === "thumbnail" ? item.origin : "caption";
          claims.push({ storyClusterId: clusterId, rawPostId: analysis.raw_post_id, claimFingerprint: await fingerprint({ clusterId, rawPostId: analysis.raw_post_id, subject, predicate, object, claimText }), subject, predicate, object, claimText, origin, extractionConfidence: number(item.confidence) });
        }
      }
      if (Array.isArray(discoveryClaims)) for (const item of discoveryClaims) {
        if (!record(item) || typeof item.story_cluster_id !== "string" || typeof item.claim_fingerprint !== "string" || typeof item.subject !== "string" || typeof item.predicate !== "string" || typeof item.object !== "string" || typeof item.claim_text !== "string") continue;
        const rawPostId = typeof item.raw_post_id === "string" ? item.raw_post_id : null;
        const discoveryObservationId = typeof item.discovery_observation_id === "string" ? item.discovery_observation_id : null;
        if (!rawPostId && !discoveryObservationId) continue;
        const origin = item.origin === "image" || item.origin === "carousel_slide" || item.origin === "thumbnail" ? item.origin : rawPostId ? "caption" : "discovery_observation";
        claims.push({ storyClusterId: item.story_cluster_id, rawPostId, discoveryObservationId, claimFingerprint: item.claim_fingerprint, subject: item.subject, predicate: item.predicate, object: item.object, claimText: item.claim_text, origin, extractionConfidence: number(item.extraction_confidence) });
      }
      return claims;
    },
    async listObservations() {
      const [value, sources] = await Promise.all([
        request("/rest/v1/source_observations?select=id,information_source_id,editorial_role,title,excerpt,metadata&order=observed_at.desc&limit=500", { method: "GET" }, "app_private"),
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
      await request("/rest/v1/claim_evidence?on_conflict=claim_id%2Csource_observation_id%2Crelation", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ claim_id: claimId, source_observation_id: evidence.sourceObservationId, relation: evidence.relation, editorial_role: evidence.editorialRole, evidence_text: evidence.evidenceText, evidence_confidence: evidence.evidenceConfidence, is_grounding: evidence.isGrounding }) }, "app_private");
    },
  };
}
