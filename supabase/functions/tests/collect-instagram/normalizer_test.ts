import assert from 'node:assert/strict';

import {
  normalizeBusinessDiscovery,
  ValidationError,
} from '../../collect-instagram/normalizer.ts';

const collectedAt = new Date('2026-09-17T01:00:00.000Z');

function validPayload(): Record<string, unknown> {
  return {
    business_discovery: {
      id: '17841400000000001',
      username: 'utdreport',
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
            media_url: 'https://cdn.example/image-1.jpg',
          },
          {
            id: 'carousel-1',
            caption: 'Carousel fixture',
            permalink: 'https://www.instagram.com/p/carousel-1/',
            media_type: 'CAROUSEL_ALBUM',
            timestamp: '2026-09-17T00:00:00.000Z',
            like_count: 20,
            comments_count: 3,
            media_url: 'https://cdn.example/carousel-1.jpg',
            children: {
              data: [{ id: 'child-1', media_type: 'IMAGE' }],
            },
          },
          {
            id: 'reel-1',
            caption: 'Reel fixture',
            permalink: 'https://www.instagram.com/reel/reel-1/',
            media_type: 'VIDEO',
            media_product_type: 'REELS',
            timestamp: '2026-09-16T23:30:00.000Z',
            like_count: 30,
            comments_count: 4,
            thumbnail_url: 'https://cdn.example/reel-1.jpg',
          },
        ],
      },
    },
  };
}

Deno.test('normalizes IMAGE, CAROUSEL_ALBUM, and REELS with nullable views', () => {
  const payload = validPayload();
  const batch = normalizeBusinessDiscovery(payload, 'utdreport', collectedAt);

  assert.equal(batch.account.instagramAccountId, '17841400000000001');
  assert.equal(batch.account.followersCount, 250_000);
  assert.equal(batch.receivedMedia, 3);
  assert.deepEqual(
    batch.posts.map((post) => [post.externalPostId, post.mediaType, post.mediaProductType]),
    [
      ['image-1', 'IMAGE', null],
      ['carousel-1', 'CAROUSEL_ALBUM', null],
      ['reel-1', 'VIDEO', 'REELS'],
    ],
  );
  assert.equal(batch.posts[2].viewCount, null);
  assert.equal(batch.posts[2].postAgeMinutes, 90);
  assert.deepEqual(batch.posts[1].rawPayload, {
    id: 'carousel-1',
    caption: 'Carousel fixture',
    permalink: 'https://www.instagram.com/p/carousel-1/',
    media_type: 'CAROUSEL_ALBUM',
    timestamp: '2026-09-17T00:00:00.000Z',
    like_count: 20,
    comments_count: 3,
    media_url: 'https://cdn.example/carousel-1.jpg',
    children: { data: [{ id: 'child-1', media_type: 'IMAGE' }] },
  });
  assert.deepEqual(batch.account.capabilities, {
    followersAvailable: true,
    likesAvailable: true,
    commentsAvailable: true,
    viewsAvailable: false,
    mediaUrlAvailable: true,
    carouselChildrenAvailable: true,
  });
});

Deno.test('deduplicates repeated media IDs by retaining the first item', () => {
  const payload = validPayload();
  const discovery = payload.business_discovery as Record<string, unknown>;
  const media = discovery.media as { data: Array<Record<string, unknown>> };
  media.data.push({ ...media.data[0], caption: 'Duplicate must not win' });

  const batch = normalizeBusinessDiscovery(payload, 'utdreport', collectedAt);

  assert.equal(batch.receivedMedia, 4);
  assert.equal(batch.posts.length, 3);
  assert.equal(batch.posts[0].caption, 'Image fixture');
});

Deno.test('rejects a mismatched Business Discovery username', () => {
  const payload = validPayload();
  (payload.business_discovery as Record<string, unknown>).username = 'anotheraccount';

  assert.throws(
    () => normalizeBusinessDiscovery(payload, 'utdreport', collectedAt),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.code === 'USERNAME_MISMATCH' &&
      error.field === 'username',
  );
});

Deno.test('rejects negative engagement counts', () => {
  const payload = validPayload();
  const media = ((payload.business_discovery as Record<string, unknown>).media as {
    data: Array<Record<string, unknown>>;
  }).data;
  media[1].comments_count = -1;

  assert.throws(
    () => normalizeBusinessDiscovery(payload, 'utdreport', collectedAt),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.code === 'INVALID_FIELD' &&
      error.itemId === 'carousel-1' &&
      error.field === 'comments_count',
  );
});

Deno.test('rejects non-Reel VIDEO media in Milestone 2', () => {
  const payload = validPayload();
  const media = ((payload.business_discovery as Record<string, unknown>).media as {
    data: Array<Record<string, unknown>>;
  }).data;
  media[2].media_product_type = 'FEED';

  assert.throws(
    () => normalizeBusinessDiscovery(payload, 'utdreport', collectedAt),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.code === 'UNSUPPORTED_MEDIA' &&
      error.itemId === 'reel-1',
  );
});

Deno.test('rejects a post timestamp later than collection time', () => {
  const payload = validPayload();
  const media = ((payload.business_discovery as Record<string, unknown>).media as {
    data: Array<Record<string, unknown>>;
  }).data;
  media[0].timestamp = '2026-09-17T01:00:01.000Z';

  assert.throws(
    () => normalizeBusinessDiscovery(payload, 'utdreport', collectedAt),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.code === 'INVALID_FIELD' &&
      error.itemId === 'image-1' &&
      error.field === 'timestamp',
  );
});

Deno.test('fails the complete batch when one media item is malformed', () => {
  const payload = validPayload();
  const media = ((payload.business_discovery as Record<string, unknown>).media as {
    data: Array<Record<string, unknown>>;
  }).data;
  delete media[1].timestamp;

  assert.throws(
    () => normalizeBusinessDiscovery(payload, 'utdreport', collectedAt),
    (error: unknown) =>
      error instanceof ValidationError &&
      error.code === 'INVALID_FIELD' &&
      error.itemId === 'carousel-1' &&
      error.field === 'timestamp' &&
      !error.message.includes('Carousel fixture'),
  );
});
