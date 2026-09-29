import type {
  DiscoveryEntityContext,
  DiscoveryEntityType,
  DiscoveryHotEntity,
  DiscoveryTrackingTier,
} from "./types.ts";

export type HotSignalFamily =
  | "INJURY"
  | "TRANSFER"
  | "CONTRACT"
  | "INTERNATIONAL_DUTY";

export interface TrackedEntityRecord {
  readonly id: string;
  readonly entityType: DiscoveryEntityType;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly trackingTier: DiscoveryTrackingTier;
  readonly nationalTeam: string | null;
  readonly injured: boolean;
  readonly hotStartedAt: string | null;
  readonly hotUntil: string | null;
  readonly lastSignalAt: string | null;
  readonly hotSignalFamily?: HotSignalFamily | null;
}

export interface EntityContextMatch {
  readonly opponent: string;
  readonly competition: string;
  readonly kickoffAt: string;
  readonly status: string;
}

export interface EntityContextDataSource {
  listTrackedEntities(): Promise<readonly TrackedEntityRecord[]>;
  listMatches(
    asOf: string,
    recentSince: string,
  ): Promise<readonly EntityContextMatch[]>;
  listRecentlyDetectedEntities(since: string): Promise<readonly string[]>;
  recordEntitySignal?(
    entityId: string,
    family: HotSignalFamily,
    signalAt: string,
  ): Promise<void>;
}

export interface HotEntityWindow {
  readonly hotStartedAt: string;
  readonly hotUntil: string;
  readonly lastSignalAt: string;
}

