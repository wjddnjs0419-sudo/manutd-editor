import {
  buildNotionPagePayload,
  hashNotionPayload,
  syncIdentity,
  type CandidateProjectionInput,
  type NotionBlock,
  type NotionPagePayload,
  type SyncLifecycle,
} from "./mapper.ts";
import { NotionClientError } from "./notion_client.ts";

export interface SyncState {
  readonly sync_identity: string;
  readonly candidate_id: string;
  readonly story_cluster_id: string;
  readonly ranking_date: string;
  readonly notion_page_id: string | null;
  readonly last_synced_hash: string | null;
  readonly last_synced_at: string | null;
  readonly sync_status: "CURRENT" | "DROPPED" | "EXPIRED" | "FAILED";
  readonly last_error_category: string | null;
}

export interface NotionSyncRepository {
  listCandidates(): Promise<readonly CandidateProjectionInput[]>;
  listStates(): Promise<readonly SyncState[]>;
  saveState(state: SyncState): Promise<void>;
}

export interface NotionSyncClientLike {
  createPage(payload: NotionPagePayload): Promise<{ id: string; url?: string }>;
  updatePage(
    pageId: string,
    payload: { properties: Record<string, unknown>; children?: NotionBlock[] },
  ): Promise<{ id: string; url?: string }>;
  retrievePage(pageId: string): Promise<{ id: string; url?: string }>;
}

export interface NotionSyncOptions {
  readonly repository: NotionSyncRepository;
  readonly notion: NotionSyncClientLike;
  readonly now?: () => Date;
  readonly rankingDate?: string;
}

export interface NotionSyncSummary {
  readonly rankingDate: string;
  readonly considered: number;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly dropped: number;
  readonly expired: number;
  readonly failed: number;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function validDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function isCurated(candidate: CandidateProjectionInput["candidate"]): boolean {
  return (candidate.rank !== null && candidate.rank <= 10) ||
    candidate.first_mover_flag || candidate.must_cover_flag;
}

function lifecycleProperty(lifecycle: SyncLifecycle, syncedAt: string) {
  return {
    "Sync Lifecycle": { select: { name: lifecycle } },
    "Last Synced At": { date: { start: syncedAt } },
  };
}

function errorCategory(error: unknown): string {
  if (error instanceof NotionClientError) return error.category;
  return "UNKNOWN";
}

function failedState(
  state: SyncState | undefined,
  input: CandidateProjectionInput,
  category: string,
): SyncState {
  return {
    sync_identity: syncIdentity(input),
    candidate_id: input.candidate.id,
    story_cluster_id: input.candidate.story_cluster_id,
    ranking_date: input.candidate.ranking_date,
    notion_page_id: state?.notion_page_id ?? null,
    last_synced_hash: state?.last_synced_hash ?? null,
    last_synced_at: state?.last_synced_at ?? null,
    sync_status: "FAILED",
    last_error_category: category,
  };
}

function successfulState(
  input: CandidateProjectionInput,
  pageId: string,
  hash: string,
  syncedAt: string,
  lifecycle: SyncLifecycle,
): SyncState {
  return {
    sync_identity: syncIdentity(input),
    candidate_id: input.candidate.id,
    story_cluster_id: input.candidate.story_cluster_id,
    ranking_date: input.candidate.ranking_date,
    notion_page_id: pageId,
    last_synced_hash: hash,
    last_synced_at: syncedAt,
    sync_status: lifecycle,
    last_error_category: null,
  };
}

export async function runNotionSync(options: NotionSyncOptions): Promise<NotionSyncSummary> {
  const now = options.now ?? (() => new Date());
  const syncedAt = now().toISOString();
  const rankingDate = options.rankingDate ?? dateOnly(new Date(syncedAt));
  if (!validDateOnly(rankingDate)) throw new Error("Invalid ranking date");

  const [candidates, states] = await Promise.all([
    options.repository.listCandidates(),
    options.repository.listStates(),
  ]);
  const byIdentity = new Map(states.map((state) => [state.sync_identity, state]));
  const inputsByIdentity = new Map(candidates.map((input) => [syncIdentity(input), input]));
  const currentIdentities = new Set<string>();
  const summary = {
    rankingDate,
    considered: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    dropped: 0,
    expired: 0,
    failed: 0,
  } satisfies NotionSyncSummary;

  for (const input of candidates) {
    const identity = syncIdentity(input);
    const state = byIdentity.get(identity);
    const isToday = input.candidate.ranking_date === rankingDate;
    const lifecycle: SyncLifecycle = isToday && isCurated(input.candidate)
      ? "CURRENT"
      : input.candidate.ranking_date < rankingDate
      ? "EXPIRED"
      : "DROPPED";

    if (lifecycle === "CURRENT") currentIdentities.add(identity);
    if (lifecycle === "CURRENT") summary.considered += 1;
    if (lifecycle !== "CURRENT" && !state?.notion_page_id) continue;

    try {
      if (lifecycle === "CURRENT") {
        const payload = buildNotionPagePayload({ ...input, lifecycle });
        const hash = await hashNotionPayload(payload);
        if (
          state?.notion_page_id && state.sync_status === "CURRENT" &&
          state.last_synced_hash === hash
        ) {
          summary.skipped += 1;
          continue;
        }
        payload.properties["Last Synced At"] = { date: { start: syncedAt } };
        const page = state?.notion_page_id
          ? await options.notion.updatePage(state.notion_page_id, payload)
          : await options.notion.createPage(payload);
        await options.repository.saveState(successfulState(input, page.id, hash, syncedAt, lifecycle));
        if (state?.notion_page_id) summary.updated += 1;
        else summary.created += 1;
        continue;
      }

      if (state?.notion_page_id) {
        await options.notion.updatePage(
          state.notion_page_id,
          { properties: lifecycleProperty(lifecycle, syncedAt) },
        );
        await options.repository.saveState({
          ...state,
          sync_status: lifecycle,
          last_synced_at: syncedAt,
          last_error_category: null,
        });
        summary.updated += 1;
        if (lifecycle === "DROPPED") summary.dropped += 1;
        else summary.expired += 1;
      }
    } catch (error) {
      summary.failed += 1;
      await options.repository.saveState(failedState(state, input, errorCategory(error)));
    }
  }

  for (const state of states) {
    if (state.ranking_date >= rankingDate || currentIdentities.has(state.sync_identity)) continue;
    if (inputsByIdentity.has(state.sync_identity)) continue;
    if (!state.notion_page_id || state.sync_status === "EXPIRED") continue;
    try {
      await options.notion.updatePage(
        state.notion_page_id,
        { properties: lifecycleProperty("EXPIRED", syncedAt) },
      );
      await options.repository.saveState({
        ...state,
        sync_status: "EXPIRED",
        last_synced_at: syncedAt,
        last_error_category: null,
      });
      summary.updated += 1;
      summary.expired += 1;
    } catch (error) {
      summary.failed += 1;
      await options.repository.saveState({ ...state, sync_status: "FAILED", last_error_category: errorCategory(error) });
    }
  }

  return summary;
}
