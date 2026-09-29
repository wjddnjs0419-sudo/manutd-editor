import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { expandDiscoveryQueries } from "../../trend-discovery/query_expansion.ts";

const AS_OF = "2026-09-29T00:00:00.000Z";

Deno.test("FAST profile emits the six core queries and at most five active hot entities", () => {
  const hotEntities = Array.from({ length: 7 }, (_, index) => ({
    canonicalName: `Player ${index + 1}`,
    entityType: "PLAYER" as const,
    trackingTier: "HOT" as const,
    hotUntil: "2026-09-29T03:00:00.000Z",
    nationalTeam: null,
  }));
  const queries = expandDiscoveryQueries({
    asOf: AS_OF,
    searchProfile: "FAST",
    entityContext: { hotEntities },
  });

  assertEquals(queries.slice(0, 6).map((item) => item.text), [
    "Manchester United latest",
    "Manchester United breaking news",
    "Manchester United injury",
    "Manchester United transfer",
    "Manchester United press conference",
    "Manchester United manager",
  ]);
  assertEquals(
    new Set(
      queries.filter((item) => item.entityName).map((item) => item.entityName),
    ).size,
    5,
  );
  assert(queries.every((item) => !item.entityName || item.window === "HOT"));
  assertEquals(
    queries.find((item) => item.entityName)?.windowStart,
    "2026-09-28T21:00:00.000Z",
  );
});

Deno.test("HOT query windows use the recorded six-hour extension ceiling", () => {
  const query = expandDiscoveryQueries({
    asOf: "2026-09-28T23:00:00.000Z",
    searchProfile: "FAST",
    entityContext: {
      hotEntities: [{
        canonicalName: "Bruno Fernandes",
        entityType: "PLAYER",
        trackingTier: "HOT",
        hotStartedAt: "2026-09-28T18:00:00.000Z",
        hotUntil: "2026-09-29T00:00:00.000Z",
      }],
    },
  }).find((item) => item.entityName);
  assertEquals(query?.windowStart, "2026-09-28T17:00:00.000Z");
});

Deno.test("PLAYER_SWEEP emits the quoted United query for every active first-team player", () => {
  const players = [
    "Senne Lammens",
    "Karl Darlow",
    "Tom Heaton",
    "Dermot Mee",
    "Harry Amass",
    "Patrick Dorgu",
    "Diogo Dalot",
    "Matthijs de Ligt",
    "Ayden Heaven",
    "Harry Maguire",
    "Lisandro Martinez",
    "Noussair Mazraoui",
    "Luke Shaw",
    "Leny Yoro",
    "Carlos Baleba",
    "Bruno Fernandes",
    "Jack Fletcher",
    "Tyler Fletcher",
    "Kobbie Mainoo",
    "Mason Mount",
    "Andrey Santos",
    "Youri Tielemans",
    "Manuel Ugarte",
    "Matheus Cunha",
    "Amad",
    "Shea Lacey",
    "Bryan Mbeumo",
    "Marcus Rashford",
    "Benjamin Sesko",
    "Joshua Zirkzee",
  ];
  const queries = expandDiscoveryQueries({
    asOf: AS_OF,
    searchProfile: "PLAYER_SWEEP",
    entityContext: { firstTeamPlayers: players },
    maxQueries: 1,
  });

  assertEquals(queries.length, 30);
  assertEquals(
    queries.map((item) => item.text),
    players.map((player) => `"${player}" "Manchester United"`),
  );
  assert(queries.every((item) => item.family === "PLAYER"));
});

Deno.test("MANUAL profile preserves legacy mode and maxQueries behavior", () => {
  const queries = expandDiscoveryQueries({
    asOf: AS_OF,
    searchProfile: "MANUAL",
    mode: "BREAKING",
    maxQueries: 2,
  });
  assertEquals(queries.length, 2);
  assert(
    queries.every((item) =>
      item.mode === "BREAKING" && item.window === "BREAKING"
    ),
  );
});

Deno.test("unsupported search profiles are rejected instead of expanding as FAST", () => {
  assertThrows(
    () =>
      expandDiscoveryQueries({
        asOf: AS_OF,
        searchProfile: "HOURLY" as never,
      }),
    Error,
    "INVALID_DISCOVERY_SEARCH_PROFILE",
  );
});
