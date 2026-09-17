import { normalizeBusinessDiscovery } from "./normalizer.ts";
import type {
  CollectionSummary,
  IngestRepository,
  MetaClient,
} from "./types.ts";

export interface CollectInstagramDependencies {
  username: string;
  collectedAt: Date;
  metaClient: MetaClient;
  repository: IngestRepository;
}

export async function collectInstagram(
  dependencies: CollectInstagramDependencies,
): Promise<CollectionSummary> {
  const rawPayload = await dependencies.metaClient.fetchAccount(
    dependencies.username,
  );
  const batch = normalizeBusinessDiscovery(
    rawPayload,
    dependencies.username,
    dependencies.collectedAt,
  );
  const persisted = await dependencies.repository.ingest(batch);

  return {
    username: dependencies.username,
    ...persisted,
    receivedMedia: batch.receivedMedia,
    deduplicatedMedia: batch.posts.length,
  };
}
