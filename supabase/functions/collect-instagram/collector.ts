import { normalizeBusinessDiscovery } from "./normalizer.ts";
import type {
  CollectionSummary,
  CoreCollectionResult,
  IngestRepository,
  MetaClient,
  SourceAccount,
} from "./types.ts";

export interface CollectInstagramDependencies {
  sourceAccount: SourceAccount;
  collectedAt: Date;
  signal?: AbortSignal;
  metaClient: MetaClient;
  repository: IngestRepository;
}

export async function collectInstagram(
  dependencies: CollectInstagramDependencies,
): Promise<CoreCollectionResult> {
  const rawPayload = await dependencies.metaClient.fetchAccount(
    dependencies.sourceAccount.username,
    { signal: dependencies.signal },
  );
  const batch = normalizeBusinessDiscovery(
    rawPayload,
    dependencies.sourceAccount.username,
    dependencies.collectedAt,
  );
  const persisted = await dependencies.repository.ingest(
    dependencies.sourceAccount.id,
    batch,
  );

  const summary: CollectionSummary = {
    username: dependencies.sourceAccount.username,
    ...persisted,
    receivedMedia: batch.receivedMedia,
    deduplicatedMedia: batch.posts.length,
  };
  return {
    summary,
    mediaWork: {
      sourceAccountId: dependencies.sourceAccount.id,
      batch,
      ingestedPosts: persisted.posts,
    },
  };
}
