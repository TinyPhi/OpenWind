/**
 * Isolation tests for docs/specs/third-party-api-origin-tagging.md R7 /
 * Phase 2 T9 (live application-name resolution): a tagged ticket's origin
 * display must keep resolving correctly — same application, current name —
 * after that application's key is rotated or its applicationName is
 * renamed, never frozen at the moment the ticket was tagged.
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq } from "drizzle-orm";
import { db, tenants, apiKeys, entityInstances } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import { hashApiKey } from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import { getEntityHandler } from "../../src/routes/entities/get.js";

const TENANT = "aabbccdd-0000-4000-a000-000000000091";
const ORIGINAL_KEY_ID = "91000000-9100-4000-9100-000000000001";
const ROTATED_KEY_ID = "91000000-9100-4000-9100-000000000002";
const SHARED_CLIENT_ID = "origin-rotation-rename-test-client";

let entityTypeId: string;
let ticketId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Origin Rotation/Rename Resolution Test",
    slug: `origin-rotation-rename-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `origin_rotation_rename_test_${Date.now()}`,
    plural: "origin_rotation_rename_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  // Original key, active, application named "Acme Sync" — this is the key
  // whose oidcClientId the ticket below gets tagged with.
  await db.insert(apiKeys).values({
    id: ORIGINAL_KEY_ID,
    tenantId: TENANT,
    name: "Origin Rotation Test Original Key",
    keyHash: hashApiKey(`sk_origin_rotation_original_${TENANT}`),
    scopesFormat: "action",
    scopes: ["entity:ticket:create"],
    oidcClientId: SHARED_CLIENT_ID,
    applicationName: "Acme Sync",
  });

  const ticket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "rotation-rename-test-user",
    originMechanism: "api",
    originOidcClientId: SHARED_CLIENT_ID,
    originPerformerUserId: "rotation-rename-test-user",
  });
  ticketId = ticket.id;
});

afterAll(async () => {
  await db.delete(entityInstances).where(eq(entityInstances.id, ticketId));
  // ROTATED_KEY references ORIGINAL_KEY via rotated_from -- must delete the
  // referencing row first or the FK constraint rejects deleting ORIGINAL.
  await db.delete(apiKeys).where(eq(apiKeys.id, ROTATED_KEY_ID));
  await db.delete(apiKeys).where(eq(apiKeys.id, ORIGINAL_KEY_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

type Vars = { Variables: { auth: AuthContext } };

function makeApp() {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "rotation-rename-test-user",
      tenantId: TENANT,
      roles: ["admin"],
      email: "rotation-rename-test@example.com",
      displayName: "Rotation Rename Test User",
      orgId: "org-091",
    });
    await next();
  });
  app.get("/:id", ...getEntityHandler);
  return app;
}

describe("origin display resolution survives key rotation and app rename (R7)", () => {
  it("resolves the tagged application's name before any rotation/rename", async () => {
    const res = await makeApp().request(`/${ticketId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { origin: { appName: string; mechanism: string } | null };
    };
    expect(body.data.origin?.mechanism).toBe("api");
    expect(body.data.origin?.appName).toBe("Acme Sync");
  });

  // resolve-origin-display.ts's performer-name lookup calls Zitadel's
  // GetUserByID for originPerformerUserId; "rotation-rename-test-user" isn't
  // a real Zitadel user id, so this exercises the not-found fallback path --
  // it must return the raw id rather than throwing or 500ing the read.
  it("falls back to the raw performer id when the performer can't be resolved via Zitadel", async () => {
    const res = await makeApp().request(`/${ticketId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        origin: {
          performerUserId: string;
          performerDisplayName: string;
        } | null;
      };
    };
    expect(body.data.origin?.performerUserId).toBe("rotation-rename-test-user");
    expect(body.data.origin?.performerDisplayName).toBe(
      "rotation-rename-test-user",
    );
  });

  it("still resolves to the same application after the key is rotated (oidcClientId carried forward, original revoked)", async () => {
    // Revoke the original FIRST (frees the applicationNameActiveUnique
    // partial index's claim on this name — see migration 0087) before
    // inserting the rotated row with the same name, same rotate.ts ordering.
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, ORIGINAL_KEY_ID));

    await db.insert(apiKeys).values({
      id: ROTATED_KEY_ID,
      tenantId: TENANT,
      name: "Origin Rotation Test Rotated Key",
      keyHash: hashApiKey(`sk_origin_rotation_rotated_${TENANT}`),
      scopesFormat: "action",
      scopes: ["entity:ticket:create"],
      oidcClientId: SHARED_CLIENT_ID,
      applicationName: "Acme Sync",
      rotatedFrom: ORIGINAL_KEY_ID,
    });

    const res = await makeApp().request(`/${ticketId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { origin: { appName: string; mechanism: string } | null };
    };
    expect(body.data.origin?.mechanism).toBe("api");
    expect(body.data.origin?.appName).toBe("Acme Sync");
  });

  it("displays the NEW name after the application is renamed — never frozen at ticket-creation time", async () => {
    await db
      .update(apiKeys)
      .set({ applicationName: "Acme Sync Pro" })
      .where(eq(apiKeys.id, ROTATED_KEY_ID));

    const res = await makeApp().request(`/${ticketId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { origin: { appName: string; mechanism: string } | null };
    };
    expect(body.data.origin?.appName).toBe("Acme Sync Pro");
  });
});
