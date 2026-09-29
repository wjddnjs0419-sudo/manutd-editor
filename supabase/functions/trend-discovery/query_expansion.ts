import type {
  DiscoveryEntityContext,
  DiscoveryMode,
  DiscoveryQuery,
  DiscoveryQueryFamily,
  DiscoverySearchProfile,
  DiscoveryWindow,
  QueryExpansionInput,
} from "./types.ts";

export type { QueryExpansionInput } from "./types.ts";

interface FamilyDefinition {
  readonly family: DiscoveryQueryFamily;
  readonly text: string;
  readonly window: DiscoveryWindow;
  readonly priority: number;
  readonly windowHours?: number;
}

interface ProfileDefinition extends FamilyDefinition {
  readonly entityName?: string;
}

const BASE_FAMILIES: readonly FamilyDefinition[] = [
  {
    family: "LATEST",
    text: "Manchester United latest",
    window: "CURRENT",
    priority: 100,
  },
  {
    family: "BREAKING",
    text: "Manchester United breaking news",
    window: "BREAKING",
    priority: 100,
  },
  {
    family: "TRENDING",
    text: "Manchester United trending",
    window: "HOT",
    priority: 95,
  },
  {
    family: "INJURY",
    text: "Manchester United injury",
    window: "CURRENT",
    priority: 90,
  },
  {
    family: "TRANSFER",
    text: "Manchester United transfer",
    window: "CURRENT",
    priority: 90,
  },
  {
    family: "MANAGER",
    text: "Manchester United manager",
    window: "CURRENT",
    priority: 85,
  },
  {
    family: "TACTICS",
    text: "Manchester United tactics",
    window: "CURRENT",
    priority: 75,
  },
  {
    family: "STATS",
    text: "Manchester United stats",
    window: "CURRENT",
    priority: 70,
  },
  {
    family: "CONTROVERSY",
    text: "Manchester United controversy",
    window: "HOT",
    priority: 85,
  },
  {
    family: "FAN_REACTION",
    text: "Manchester United fan reaction",
    window: "HOT",
    priority: 85,
  },
  {
    family: "REDDIT",
    text: "Manchester United Reddit",
    window: "HOT",
    priority: 80,
  },
  {
    family: "ACADEMY",
    text: "Manchester United academy",
    window: "CURRENT",
    priority: 65,
  },
  {
    family: "INTERVIEW",
    text: "Manchester United interview",
    window: "CURRENT",
    priority: 70,
  },
  {
    family: "PRESS_CONFERENCE",
    text: "Manchester United press conference",
    window: "BREAKING",
    priority: 90,
  },
  {
    family: "NEXT_MATCH",
    text: "Manchester United next match",
    window: "CURRENT",
    priority: 90,
  },
];

const MODE_FAMILIES: Readonly<
  Record<DiscoveryMode, readonly DiscoveryQueryFamily[]>
> = {
  GENERAL: BASE_FAMILIES.map((item) => item.family),
  BREAKING: [
    "LATEST",
    "BREAKING",
    "TRENDING",
    "INJURY",
    "TRANSFER",
    "MANAGER",
    "PRESS_CONFERENCE",
  ],
  TRANSFERS: ["LATEST", "BREAKING", "TRANSFER", "MANAGER", "FAN_REACTION"],
  MATCH: [
    "LATEST",
    "NEXT_MATCH",
    "TACTICS",
    "STATS",
    "FAN_REACTION",
    "PRESS_CONFERENCE",
  ],
  PLAYERS: ["LATEST", "INJURY", "STATS", "INTERVIEW", "FAN_REACTION", "PLAYER"],
  COMMUNITY: ["TRENDING", "CONTROVERSY", "FAN_REACTION", "REDDIT"],
};

const WINDOW_HOURS: Record<DiscoveryWindow, number> = {
  BREAKING: 3,
  HOT: 12,
  CURRENT: 24,
  BACKGROUND: 72,
};

function validDate(value: Date | string): Date {
  const result = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new Error("INVALID_DISCOVERY_AS_OF");
  }
  return result;
}

function clean(
  values: readonly (string | null | undefined)[] | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value?.trim() ?? "").filter((value) =>
        value.length > 0
      ),
    ),
  ].slice(0, 8);
}

function cleanAll(
  values: readonly (string | null | undefined)[] | undefined,
): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value?.trim() ?? "").filter((value) =>
        value.length > 0
      ),
    ),
  ].slice(0, 64);
}

