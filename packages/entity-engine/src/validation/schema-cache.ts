import { createClient } from "redis";
import { and, eq, isNull, or } from "drizzle-orm";
import { env } from "@platform/config";
import type { DbOrTx } from "@platform/db";
import { entityFields } from "@platform/db";
import type { EntityField } from "../types.js";
import { buildZodSchema } from "./schema-builder.js";
import type { z } from "zod";

const CACHE_TTL_SECONDS = 60;

type RedisClient = ReturnType<typeof createClient>;
let _redis: RedisClient | null = null;

function getRedis(): RedisClient {
  if (!_redis) {
    _redis = createClient({ url: env.REDIS_URL });
    void _redis.connect().catch(() => {
      // Connection failures are surfaced on first use
    });
  }
  return _redis;
}

function cacheKey(
  entityTypeId: string,
  tenantId: string,
  mode: "create" | "update",
): string {
  return `schema:${entityTypeId}:${tenantId}:${mode}`;
}

export async function getValidationSchema(
  db: DbOrTx,
  entityTypeId: string,
  tenantId: string,
  mode: "create" | "update",
): Promise<z.ZodObject<Record<string, z.ZodTypeAny>>> {
  const redis = getRedis();
  const key = cacheKey(entityTypeId, tenantId, mode);

  try {
    const cached = await redis.get(key);
    if (cached) {
      const fields = JSON.parse(cached) as EntityField[];
      return buildZodSchema(fields, mode);
    }
  } catch {
    // Cache miss on Redis error — fall through to DB
  }

  const rows = await db
    .select()
    .from(entityFields)
    .where(
      and(
        eq(entityFields.entityTypeId, entityTypeId),
        or(isNull(entityFields.tenantId), eq(entityFields.tenantId, tenantId)),
      ),
    )
    .orderBy(entityFields.sortOrder);

  const fields: EntityField[] = rows.map((r) => ({
    ...r,
    config: (r.config as Record<string, unknown>) ?? {},
    fieldType: r.fieldType as EntityField["fieldType"],
  }));

  try {
    await redis.set(key, JSON.stringify(fields), { EX: CACHE_TTL_SECONDS });
  } catch {
    // Non-fatal: proceed without caching
  }

  return buildZodSchema(fields, mode);
}

export async function invalidateSchemaCache(
  entityTypeId: string,
  tenantId?: string,
): Promise<void> {
  const redis = getRedis();
  const pattern = tenantId
    ? `schema:${entityTypeId}:${tenantId}:*`
    : `schema:${entityTypeId}:*`;

  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(keys);
  } catch {
    // Non-fatal
  }
}
