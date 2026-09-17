import { MetaApiError } from "./meta_client.ts";
import { ValidationError } from "./normalizer.ts";
import { RepositoryError } from "./repository.ts";
import type { CollectionSummary } from "./types.ts";

export interface HandlerDependencies {
  collectorSecret: string;
  collect: (collectedAt: Date) => Promise<CollectionSummary>;
  now?: () => Date;
  requestId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
}

const encoder = new TextEncoder();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    digest(left),
    digest(right),
  ]);
  let difference = leftDigest.length ^ rightDigest.length;
  const length = Math.max(leftDigest.length, rightDigest.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(header: string | null): string {
  const match = header?.match(/^Bearer ([^\s]+)$/);
  return match?.[1] ?? "";
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { ...headers },
  });
}

function statusClass(status: number | null): string | null {
  return status === null ? null : `${Math.floor(status / 100)}xx`;
}

export function createHandler(
  dependencies: HandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) {
    throw new Error("Collector secret is required");
  }

  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ??
    ((entry) => console.log(JSON.stringify(entry)));

  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") {
      return json(
        {
          requestId: id,
          error: { code: "METHOD_NOT_ALLOWED", message: "POST required" },
        },
        405,
        { allow: "POST" },
      );
    }

    const suppliedSecret = bearerToken(request.headers.get("authorization"));
    if (
      !await timingSafeEqual(suppliedSecret, dependencies.collectorSecret) ||
      suppliedSecret === ""
    ) {
      log({
        requestId: id,
        event: "collection_rejected",
        code: "UNAUTHORIZED",
      });
      return json(
        {
          requestId: id,
          error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        },
        401,
      );
    }

    try {
      const result = await dependencies.collect(now());
      log({
        requestId: id,
        event: "collection_succeeded",
        username: result.username,
        receivedMedia: result.receivedMedia,
        deduplicatedMedia: result.deduplicatedMedia,
        insertedPosts: result.insertedPosts,
        updatedPosts: result.updatedPosts,
        insertedSnapshots: result.insertedSnapshots,
      });
      return json({ requestId: id, ...result }, 200);
    } catch (error) {
      if (error instanceof MetaApiError) {
        log({
          requestId: id,
          event: "collection_failed",
          code: error.code,
          upstreamStatusClass: statusClass(error.status),
          retriable: error.retriable,
        });
        return json(
          {
            requestId: id,
            error: { code: error.code, message: "Meta collection failed" },
          },
          502,
        );
      }
      if (error instanceof ValidationError) {
        log({
          requestId: id,
          event: "collection_failed",
          code: "INVALID_META_PAYLOAD",
          itemId: error.itemId,
          field: error.field,
        });
        return json(
          {
            requestId: id,
            error: {
              code: "INVALID_META_PAYLOAD",
              message: "Meta payload validation failed",
            },
          },
          502,
        );
      }
      if (error instanceof RepositoryError) {
        log({
          requestId: id,
          event: "collection_failed",
          code: error.code,
          databaseStatusClass: statusClass(error.status),
          retriable: error.retriable,
        });
        return json(
          {
            requestId: id,
            error: { code: error.code, message: "Database ingestion failed" },
          },
          500,
        );
      }

      log({
        requestId: id,
        event: "collection_failed",
        code: "INTERNAL_ERROR",
      });
      return json(
        {
          requestId: id,
          error: { code: "INTERNAL_ERROR", message: "Collection failed" },
        },
        500,
      );
    }
  };
}