function slug(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9가-힣]+/gu, "-")
    .replace(/^-|-$/gu, "").slice(0, 80);
}

function query(
  mode: DiscoveryMode,
  asOf: Date,
  definition: FamilyDefinition,
  text: string,
  searchProfile?: DiscoverySearchProfile,
  entityName?: string,
): DiscoveryQuery {
  const windowHours = definition.windowHours ?? WINDOW_HOURS[definition.window];
  const normalizedText = text.replace(/\s+/gu, " ").trim();
  return {
    queryId: `${
      searchProfile && searchProfile !== "MANUAL"
        ? `m86:${searchProfile.toLocaleLowerCase("en-US")}`
        : `m85:${mode.toLocaleLowerCase("en-US")}`
    }:${definition.family.toLocaleLowerCase("en-US")}:${slug(normalizedText)}`,
    text: normalizedText,
    family: definition.family,
    mode,
    window: definition.window,
    windowStart: new Date(asOf.getTime() - windowHours * 60 * 60 * 1000)
      .toISOString(),
    windowEnd: asOf.toISOString(),
    priority: definition.priority,
    ...(searchProfile ? { searchProfile } : {}),
    ...(entityName ? { entityName } : {}),
  };
}

function quoted(value: string): string {
  return `"${value.replaceAll('"', "").replace(/\s+/gu, " ").trim()}"`;
}

function profileQueries(
  input: QueryExpansionInput,
  asOf: Date,
  mode: DiscoveryMode,
): DiscoveryQuery[] {
  const profile = input.searchProfile ?? "MANUAL";
  if (profile === "MANUAL") return [];

  if (profile === "PLAYER_SWEEP") {
    return cleanAll(input.entityContext?.firstTeamPlayers).map((
      player,
      index,
    ) =>
      query(
        mode,
        asOf,
        {
          family: "PLAYER",
          text: `${quoted(player)} ${quoted("Manchester United")}`,
          window: "CURRENT",
          priority: 100 - index,
        },
        `${quoted(player)} ${quoted("Manchester United")}`,
        profile,
        player,
      )
    );
  }

  const core: ProfileDefinition[] = [
    {
      family: "LATEST",
      text: "Manchester United latest",
      window: "CURRENT",
      priority: 100,
    },
    {
      family: "BREAKING",
      text: "Manchester United breaking news",
      window: "BREAKING",
      priority: 99,
    },
    {
      family: "INJURY",
      text: "Manchester United injury",
      window: "CURRENT",
      priority: 98,
    },
    {
      family: "TRANSFER",
      text: "Manchester United transfer",
      window: "CURRENT",
      priority: 97,
    },
    {
      family: "PRESS_CONFERENCE",
      text: "Manchester United press conference",
      window: "BREAKING",
      priority: 96,
    },
    {
      family: "MANAGER",
      text: "Manchester United manager",
      window: "CURRENT",
      priority: 95,
    },
  ];
  const result = core.map((definition) =>
    query(mode, asOf, definition, definition.text, profile)
  );
  const now = asOf.getTime();
  const hotEntities = [...(input.entityContext?.hotEntities ?? [])]
    .filter((entity) =>
      entity.trackingTier === "HOT" &&
      Number.isFinite(Date.parse(entity.hotUntil)) &&
      Date.parse(entity.hotUntil) > now
    )
    .sort((left, right) =>
      right.hotUntil.localeCompare(left.hotUntil) ||
      left.canonicalName.localeCompare(right.canonicalName)
    )
    .slice(0, 5);

  let priority = 90;
  for (const entity of hotEntities) {
    const name = quoted(entity.canonicalName);
    const startedAt = entity.hotStartedAt
      ? Date.parse(entity.hotStartedAt)
      : Number.NaN;
    const until = Date.parse(entity.hotUntil);
    const hotWindowHours = Number.isFinite(startedAt) && until > startedAt
      ? Math.min(6, Math.max(3, (until - startedAt) / 3_600_000))
      : 3;
    const variants: Array<{ family: DiscoveryQueryFamily; text: string }> =
      entity.entityType === "PLAYER"
        ? [
          { family: "INJURY", text: `${name} injury` },
          { family: "PLAYER", text: `${name} ${quoted("Manchester United")}` },
          { family: "TRANSFER", text: `${name} transfer` },
          { family: "ENTITY", text: `${name} contract` },
          ...(entity.nationalTeam?.trim()
            ? [{
              family: "ENTITY" as const,
              text: `${name} ${quoted(entity.nationalTeam.trim())}`,
            }]
            : []),
        ]
        : [
          { family: "ENTITY", text: `${name} ${quoted("Manchester United")}` },
          { family: "TRANSFER", text: `${name} transfer` },
          { family: "ENTITY", text: `${name} contract` },
        ];
    for (const variant of variants) {
      result.push(
        query(
          mode,
          asOf,
          {
            ...variant,
            window: "HOT",
            windowHours: hotWindowHours,
            priority: priority--,
          },
          variant.text,
          profile,
          entity.canonicalName,
        ),
      );
    }
  }

  const requestedMaximum = input.maxQueries ?? 32;
  return result.slice(0, Math.max(core.length, requestedMaximum));
}

