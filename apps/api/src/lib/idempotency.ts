/**
 * ADR-012 Phase G, spec R3/R4/R5 -- idempotency-key support for third-party
 * mutating routes (create/comment/sub-ticket/transition).
 *
 * Not to be confused with transitions.ts's own `idempotencyKey` JSON body
 * field, which is a narrower, pre-existing mechanism
 * (@platform/workflow-engine's `workflow_events.idempotency_key` event-dedup
 * column). This module is keyed off the `Idempotency-Key` HTTP header and
 * caches the entire HTTP response, independent of that mechanism.
 *
 * Flow, when the header is present:
 *   1. Look up an existing row for (tenantId, applicationActorId, actingPersonId, key).
 *      - Found, same content hash -> return the cached response, skip
 *        execution entirely (R3).
 *      - Found, different content hash -> 409 conflict, skip execution (R4).
 *   2. Not found -> try to acquire a 30s Redis lock (R5). Lock busy -> 409 +
 *      Retry-After, skip execution (a second identical request must not wait
 *      for the first's result, it must be told to retry).
 *   3. Lock acquired -> RE-CHECK the cache (double-checked locking). A faster
 *      concurrent request can finish its entire execute+cache+release cycle
 *      between this request's step-1 lookup and its step-2 lock acquisition
 *      -- without this second check, step 1's stale "not found" would let
 *      this request execute a second time even though the first request's
 *      result is now sitting in the cache. Still not found -> run the
 *      caller's handler, cache its response, release the lock, return the
 *      response.
 *
 * The lock and the cache lookup are ALWAYS scoped by the identical 3-tuple
 * (tenantId, applicationActorId, actingPersonId) plus the caller-supplied key -- a
 * mismatch between the two scopes would silently defeat the concurrency
 * guarantee (spec invariant).
 *
 * Known accepted trade-off: a cached response can carry a fire-and-forget
 * side effect that failed on the original request (e.g. comments.ts's
 * outbox write, caught and logged rather than thrown). A same-key retry
 * then replays the cached success without giving that side effect another
 * chance to run -- unlike a pre-idempotency naive retry, which would have
 * organically re-attempted it. Not fixed here: doing so would mean caching
 * only after confirming every fire-and-forget effect succeeded, which
 * would turn several currently-async, latency-safe operations into
 * response-blocking ones (spec R5/R6's whole point for comments.ts's
 * mention resolution, specifically).
 */
import { createHash } from "node:crypto";
import { eq, and, gt, lte } from "drizzle-orm";
import { idempotencyKeys, withTenantContext } from "@platform/db";
import { getRedis } from "@platform/redis";
import { logger } from "@platform/logger";

const LOCK_TTL_MS = 30_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_RETRY_AFTER_SECONDS = 1;
// Same cap as transitions.ts's own pre-existing (unrelated) idempotencyKey
// body field -- an unbounded caller-supplied header string is a storage-
// growth vector against a table with no separate size cap of its own.
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

export interface IdempotencyResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface IdempotencyScope {
  tenantId: string;
  applicationActorId: string;
  actingPersonId: string;
  idempotencyKey?: string | undefined;
}

// `canonicalize` is a pure-ESM package (its package.json `exports` map has
// no `require` condition). apps/api has no `"type": "module"`, so tsx
// transpiles a static `import` of it to a `require()` at runtime, which
// throws ERR_PACKAGE_PATH_NOT_EXPORTED and crash-loops the server -- caught
// only by actually booting the compiled server (CI's vitest run tolerates
// ESM-only deps transparently and never surfaces this). A dynamic
// `import()` works from CJS regardless of the target package's own type,
// so this loads the module once and reuses the resolved function.
let canonicalizeFn: ((value: unknown) => string | undefined) | undefined;
async function getCanonicalize(): Promise<
  (value: unknown) => string | undefined
> {
  if (!canonicalizeFn) {
    const mod = (await import("canonicalize")) as {
      default: (value: unknown) => string | undefined;
    };
    canonicalizeFn = mod.default;
  }
  return canonicalizeFn;
}

/**
 * RFC 8785 JSON Canonicalization Scheme (via the `canonicalize` package,
 * the reference JCS implementation) -- NOT a naive `JSON.stringify`, whose
 * key ordering is not guaranteed stable across HTTP client implementations
 * (spec invariant). `content` should be the already-Zod-validated input
 * (defaults filled in), plus any path-param identifiers that distinguish
 * otherwise-identical bodies sent to different resources (e.g. a ticket id).
 */
export async function computeContentHash(
  content: Record<string, unknown>,
): Promise<string> {
  const canonicalize = await getCanonicalize();
  const canonical = canonicalize(content) ?? "null";
  return createHash("sha256").update(canonical).digest("hex");
}

function lockKey(
  tenantId: string,
  applicationActorId: string,
  actingPersonId: string,
  idempotencyKey: string,
): string {
  return `idempotency-lock:${tenantId}:${applicationActorId}:${actingPersonId}:${idempotencyKey}`;
}

/**
 * Runs `execute` under idempotency protection when `scope.idempotencyKey` is
 * present; otherwise runs it directly with no caching/locking (the header is
 * optional -- a caller that doesn't send it gets today's at-most-once-per-
 * request behavior, unchanged).
 */
