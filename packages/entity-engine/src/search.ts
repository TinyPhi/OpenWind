import { and, eq, isNull, or, desc, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityInstances } from "@platform/db";
import { logger } from "@platform/logger";
import type { EntityInstance, SearchEntitiesInput } from "./types.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./pagination.js";
import type { CursorPage } from "./pagination.js";

type SearchCursor = { rank: number; id: string };

function encodeSearchCursor(rank: number, id: string): string {
  return Buffer.from(JSON.stringify({ rank, id })).toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "rank" in parsed &&
      "id" in parsed &&
      typeof (parsed as SearchCursor).rank === "number" &&
      typeof (parsed as SearchCursor).id === "string"
    ) {
      return parsed as SearchCursor;
    }
    return null;
  } catch {
    return null;
  }
}

export async function searchEntities(
  db: DbOrTx,
  tenantId: string,
  input: SearchEntitiesInput,
): Promise<CursorPage<EntityInstance>> {
  const limit = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  // plainto_tsquery handles user-supplied queries safely (no special syntax)
  const tsQuery = sql`plainto_tsquery('english', ${input.query})`;
  const rankExpr = sql<number>`ts_rank(${entityInstances.searchVector}, ${tsQuery})`;

  const conditions = [
    eq(entityInstances.tenantId, tenantId),
    eq(entityInstances.entityTypeId, input.entityTypeId),
    isNull(entityInstances.deletedAt),
    sql`${entityInstances.searchVector} @@ ${tsQuery}`,
  ];

  if (input.cursor) {
    const decoded = decodeSearchCursor(input.cursor);
    if (decoded) {
      const cursorCond = or(
        sql`${rankExpr} < ${decoded.rank}`,
        and(
          sql`${rankExpr} = ${decoded.rank}`,
          sql`${entityInstances.id} < ${decoded.id}`,
        ),
      );
      if (cursorCond) conditions.push(cursorCond);
    }
  }

  const rows = await db
    .select({
      id: entityInstances.id,
      entityTypeId: entityInstances.entityTypeId,
      tenantId: entityInstances.tenantId,
      workflowId: entityInstances.workflowId,
      currentState: entityInstances.currentState,
      fields: entityInstances.fields,
      createdBy: entityInstances.createdBy,
      assignedTo: entityInstances.assignedTo,
      dueDate: entityInstances.dueDate,
      createdAt: entityInstances.createdAt,
      updatedAt: entityInstances.updatedAt,
      deletedAt: entityInstances.deletedAt,
      searchVector: entityInstances.searchVector,
      rank: rankExpr,
    })
    .from(entityInstances)
    .where(and(...conditions))
    .orderBy(desc(rankExpr), desc(entityInstances.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last ? encodeSearchCursor(last.rank, last.id) : null;

  logger.info(
    {
      tenantId,
      entityTypeId: input.entityTypeId,
      resultCount: data.length,
    },
    "Entity search executed",
  );

  return { data: data.map(rowToInstance), nextCursor };
}

function rowToInstance(
  row: typeof entityInstances.$inferSelect & { rank: number },
): EntityInstance {
  return {
    id: row.id,
    entityTypeId: row.entityTypeId,
    tenantId: row.tenantId,
    workflowId: row.workflowId ?? null,
    currentState: row.currentState,
    fields: row.fields as Record<string, unknown>,
    createdBy: row.createdBy ?? null,
    assignedTo: row.assignedTo ?? null,
    dueDate: row.dueDate ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}