function dynamicDefinitions(
  context: DiscoveryEntityContext | undefined,
): FamilyDefinition[] {
  const result: FamilyDefinition[] = [];
  for (const player of clean(context?.firstTeamPlayers)) {
    result.push({
      family: "PLAYER",
      text: `Manchester United ${player}`,
      window: "CURRENT",
      priority: 78,
    });
  }
  for (const player of clean(context?.injuredPlayers)) {
    result.push({
      family: "INJURY",
      text: `Manchester United ${player} injury`,
      window: "HOT",
      priority: 92,
    });
  }
  for (const opponent of clean(context?.recentOpponents)) {
    result.push({
      family: "OPPONENT",
      text: `Manchester United ${opponent}`,
      window: "CURRENT",
      priority: 78,
    });
  }
  for (const competition of clean(context?.competitions)) {
    result.push({
      family: "COMPETITION",
      text: `Manchester United ${competition}`,
      window: "CURRENT",
      priority: 72,
    });
  }
  for (const entity of clean(context?.recentlyDetectedEntities)) {
    result.push({
      family: "ENTITY",
      text: `Manchester United ${entity}`,
      window: "HOT",
      priority: 80,
    });
  }
  if (context?.manager?.trim()) {
    result.push({
      family: "MANAGER",
      text: `Manchester United ${context.manager.trim()}`,
      window: "CURRENT",
      priority: 90,
    });
  }
  if (context?.nextOpponent?.trim()) {
    result.push({
      family: "NEXT_MATCH",
      text: `Manchester United ${context.nextOpponent.trim()}`,
      window: "CURRENT",
      priority: 94,
    });
  }
  return result;
}

function modeDefinitions(mode: DiscoveryMode): FamilyDefinition[] {
  const allowed = new Set(MODE_FAMILIES[mode]);
  return BASE_FAMILIES.filter((definition) => allowed.has(definition.family));
}

export function expandDiscoveryQueries(
  input: QueryExpansionInput,
): readonly DiscoveryQuery[] {
  const asOf = validDate(input.asOf);
  const mode = input.mode ?? "GENERAL";
  if (
    input.searchProfile !== undefined &&
    !(["FAST", "PLAYER_SWEEP", "MANUAL"] as const).includes(
      input.searchProfile,
    )
  ) {
    throw new Error("INVALID_DISCOVERY_SEARCH_PROFILE");
  }
  if (input.searchProfile && input.searchProfile !== "MANUAL") {
    return profileQueries(input, asOf, mode);
  }
  const definitions = [
    ...modeDefinitions(mode),
    ...dynamicDefinitions(input.entityContext),
  ]
    .filter((definition) =>
      MODE_FAMILIES[mode].includes(definition.family) ||
      definition.family === "PLAYER" || definition.family === "OPPONENT" ||
      definition.family === "COMPETITION" || definition.family === "ENTITY"
    )
    .slice(0, input.maxQueries ?? 32);
  const seen = new Set<string>();
  const queries: DiscoveryQuery[] = [];
  for (const definition of definitions) {
    const effectiveDefinition = mode === "BREAKING"
      ? { ...definition, window: "BREAKING" as const }
      : definition;
    const item = query(
      mode,
      asOf,
      effectiveDefinition,
      effectiveDefinition.text,
    );
    if (seen.has(item.queryId)) continue;
    seen.add(item.queryId);
    queries.push(item);
  }
  return queries.sort((left, right) =>
    right.priority - left.priority || left.queryId.localeCompare(right.queryId)
  );
}
