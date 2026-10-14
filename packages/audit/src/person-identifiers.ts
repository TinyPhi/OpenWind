import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import type { Db } from "@platform/db";
import { adminAuditLog, tenantUsers } from "@platform/db";

/** Same sentinel the actor columns get on purge, so one exclusion pattern covers both. */
export const PERSON_PLACEHOLDER = "[REDACTED]";

// Too short to be a real id, and likely to collide with ordinary values.
const MIN_IDENTIFIER_LENGTH = 3;
const BATCH_SIZE = 1000;

export interface PersonIdentifiers {
  ids: ReadonlySet<string>;
  /** Lower-cased. */
  emails: ReadonlySet<string>;
}

function isKnown(value: string, known: PersonIdentifiers): boolean {
  return known.ids.has(value) || known.emails.has(value.toLowerCase());
}

// Audit JSON is application-generated and shallow. Anything deeper than this
// is replaced whole rather than walked: a purge must not fail on a freak
// document (a RangeError would fail every retry), and must not keep one.
const MAX_DEPTH = 64;

/**
 * Replaces every string value, and every object key, equal to a known person
 * identifier with the placeholder, at any depth. Structure, numbers and other
 * strings are preserved. Matching by value rather than by path means a new
 * audit action that puts an id somewhere new is still covered (#860).
 */
export function scrubPersonIdentifiers(
  value: unknown,
  known: PersonIdentifiers,
  depth = 0,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    return isKnown(value, known)
      ? { value: PERSON_PLACEHOLDER, changed: true }
      : { value, changed: false };
  }
  if (value === null || typeof value !== "object") {
    return { value, changed: false };
  }
  if (depth >= MAX_DEPTH) {
    return { value: PERSON_PLACEHOLDER, changed: true };
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let changed = false;
    for (const item of value as unknown[]) {
      const r = scrubPersonIdentifiers(item, known, depth + 1);
      if (r.changed) changed = true;
      out.push(r.value);
    }
    return { value: changed ? out : value, changed };
  }

  const entries: Array<[string, unknown]> = [];
  const taken = new Set(Object.keys(value));
  let changed = false;
  for (const [key, item] of Object.entries(value)) {
    const r = scrubPersonIdentifiers(item, known, depth + 1);
    if (r.changed) changed = true;
    let nextKey = key;
    if (isKnown(key, known)) {
      changed = true;
      nextKey = PERSON_PLACEHOLDER;
      // Two identifier keys, or a real key already named like the
      // placeholder, must not overwrite each other.
      for (let n = 2; taken.has(nextKey); n++) {
        nextKey = `${PERSON_PLACEHOLDER}#${n}`;
      }
      taken.add(nextKey);
    }
    entries.push([nextKey, r.value]);
  }
  // fromEntries defines own properties, so a literal "__proto__" key survives
  // instead of being swallowed as a prototype assignment.
  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

/**
 * Every person identifier the tenant holds: its members' ids and emails, plus
 * the user actors and acting persons in its own audit rows (people who acted
 * but are no longer members). Must run before anything is deleted or
 * rewritten.
 */
export async function collectPersonIdentifiers(
  db: Db,
  tenantId: string,
): Promise<PersonIdentifiers> {
  const ids = new Set<string>();
  const emails = new Set<string>();
  const addId = (v: string | null): void => {
    if (v && v !== PERSON_PLACEHOLDER && v.length >= MIN_IDENTIFIER_LENGTH)
      ids.add(v);
  };

  const members = await db
    .select({ userId: tenantUsers.userId, email: tenantUsers.email })
    .from(tenantUsers)
    .where(eq(tenantUsers.tenantId, tenantId));
  for (const m of members) {
    addId(m.userId);
    if (m.email && m.email.length >= MIN_IDENTIFIER_LENGTH)
      emails.add(m.email.toLowerCase());
  }

  const actors = await db
    .selectDistinct({ actorId: adminAuditLog.actorId })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        eq(adminAuditLog.actorType, "user"),
      ),
    );
  for (const a of actors) addId(a.actorId);

  const acting = await db
    .selectDistinct({ actingPersonId: adminAuditLog.actingPersonId })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        isNotNull(adminAuditLog.actingPersonId),
      ),
    );
  for (const a of acting) addId(a.actingPersonId);

  return { ids, emails };
}

/**
 * Scrubs person identifiers from the JSON columns of one tenant's audit rows.
 * Walks the tenant's rows by id (keyset), so it terminates whatever the actor
 * columns hold and is safe to re-run: a row with nothing left to scrub is not
 * written. Plain `db` only, like anonymizeAuditLogForTenant.
 */
export async function scrubAuditLogPersonIdentifiers(
  db: Db,
  tenantId: string,
): Promise<number> {
  const known = await collectPersonIdentifiers(db, tenantId);
  if (known.ids.size === 0 && known.emails.size === 0) return 0;

  let rowsChanged = 0;
  let lastId: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const batch: Array<{
      id: string;
      metadata: unknown;
      beforeSnapshot: unknown;
      afterSnapshot: unknown;
    }> = await db
      .select({
        id: adminAuditLog.id,
        metadata: adminAuditLog.metadata,
        beforeSnapshot: adminAuditLog.beforeSnapshot,
        afterSnapshot: adminAuditLog.afterSnapshot,
      })
      .from(adminAuditLog)
      .where(
        lastId === null
          ? eq(adminAuditLog.tenantId, tenantId)
          : and(
              eq(adminAuditLog.tenantId, tenantId),
              gt(adminAuditLog.id, lastId),
            ),
      )
      .orderBy(asc(adminAuditLog.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    for (const row of batch) {
      const metadata = scrubPersonIdentifiers(row.metadata, known);
      const before = scrubPersonIdentifiers(row.beforeSnapshot, known);
      const after = scrubPersonIdentifiers(row.afterSnapshot, known);
      if (!metadata.changed && !before.changed && !after.changed) continue;
      await db
        .update(adminAuditLog)
        .set({
          ...(metadata.changed && { metadata: metadata.value }),
          ...(before.changed && { beforeSnapshot: before.value }),
          ...(after.changed && { afterSnapshot: after.value }),
        })
        .where(
          and(
            eq(adminAuditLog.id, row.id),
            eq(adminAuditLog.tenantId, tenantId),
          ),
        );
      rowsChanged++;
    }

    lastId = batch[batch.length - 1]?.id ?? null;
    if (batch.length < BATCH_SIZE) break;
  }
  return rowsChanged;
}
