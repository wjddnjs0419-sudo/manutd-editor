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
      const claims: GroundingClaim[] = [];
      if (!Array.isArray(analyses)) return claims;
      for (const analysis of analyses) {
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
      return claims;
    },
    async listObservations() {
      const value = await request("/rest/v1/source_observations?select=id,editorial_role,title,excerpt,metadata,information_sources(canonical_name)&order=observed_at.desc&limit=500", { method: "GET" }, "app_private");
      if (!Array.isArray(value)) return [];
      return value.flatMap((item): GroundingObservation[] => {
        if (!record(item) || typeof item.id !== "string" || typeof item.editorial_role !== "string" || typeof item.title !== "string") return [];
        const source = record(item.information_sources) ? item.information_sources : null;
        const metadata = record(item.metadata) ? item.metadata : {};
        const relation = metadata.relation === "CONTRADICTS" ? "CONTRADICTS" : "SUPPORTS";
        return [{ id: item.id, editorialRole: item.editorial_role as GroundingObservation["editorialRole"], canonicalName: typeof source?.canonical_name === "string" ? source.canonical_name : "Unknown source", title: item.title, excerpt: string(item.excerpt), relation }];
      });
    },
    async upsertClaim(claim, version) {
      const value = await request("/rest/v1/story_claims?on_conflict=story_cluster_id%2Cclaim_fingerprint%2Cgrounding_version", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ story_cluster_id: claim.storyClusterId, raw_post_id: claim.rawPostId, claim_fingerprint: claim.claimFingerprint, subject: claim.subject, predicate: claim.predicate, object: claim.object, claim_text: claim.claimText, origin: claim.origin, extraction_confidence: claim.extractionConfidence, grounding_status: claim.status, grounding_confidence: claim.confidence, grounding_version: version, decision_reason: claim.decisionReason }) }, "app_private");
      if (!Array.isArray(value) || !record(value[0]) || typeof value[0].id !== "string") throw new Error("CLAIM_PERSISTENCE_ERROR");
      return value[0].id;
    },
    async upsertEvidence(claimId, evidence: GroundingEvidence) {
      await request("/rest/v1/claim_evidence?on_conflict=claim_id%2Csource_observation_id%2Crelation", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ claim_id: claimId, source_observation_id: evidence.sourceObservationId, relation: evidence.relation, editorial_role: evidence.editorialRole, evidence_text: evidence.evidenceText, evidence_confidence: evidence.evidenceConfidence, is_grounding: evidence.isGrounding }) }, "app_private");
    },
  };
}
