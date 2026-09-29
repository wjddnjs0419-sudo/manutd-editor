import { assertEquals } from "jsr:@std/assert@1.0.8";
import {
  type EntityContextDataSource,
  EntityContextResolver,
  nextHotEntityWindow,
  type TrackedEntityRecord,
} from "../../trend-discovery/entity_context.ts";

const tracked = (
  overrides: Partial<TrackedEntityRecord> = {},
): TrackedEntityRecord => ({
  id: "entity-1",
  entityType: "PLAYER",
  canonicalName: "Bruno Fernandes",
  aliases: ["Bruno"],
  active: true,
  trackingTier: "FIRST_TEAM",
  nationalTeam: "Portugal",
  injured: false,
  hotStartedAt: null,
  hotUntil: null,
  lastSignalAt: null,
  ...overrides,
});

Deno.test("EntityContextResolver returns the complete canonical context and active hot entities", async () => {
  const source: EntityContextDataSource = {
    listTrackedEntities: async () => [
      tracked(),
      tracked({
        id: "manager",
        entityType: "MANAGER",
        canonicalName: "Michael Carrick",
        trackingTier: "BACKGROUND",
      }),
      tracked({ id: "injured", canonicalName: "Luke Shaw", injured: true }),
      tracked({ id: "inactive", canonicalName: "Old Player", active: false }),
      tracked({
        id: "hot",
        canonicalName: "Amad",
        trackingTier: "HOT",
        hotStartedAt: "2026-09-28T23:00:00.000Z",
        hotUntil: "2026-09-29T02:00:00.000Z",
      }),
    ],
    listMatches: async () => [
      {
        opponent: "Arsenal",
        competition: "Premier League",
        kickoffAt: "2026-09-28T18:00:00.000Z",
        status: "FINISHED",
      },
      {
        opponent: "Tottenham",
        competition: "Premier League",
        kickoffAt: "2026-10-01T18:00:00.000Z",
        status: "SCHEDULED",
      },
    ],
    listRecentlyDetectedEntities: async () => ["Carrington", "Amad"],
  };

  const context = await new EntityContextResolver(source).resolve(
    "2026-09-29T00:00:00.000Z",
  );
  assertEquals(context.manager, "Michael Carrick");
  assertEquals(context.firstTeamPlayers, ["Bruno Fernandes", "Luke Shaw"]);
  assertEquals(context.injuredPlayers, ["Luke Shaw"]);
  assertEquals(context.recentOpponents, ["Arsenal"]);
  assertEquals(context.nextOpponent, "Tottenham");
  assertEquals(context.competitions, ["Premier League"]);
  assertEquals(context.recentlyDetectedEntities, ["Carrington", "Amad"]);
  assertEquals(context.hotEntities.map((entity) => entity.canonicalName), [
    "Amad",
  ]);
});

Deno.test("meaningful signals extend hot tracking to at most six hours from the first signal", () => {
  assertEquals(nextHotEntityWindow(null, "2026-09-29T00:00:00.000Z"), {
    hotStartedAt: "2026-09-29T00:00:00.000Z",
    hotUntil: "2026-09-29T03:00:00.000Z",
    lastSignalAt: "2026-09-29T00:00:00.000Z",
  });
  assertEquals(
    nextHotEntityWindow({
      hotStartedAt: "2026-09-29T00:00:00.000Z",
      hotUntil: "2026-09-29T03:00:00.000Z",
      lastSignalAt: "2026-09-29T00:00:00.000Z",
    }, "2026-09-29T02:00:00.000Z"),
    {
      hotStartedAt: "2026-09-29T00:00:00.000Z",
      hotUntil: "2026-09-29T05:00:00.000Z",
      lastSignalAt: "2026-09-29T02:00:00.000Z",
    },
  );
  assertEquals(
    nextHotEntityWindow({
      hotStartedAt: "2026-09-29T00:00:00.000Z",
      hotUntil: "2026-09-29T05:00:00.000Z",
      lastSignalAt: "2026-09-29T02:00:00.000Z",
    }, "2026-09-29T04:00:00.000Z").hotUntil,
    "2026-09-29T06:00:00.000Z",
  );
  assertEquals(
    nextHotEntityWindow({
      hotStartedAt: "2026-09-29T00:00:00.000Z",
      hotUntil: "2026-09-29T06:00:00.000Z",
      lastSignalAt: "2026-09-29T04:00:00.000Z",
    }, "2026-09-29T06:00:00.000Z"),
    {
      hotStartedAt: "2026-09-29T06:00:00.000Z",
      hotUntil: "2026-09-29T09:00:00.000Z",
      lastSignalAt: "2026-09-29T06:00:00.000Z",
    },
  );
});
