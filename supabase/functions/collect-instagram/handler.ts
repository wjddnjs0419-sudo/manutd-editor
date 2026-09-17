import { CollectionInputError } from "./orchestrator.ts";
import { RepositoryError } from "./repository.ts";
import type { AccountFailureCategory, CollectionRunSummary } from "./types.ts";

export interface HandlerDependencies {
  collectorSecret: string;
  collect: (
    collectedAt: Date,
    requestedSourceAccountIds?: string[],
  ) => Promise<CollectionRunSummary>;
  now?: () => Date;
  requestId?: () => string;
  log?: (entry: Record<string, unknown>) => void;
}

const encoder = new TextEncoder();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InvalidRequestError extends Error {}

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

async function requestedAccountIds(
  request: Request,
): Promise<string[] | undefined> {
  if (request.body === null) return undefined;
  const text = await request.text();
  if (text.trim() === "") return undefined;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidRequestError();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError();
  }

  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== 1 ||
    !Array.isArray(object.source_account_ids) ||
    object.source_account_ids.length === 0 ||
    object.source_account_ids.some((id) =>
      typeof id !== "string" || !UUID_PATTERN.test(id)
    )
  ) {
    throw new InvalidRequestError();
  }

  const ids = object.source_account_ids as string[];
  if (new Set(ids).size !== ids.length) throw new InvalidRequestError();
  return ids;
}

function failureCategories(
  result: CollectionRunSummary,
): Partial<Record<AccountFailureCategory, number>> {
  const categories: Partial<Record<AccountFailureCategory, number>> = {};
  for (const account of result.accounts) {
    if (account.errorCategory !== undefined) {
      categories[account.errorCategory] =
        (categories[account.errorCategory] ?? 0) + 1;
    }
  }
  return categories;
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
      const accountIds = await requestedAccountIds(request);
      const result = await dependencies.collect(now(), accountIds);
      log({
        requestId: id,
        event: "collection_completed",
        accountsRequested: result.accountsRequested,
        accountsSuccess: result.accountsSuccess,
        accountsFailed: result.accountsFailed,
        failureCategories: failureCategories(result),
        postsCreated: result.postsCreated,
        postsUpdated: result.postsUpdated,
        snapshotsCreated: result.snapshotsCreated,
        assetsStored: result.assetsStored,
        assetsFailed: result.assetsFailed,
      });
      return json({ requestId: id, ...result }, 200);
    } catch (error) {
      if (
        error instanceof InvalidRequestError ||
        error instanceof CollectionInputError
      ) {
        return json(
          {
            requestId: id,
            error: { code: "INVALID_REQUEST", message: "Invalid request body" },
          },
          400,
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
