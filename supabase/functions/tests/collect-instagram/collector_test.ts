import assert from 'node:assert/strict';

import { collectInstagram } from '../../collect-instagram/collector.ts';
import type {
  IngestRepository,
  MetaClient,
  NormalizedBatch,
} from '../../collect-instagram/types.ts';

const collectedAt = new Date('2026-09-17T01:00:00.000Z');

function payload(username = 'utdreport'): Record<string, unknown> {
  return {
    business_discovery: {
      id: '17841400000000001',
      username,
      followers_count: 250_000,
      media: {
        data: [
          {
            id: 'image-1',
            caption: 'Image fixture',
            permalink: 'https://www.instagram.com/p/image-1/',
            media_type: 'IMAGE',
            timestamp: '2026-09-17T00:30:00.000Z',
            like_count: 10,
            comments_count: 2,
          },
        ],
      },
    },
  };
}

Deno.test('collects, normalizes, persists, and summarizes one account batch', async () => {
  const savedBatches: NormalizedBatch[] = [];
  const metaClient: MetaClient = {
    fetchAccount: () => Promise.resolve(payload()),
  };
  const repository: IngestRepository = {
    ingest: (batch) => {
      savedBatches.push(batch);
      return Promise.resolve({
        accountId: '17841400000000001',
        insertedPosts: 1,
        updatedPosts: 0,
        insertedSnapshots: 1,
      });
    },
  };

  const result = await collectInstagram({
    username: 'utdreport',
    collectedAt,
    metaClient,
    repository,
  });

  assert.deepEqual(result, {
    username: 'utdreport',
    accountId: '17841400000000001',
    receivedMedia: 1,
    deduplicatedMedia: 1,
    insertedPosts: 1,
    updatedPosts: 0,
    insertedSnapshots: 1,
  });
  assert.equal(savedBatches.length, 1);
  assert.equal(savedBatches[0].posts[0].externalPostId, 'image-1');
});

Deno.test('does not call the repository after a Meta failure', async () => {
  const upstreamError = new Error('safe upstream failure');
  let ingestCalls = 0;
  const metaClient: MetaClient = {
    fetchAccount: () => Promise.reject(upstreamError),
  };
  const repository: IngestRepository = {
    ingest: () => {
      ingestCalls += 1;
      return Promise.reject(new Error('must not run'));
    },
  };

  await assert.rejects(
    collectInstagram({ username: 'utdreport', collectedAt, metaClient, repository }),
    (error: unknown) => error === upstreamError,
  );
  assert.equal(ingestCalls, 0);
});

Deno.test('does not call the repository when normalization rejects the batch', async () => {
  let ingestCalls = 0;
  const metaClient: MetaClient = {
    fetchAccount: () => Promise.resolve(payload('wrong-account')),
  };
  const repository: IngestRepository = {
    ingest: () => {
      ingestCalls += 1;
      return Promise.reject(new Error('must not run'));
    },
  };

  await assert.rejects(
    collectInstagram({ username: 'utdreport', collectedAt, metaClient, repository }),
    { name: 'ValidationError' },
  );
  assert.equal(ingestCalls, 0);
});

Deno.test('propagates a safe repository failure after normalization', async () => {
  const repositoryError = new Error('database unavailable');
  const metaClient: MetaClient = {
    fetchAccount: () => Promise.resolve(payload()),
  };
  const repository: IngestRepository = {
    ingest: () => Promise.reject(repositoryError),
  };

  await assert.rejects(
    collectInstagram({ username: 'utdreport', collectedAt, metaClient, repository }),
    (error: unknown) => error === repositoryError,
  );
});
