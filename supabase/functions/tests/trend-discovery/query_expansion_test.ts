import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.8";
import { expandDiscoveryQueries, type QueryExpansionInput } from "../../trend-discovery/query_expansion.ts";

const input: QueryExpansionInput = {
  asOf: new Date("2026-09-27T12:00:00.000Z"),
  mode: "GENERAL",
  entityContext: {
    manager: "Ruben Amorim",
    firstTeamPlayers: ["Bruno Fernandes", "Kobbie Mainoo"],
    injuredPlayers: ["Luke Shaw"],
    recentOpponents: ["Manchester City"],
    nextOpponent: "Arsenal",
    competitions: ["Premier League", "Europa League"],
    recentlyDetectedEntities: ["Carrington", "INEOS"],
  },
};

Deno.test("expands bounded base families and refreshable entity context", () => {
  const queries = expandDiscoveryQueries(input);
  assert(queries.length <= 32);
  assert(queries.some((query) => query.family === "LATEST" && query.text === "Manchester United latest"));
  assert(queries.some((query) => query.text.includes("Ruben Amorim")));
  assert(queries.some((query) => query.text.includes("Luke Shaw")));
  assert(queries.some((query) => query.text.includes("Arsenal")));
  assert(queries.some((query) => query.text.includes("Carrington")));
});

Deno.test("query IDs are stable and mode windows are deterministic", () => {
  const first = expandDiscoveryQueries(input);
  const second = expandDiscoveryQueries({ ...input, asOf: new Date(input.asOf) });
  assertEquals(first.map((query) => query.queryId), second.map((query) => query.queryId));
  assertEquals(first.map((query) => query.window), second.map((query) => query.window));
  assert(first.every((query) => query.queryId.startsWith("m85:")));
  assertMatch(first.find((query) => query.family === "LATEST")?.windowStart ?? "", /2026-09-26T12:00:00.000Z/u);
});

Deno.test("bounded modes focus their query families and observation windows", () => {
  const breaking = expandDiscoveryQueries({ ...input, mode: "BREAKING" });
  const community = expandDiscoveryQueries({ ...input, mode: "COMMUNITY" });
  assert(breaking.every((query) => query.window === "BREAKING"));
  assert(breaking.some((query) => query.family === "BREAKING"));
  assert(community.every((query) => query.window === "CURRENT" || query.window === "HOT"));
  assert(community.some((query) => query.family === "REDDIT" || query.family === "FAN_REACTION"));
});