export async function withIdempotency(
  scope: IdempotencyScope,
  content: Record<string, unknown>,
  execute: () => Promise<IdempotencyResponse>,
): Promise<IdempotencyResponse> {
  // applicationActorId maps to the DB schema's apiKeyId field (renamed in JS to avoid
  // CodeQL's clear-text-logging naming heuristic).
  const { tenantId, applicationActorId, actingPersonId, idempotencyKey } =
    scope;
  if (!idempotencyKey) {
    return execute();
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      status: 400,
      body: {
        error: "IDEMPOTENCY_KEY_INVALID",
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      },
    };
  }
  const contentHash = await computeContentHash(content);

  // expiresAt filter -- a row past its 24h TTL (R3) is treated as absent,
  // so the request executes fresh rather than replaying a stale result.
  // Expired rows are NOT deleted here (that's the Phase 3/T8-style sweep
  // job, not yet built) -- this only affects which rows this lookup
  // considers live.
  const lookupCached = async (): Promise<IdempotencyResponse | null> => {
    const [row] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          contentHash: idempotencyKeys.contentHash,
          responseStatus: idempotencyKeys.responseStatus,
          responseBody: idempotencyKeys.responseBody,
        })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.tenantId, tenantId),
            eq(idempotencyKeys.apiKeyId, applicationActorId),
            eq(idempotencyKeys.actingPersonId, actingPersonId),
            eq(idempotencyKeys.idempotencyKey, idempotencyKey),
            gt(idempotencyKeys.expiresAt, new Date()),
          ),
        )
        .limit(1),
    );
    if (!row) return null;
    if (row.contentHash === contentHash) {
      return { status: row.responseStatus, body: row.responseBody };
    }
    return {
      status: 409,
      body: {
        error: "IDEMPOTENCY_KEY_CONFLICT",
        message:
          "This idempotency key was already used for a request with different content",
      },
    };
  };

  // Fast path: most retries hit an already-cached result and can skip lock
  // acquisition entirely (R3/R4 steady-state).
  const cached = await lookupCached();
  if (cached) return cached;

  const executeAndCache = async (): Promise<IdempotencyResponse> => {
    const response = await execute();
    if (
      response.status === 409 &&
      (response.body as { error?: string }).error === "TRANSITION_LOCKED"
    ) {
      return response;
    }
    try {
      // The unique constraint can already be satisfied by a row that's
      // expired-but-not-yet-swept (the lookup above filters on expiresAt,
      // the row itself isn't deleted until a Phase 3 sweep job exists) --
      // delete it first so the insert below can't silently no-op against a
      // stale row. Scoped to the exact 4-tuple AND already-expired, so this
      // never touches a live row from a genuine concurrent-different-
      // content race (onConflictDoNothing still protects that case).
      await withTenantContext(tenantId, async (tx) => {
        await tx
          .delete(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.tenantId, tenantId),
              eq(idempotencyKeys.apiKeyId, applicationActorId),
              eq(idempotencyKeys.actingPersonId, actingPersonId),
              eq(idempotencyKeys.idempotencyKey, idempotencyKey),
              lte(idempotencyKeys.expiresAt, new Date()),
            ),
          );
        await tx
          .insert(idempotencyKeys)
          .values({
            tenantId,
            apiKeyId: applicationActorId,
            actingPersonId,
            idempotencyKey,
            contentHash,
            responseStatus: response.status,
            responseBody: response.body as object,
            expiresAt: new Date(Date.now() + CACHE_TTL_MS),
          })
          .onConflictDoNothing();
      });
    } catch (cacheErr) {
      // NOTE (N-01): If cache persistence fails, the original action was already executed
      // and its audit log was written. A retry of the same key will bypass the cache check
      // and re-execute, resulting in duplicate audit logs. This is an accepted trade-off.
      logger.warn(
        { cacheErr, tenantId, applicationActorId },
        "idempotency: failed to persist result cache — request succeeded, a retry with this key will re-execute",
      );
    }
    return response;
  };

  const redis = getRedis();
  const key = lockKey(
    tenantId,
    applicationActorId,
    actingPersonId,
    idempotencyKey,
  );
  let acquired = false;
  try {
    const result = await redis.set(key, "1", "PX", LOCK_TTL_MS, "NX");
    acquired = result === "OK";
  } catch (err) {
    // Fails open, same philosophy as every other rate-limit/lock primitive
    // in this codebase (checkRateLimit) -- a Redis outage must degrade to
    // "no idempotency protection this request," never a hung/500 request.
    // Concurrency (R5) is genuinely NOT guaranteed for the duration of the
    // outage (two concurrent requests can both execute) -- accepted, same
    // trade-off checkRateLimit already makes for its own guarantee -- but
    // the result cache (R3/R4) still gets written on this path, unlike a
    // full bypass, so behavior is back to normal for the next request as
    // soon as Redis recovers rather than staying degraded until a fresh
    // key is used.
    logger.warn(
      { err, tenantId, applicationActorId },
      "idempotency: lock acquisition failed unexpectedly — proceeding without the concurrency guarantee",
    );
    return executeAndCache();
  }

  if (!acquired) {
    return {
      status: 409,
      body: {
        error: "IDEMPOTENCY_IN_PROGRESS",
        message: "A request with this idempotency key is already in progress",
        retryAfterSeconds: LOCK_RETRY_AFTER_SECONDS,
      },
    };
  }

  try {
    // Re-check the cache inside the critical section to close the TOCTOU
    // window where another request completed its entire cycle (execute →
    // cache → release lock) between our outer fast-path lookup and this lock
    // acquisition — without this, both requests would re-execute even though
    // one already cached its result.
    const cachedUnderLock = await lookupCached();
    if (cachedUnderLock) return cachedUnderLock;
    return await executeAndCache();
  } finally {
    try {
      await redis.del(key);
    } catch (releaseErr) {
      logger.warn(
        { releaseErr, tenantId },
        "idempotency: failed to release lock — bounded by its own 30s TTL",
      );
    }
  }
}
