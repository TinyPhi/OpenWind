/**
 * GDPR User Erasure Tenant Isolation Tests.
 *
 * Enforces that calling the GDPR erasure database queries under Tenant A's context
 * only deletes/anonymizes rows belonging to Tenant A, leaving Tenant B's rows completely untouched.
 *
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, or } from "drizzle-orm";
import { db, withTenantContext } from "@platform/db";
import {
  tenantUsers,
  apiKeys,
  attachments,
  idempotencyKeys,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-4444-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-4444-4000-b000-000000000002";

const TARGET_USER_ID = "gdpr-erasure-test-target-user";
const OTHER_USER_ID = "gdpr-erasure-test-other-user";

beforeAll(async () => {
  // Setup data for Tenant A and Tenant B
  // 1. tenant_users
  await db.insert(tenantUsers).values([
    {
      tenantId: TENANT_A,
      userId: TARGET_USER_ID,
      email: "target-a@example.com",
    },
    { tenantId: TENANT_A, userId: OTHER_USER_ID, email: "other-a@example.com" },
    {
      tenantId: TENANT_B,
      userId: TARGET_USER_ID,
      email: "target-b@example.com",
    },
  ]);

  // 2. api_keys
  await db.insert(apiKeys).values([
    {
      tenantId: TENANT_A,
      name: "Key A Target",
      keyHash: "hash-a-target",
      createdBy: TARGET_USER_ID,
      revokedBy: OTHER_USER_ID,
    },
    {
      tenantId: TENANT_A,
      name: "Key A Other",
      keyHash: "hash-a-other",
      createdBy: OTHER_USER_ID,
      revokedBy: TARGET_USER_ID,
    },
    {
      tenantId: TENANT_B,
      name: "Key B Target",
      keyHash: "hash-b-target",
      createdBy: TARGET_USER_ID,
      revokedBy: OTHER_USER_ID,
    },
  ]);

  // 3. attachments
  await db.insert(attachments).values([
    {
      tenantId: TENANT_A,
      declaredFilename: "file-a-target.txt",
      declaredSizeBytes: 10,
      declaredMimeType: "text/plain",
      uploadTokenHash: "hash-a-target",
      uploadExpiresAt: new Date(Date.now() + 3600000),
      uploadedBy: TARGET_USER_ID,
      actingPersonId: OTHER_USER_ID,
    },
    {
      tenantId: TENANT_B,
      declaredFilename: "file-b-target.txt",
      declaredSizeBytes: 10,
      declaredMimeType: "text/plain",
      uploadTokenHash: "hash-b-target",
      uploadExpiresAt: new Date(Date.now() + 3600000),
      uploadedBy: TARGET_USER_ID,
      actingPersonId: OTHER_USER_ID,
    },
  ]);

  // 4. idempotency_keys
  await db.insert(idempotencyKeys).values([
    {
      tenantId: TENANT_A,
      apiKeyId: "ffffffff-1111-4000-a000-000000000001",
      actingPersonId: TARGET_USER_ID,
      idempotencyKey: "idem-a-target",
      contentHash: "hash-a",
      responseStatus: 200,
      responseBody: { success: true },
      expiresAt: new Date(Date.now() + 86400000),
    },
    {
      tenantId: TENANT_B,
      apiKeyId: "ffffffff-1111-4000-a000-000000000001",
      actingPersonId: TARGET_USER_ID,
      idempotencyKey: "idem-b-target",
      contentHash: "hash-b",
      responseStatus: 200,
      responseBody: { success: true },
      expiresAt: new Date(Date.now() + 86400000),
    },
  ]);
});

afterAll(async () => {
  // Clean up remaining test data
  await db
    .delete(tenantUsers)
    .where(
      or(
        eq(tenantUsers.userId, TARGET_USER_ID),
        eq(tenantUsers.userId, OTHER_USER_ID),
      ),
    );
  await db
    .delete(apiKeys)
    .where(
      or(
        eq(apiKeys.createdBy, TARGET_USER_ID),
        eq(apiKeys.createdBy, OTHER_USER_ID),
      ),
    );
  await db
    .delete(attachments)
    .where(
      or(
        eq(attachments.uploadedBy, TARGET_USER_ID),
        eq(attachments.uploadedBy, "[REDACTED]"),
      ),
    );
  await db
    .delete(idempotencyKeys)
    .where(
      or(
        eq(idempotencyKeys.actingPersonId, TARGET_USER_ID),
        eq(idempotencyKeys.actingPersonId, "[REDACTED]"),
      ),
    );
});

describe("GDPR user erasure — Cross-tenant isolation", () => {
  it("only mutates Tenant A records when called under Tenant A context", async () => {
    // Run the erasure steps under TENANT_A context
    await withTenantContext(TENANT_A, async (tx) => {
      // 1. Delete api_keys created by target user
      await tx
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.tenantId, TENANT_A),
            eq(apiKeys.createdBy, TARGET_USER_ID),
          ),
        );

      // 2. Anonymize api_keys revoked by target user
      await tx
        .update(apiKeys)
        .set({ revokedBy: "[REDACTED]" })
        .where(
          and(
            eq(apiKeys.tenantId, TENANT_A),
            eq(apiKeys.revokedBy, TARGET_USER_ID),
          ),
        );

      // 3. Anonymize attachments references
      await tx
        .update(attachments)
        .set({ uploadedBy: "[REDACTED]", actingPersonId: "[REDACTED]" })
        .where(
          and(
            eq(attachments.tenantId, TENANT_A),
            or(
              eq(attachments.uploadedBy, TARGET_USER_ID),
              eq(attachments.actingPersonId, TARGET_USER_ID),
            ),
          ),
        );

      // 4. Delete tenant_users association
      await tx
        .delete(tenantUsers)
        .where(
          and(
            eq(tenantUsers.tenantId, TENANT_A),
            eq(tenantUsers.userId, TARGET_USER_ID),
          ),
        );

      // 5. Delete idempotency_keys
      await tx
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.tenantId, TENANT_A),
            eq(idempotencyKeys.actingPersonId, TARGET_USER_ID),
          ),
        );
    });

    // --- Assertions for Tenant A (Mutated/Deleted) ---
    const usersA = await db
      .select()
      .from(tenantUsers)
      .where(
        and(
          eq(tenantUsers.tenantId, TENANT_A),
          eq(tenantUsers.userId, TARGET_USER_ID),
        ),
      );
    expect(usersA).toHaveLength(0); // Tenant user deleted

    const keysCreatedA = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, TENANT_A),
          eq(apiKeys.createdBy, TARGET_USER_ID),
        ),
      );
    expect(keysCreatedA).toHaveLength(0); // API keys created by target deleted

    const keysRevokedA = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, TENANT_A),
          eq(apiKeys.createdBy, OTHER_USER_ID),
        ),
      );
    expect(keysRevokedA[0]?.revokedBy).toBe("[REDACTED]"); // Revocation anonymized, key not deleted

    const attachA = await db
      .select()
      .from(attachments)
      .where(eq(attachments.tenantId, TENANT_A));
    expect(attachA[0]?.uploadedBy).toBe("[REDACTED]"); // Attachment anonymized

    const idemA = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, TENANT_A),
          eq(idempotencyKeys.actingPersonId, TARGET_USER_ID),
        ),
      );
    expect(idemA).toHaveLength(0); // Idempotency keys deleted

    // --- Assertions for Tenant B (Completely Untouched) ---
    const usersB = await db
      .select()
      .from(tenantUsers)
      .where(
        and(
          eq(tenantUsers.tenantId, TENANT_B),
          eq(tenantUsers.userId, TARGET_USER_ID),
        ),
      );
    expect(usersB).toHaveLength(1); // Tenant user intact

    const keysCreatedB = await db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, TENANT_B),
          eq(apiKeys.createdBy, TARGET_USER_ID),
        ),
      );
    expect(keysCreatedB).toHaveLength(1); // API keys created by target intact

    const attachB = await db
      .select()
      .from(attachments)
      .where(eq(attachments.tenantId, TENANT_B));
    expect(attachB[0]?.uploadedBy).toBe(TARGET_USER_ID); // Attachment intact

    const idemB = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.tenantId, TENANT_B),
          eq(idempotencyKeys.actingPersonId, TARGET_USER_ID),
        ),
      );
    expect(idemB).toHaveLength(1); // Idempotency keys intact
  });
});
