import assert from "node:assert/strict";
import { createGroundingRepository } from "../../ground-claims/repository.ts";

Deno.test("grounding repository joins private observations to public source registry safely", async () => {
  const urls: string[] = [];
  const repository = createGroundingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-secret",
    request: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("source_observations")) return new Response(JSON.stringify([{ id: "observation-1", information_source_id: "source-1", editorial_role: "FACT_PRIMARY", title: "Official update", excerpt: "Manchester United official update", metadata: {} }]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-1", canonical_name: "Manchester United" }]));
      return new Response(JSON.stringify([]));
    },
  });
  const observations = await repository.listObservations();
  assert.deepEqual(observations, [{ id: "observation-1", editorialRole: "FACT_PRIMARY", canonicalName: "Manchester United", title: "Official update", excerpt: "Manchester United official update", relation: "SUPPORTS" }]);
  assert.equal(urls.some((url) => url.includes("information_sources(canonical_name)")), false);
});
