export type CanonicalFixtureStatus =
  | "SCHEDULED"
  | "LIVE"
  | "FINISHED"
  | "POSTPONED"
  | "CANCELLED";

export interface CanonicalFixture {
  provider: "API_FOOTBALL";
  external_match_id: string;
  competition: string;
  season: string | null;
  home_team: string;
  away_team: string;
  opponent: string;
  is_home: boolean;
  kickoff_at: string;
  venue: string | null;
  status: CanonicalFixtureStatus;
  home_score: number | null;
  away_score: number | null;
}

export interface FixtureProvider {
  fetchFixtures(from: Date, to: Date): Promise<readonly CanonicalFixture[]>;
  fetchMatch(externalMatchId: string): Promise<CanonicalFixture | null>;
}

export type MatchDayMode =
  | "NORMAL_DAY"
  | "MATCH_EVE"
  | "MATCH_DAY_PRE"
  | "MATCH_LIVE"
  | "MATCH_POST";

export interface StoredMatch {
  id: string;
  provider: string;
  external_match_id: string;
  competition: string;
  season: string | null;
  home_team: string;
  away_team: string;
  opponent: string;
  is_home: boolean;
  kickoff_at: string;
  venue: string | null;
  status: CanonicalFixtureStatus;
  home_score: number | null;
  away_score: number | null;
  provider_payload?: Record<string, unknown>;
}