export function nextHotEntityWindow(
  current:
    | Pick<TrackedEntityRecord, "hotStartedAt" | "hotUntil" | "lastSignalAt">
    | null,
  signalAt: Date | string,
): HotEntityWindow {
  const signalTime = new Date(signalAt).getTime();
  if (!Number.isFinite(signalTime)) {
    throw new Error("INVALID_ENTITY_SIGNAL_TIME");
  }
  const activeStart = current?.hotStartedAt
    ? new Date(current.hotStartedAt).getTime()
    : Number.NaN;
  const activeUntil = current?.hotUntil
    ? new Date(current.hotUntil).getTime()
    : Number.NaN;
  const continuing = Number.isFinite(activeStart) &&
    Number.isFinite(activeUntil) && activeUntil > signalTime;
  const startedAt = continuing ? activeStart : signalTime;
  const defaultUntil = signalTime + 3 * 60 * 60 * 1000;
  const maxUntil = startedAt + 6 * 60 * 60 * 1000;
  const until = continuing
    ? Math.min(maxUntil, Math.max(activeUntil, defaultUntil))
    : defaultUntil;
  return {
    hotStartedAt: new Date(startedAt).toISOString(),
    hotUntil: new Date(until).toISOString(),
    lastSignalAt: new Date(signalTime).toISOString(),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function validTimestamp(value: string): number {
  return new Date(value).getTime();
}

export class EntityContextResolver {
  constructor(private readonly source: EntityContextDataSource) {}

  async resolve(
    asOf: Date | string = new Date(),
  ): Promise<
    DiscoveryEntityContext & {
      readonly hotEntities: readonly DiscoveryHotEntity[];
    }
  > {
    const asOfDate = asOf instanceof Date
      ? new Date(asOf.getTime())
      : new Date(asOf);
    if (!Number.isFinite(asOfDate.getTime())) {
      throw new Error("INVALID_DISCOVERY_AS_OF");
    }
    const asOfIso = asOfDate.toISOString();
    const recentSince = new Date(asOfDate.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString();
    const [entities, matches, recentlyDetectedEntities] = await Promise.all([
      this.source.listTrackedEntities(),
      this.source.listMatches(asOfIso, recentSince),
      this.source.listRecentlyDetectedEntities(
        new Date(asOfDate.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      ),
    ]);
    const activeEntities = entities.filter((entity) => entity.active);
    const firstTeamPlayers = activeEntities
      .filter((entity) =>
        entity.entityType === "PLAYER" && entity.trackingTier === "FIRST_TEAM"
      )
      .map((entity) => entity.canonicalName);
    const manager =
      activeEntities.find((entity) => entity.entityType === "MANAGER")
        ?.canonicalName ?? null;
    const recentMatches = matches.filter((match) =>
      match.status === "FINISHED" &&
      validTimestamp(match.kickoffAt) >= validTimestamp(recentSince) &&
      validTimestamp(match.kickoffAt) <= asOfDate.getTime()
    );
    const upcomingMatches = matches
      .filter((match) =>
        match.status === "SCHEDULED" &&
        validTimestamp(match.kickoffAt) >= asOfDate.getTime()
      )
      .sort((left, right) =>
        validTimestamp(left.kickoffAt) - validTimestamp(right.kickoffAt)
      );
    const hotEntities = activeEntities
      .filter((entity): entity is TrackedEntityRecord & { hotUntil: string } =>
        Boolean(entity.hotUntil) &&
        validTimestamp(entity.hotUntil!) > asOfDate.getTime()
      )
      .map((entity) => ({
        canonicalName: entity.canonicalName,
        entityType: entity.entityType,
        trackingTier: "HOT" as const,
        nationalTeam: entity.nationalTeam,
        hotStartedAt: entity.hotStartedAt,
        hotUntil: entity.hotUntil,
        signalFamily: entity.hotSignalFamily ?? null,
      }))
      .sort((left, right) =>
        right.hotUntil.localeCompare(left.hotUntil) ||
        left.canonicalName.localeCompare(right.canonicalName)
      );

    return {
      manager,
      firstTeamPlayers: unique(firstTeamPlayers),
      injuredPlayers: unique(
        activeEntities.filter((entity) =>
          entity.entityType === "PLAYER" && entity.injured
        ).map((entity) => entity.canonicalName),
      ),
      recentOpponents: unique(recentMatches.map((match) => match.opponent)),
      nextOpponent: upcomingMatches[0]?.opponent ?? null,
      competitions: unique(
        [...recentMatches, ...upcomingMatches].map((match) =>
          match.competition
        ),
      ),
      recentlyDetectedEntities: unique(recentlyDetectedEntities),
      hotEntities,
    };
  }

  async recordMeaningfulSignal(
    entityId: string,
    family: HotSignalFamily,
    signalAt: Date | string,
  ): Promise<void> {
    const at = signalAt instanceof Date
      ? signalAt.toISOString()
      : new Date(signalAt).toISOString();
    if (!Number.isFinite(Date.parse(at))) {
      throw new Error("INVALID_ENTITY_SIGNAL_TIME");
    }
    if (!this.source.recordEntitySignal) {
      throw new Error("ENTITY_SIGNAL_WRITES_UNAVAILABLE");
    }
    await this.source.recordEntitySignal(entityId, family, at);
  }
}

interface SupabaseEntityContextOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly fetch?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function createSupabaseEntityContextDataSource(
  options: SupabaseEntityContextOptions,
): EntityContextDataSource {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) {
    throw new Error("DATABASE_CONFIGURATION_ERROR");
  }
  const base = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  async function get(
    path: string,
    schema: "app_private" | "public",
  ): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      headers: {
        apikey: options.serviceRoleKey,
        authorization: `Bearer ${options.serviceRoleKey}`,
        "accept-profile": schema,
      },
    });
    if (!response.ok) throw new Error("ENTITY_CONTEXT_DATABASE_ERROR");
    const body = await response.text();
    return body.trim() ? JSON.parse(body) : null;
  }
  return {
    async listTrackedEntities() {
      const query = new URLSearchParams({
        select:
          "id,entity_type,canonical_name,aliases,active,tracking_tier,national_team,is_injured,hot_started_at,hot_until,last_signal_at,hot_signal_family",
        active: "eq.true",
        order: "entity_type.asc,canonical_name.asc",
        limit: "500",
      });
      const rows = await get(
        `/rest/v1/tracked_entities?${query}`,
        "app_private",
      );
      if (!Array.isArray(rows)) return [];
      return rows.map((value): TrackedEntityRecord => {
        const row = record(value);
        return {
          id: String(row.id ?? ""),
          entityType: row.entity_type as DiscoveryEntityType,
          canonicalName: String(row.canonical_name ?? ""),
          aliases: stringArray(row.aliases),
          active: row.active === true,
          trackingTier: row.tracking_tier as DiscoveryTrackingTier,
          nationalTeam: typeof row.national_team === "string"
            ? row.national_team
            : null,
          injured: row.is_injured === true,
          hotStartedAt: typeof row.hot_started_at === "string"
            ? row.hot_started_at
            : null,
          hotUntil: typeof row.hot_until === "string" ? row.hot_until : null,
          lastSignalAt: typeof row.last_signal_at === "string"
            ? row.last_signal_at
            : null,
          hotSignalFamily: row.hot_signal_family as HotSignalFamily | null,
        };
      });
    },
    async listMatches(asOf, recentSince) {
      const query = new URLSearchParams({
        select: "opponent,competition,kickoff_at,status",
        or:
          `(and(status.eq.FINISHED,kickoff_at.gte.${recentSince},kickoff_at.lte.${asOf}),and(status.eq.SCHEDULED,kickoff_at.gte.${asOf}))`,
        order: "kickoff_at.asc",
        limit: "100",
      });
      const rows = await get(`/rest/v1/matches?${query}`, "public");
      if (!Array.isArray(rows)) return [];
      return rows.map((value): EntityContextMatch => {
        const row = record(value);
        return {
          opponent: String(row.opponent ?? ""),
          competition: String(row.competition ?? ""),
          kickoffAt: String(row.kickoff_at ?? ""),
          status: String(row.status ?? ""),
        };
      });
    },
    async listRecentlyDetectedEntities(since) {
      const query = new URLSearchParams({
        select: "metadata",
        last_observed_at: `gte.${since}`,
        order: "last_observed_at.desc",
        limit: "200",
      });
      const rows = await get(
        `/rest/v1/discovery_observations?${query}`,
        "app_private",
      );
      if (!Array.isArray(rows)) return [];
      const names: string[] = [];
      for (const value of rows) {
        const metadata = record(record(value).metadata);
        names.push(
          ...stringArray(metadata.entities),
          ...stringArray(metadata.detected_entities),
        );
      }
      return unique(names);
    },
    async recordEntitySignal(entityId, family, signalAt) {
      const response = await fetchImpl(
        `${base}/rest/v1/rpc/mark_tracked_entity_hot`,
        {
          method: "POST",
          headers: {
            apikey: options.serviceRoleKey,
            authorization: `Bearer ${options.serviceRoleKey}`,
            "content-type": "application/json",
            "content-profile": "app_private",
            "accept-profile": "app_private",
          },
          body: JSON.stringify({
            p_entity_id: entityId,
            p_signal_family: family,
            p_signal_at: signalAt,
          }),
        },
      );
      if (!response.ok) throw new Error("ENTITY_CONTEXT_DATABASE_ERROR");
    },
  };
}
