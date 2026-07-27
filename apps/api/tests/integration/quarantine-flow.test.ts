/**
 * Quarantine flow integration test — T23.
 *
 * Tests the AV scan lifecycle visible from the @platform/files API surface,
 * using real external services (local disk, Redis for BullMQ). No mocks.
 *
 *   - After saveUpload, scan_status is "pending" (AV scan queued).
 *   - A file in "quarantined" state cannot be downloaded (FileError).
 *   - A file in "scan_failed" state is also inaccessible.
 *   - The quarantine / scan_failed transitions (performed by the av-scan worker)
 *     are exercised by updating the row directly, simulating what the worker does.
 *
 * The actual worker-side ClamAV TCP logic is unit-tested in
 * apps/worker/src/av-scan.test.ts.  This test focuses on the DB lifecycle
 * and the download-gate invariant: only "clean" files may be downloaded.
 *
 * Requires docker compose services: Postgres, Redis.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import fsp from "node:fs/promises";
import { db } from "@platform/db";
import { files } from "@platform/db";
import Redis from "ioredis";
import {
  saveUpload,
  getFileStream,
  resolveStoragePath,
  FileError,
} from "@platform/files";

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID = "cccccccc-3333-4000-c000-000000000001";
const USER_ID = "cccccccc-3333-4000-c000-000000000010";

let fileId: string;
let redis: InstanceType<typeof Redis>;

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Connect to real Redis (running in CI docker compose)
  redis = new Redis({ lazyConnect: true });
  await redis.connect();

  const result = await saveUpload(
    db,
    redis,
    TENANT_ID,
    USER_ID,
    "helpdesk",
    null,
    "eicar-test.txt",
    "text/plain",
    Buffer.from("X".repeat(68)),
  );
  fileId = result.fileId;
});

afterAll(async () => {
  await db.delete(files).where(eq(files.tenantId, TENANT_ID));
  await fsp
    .rm(resolveStoragePath(TENANT_ID), { recursive: true, force: true })
    .catch(() => undefined);
  await redis?.quit();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("quarantine lifecycle — download-gate invariant", () => {
  it("T23-1: after saveUpload, scan_status is pending (AV scan not yet run)", async () => {
    const [row] = await db
      .select({ scanStatus: files.scanStatus })
      .from(files)
      .where(eq(files.id, fileId));

    expect(row?.scanStatus).toBe("pending");
  });

  it("T23-2: pending file cannot be downloaded (download-gate blocks non-clean files)", async () => {
    const err = await getFileStream(db, TENANT_ID, fileId).catch((e) => e);
    expect(err).toBeInstanceOf(FileError);
  });

  it("T23-3: simulated quarantine — worker marks file quarantined → download is blocked", async () => {
    // Simulate what the av-scan worker does when ClamAV returns FOUND
    await db
      .update(files)
      .set({ scanStatus: "quarantined", updatedAt: new Date() })
      .where(eq(files.id, fileId));

    const err = await getFileStream(db, TENANT_ID, fileId).catch((e) => e);
    expect(err).toBeInstanceOf(FileError);
  });

  it("T23-4: simulated scan_failed → download is blocked", async () => {
    await db
      .update(files)
      .set({ scanStatus: "scan_failed", updatedAt: new Date() })
      .where(eq(files.id, fileId));

    const err = await getFileStream(db, TENANT_ID, fileId).catch((e) => e);
    expect(err).toBeInstanceOf(FileError);
  });

  it("T23-5: simulated clean — worker marks file clean → download succeeds", async () => {
    // Simulate what the av-scan worker does when ClamAV returns OK
    await db
      .update(files)
      .set({ scanStatus: "clean", updatedAt: new Date() })
      .where(eq(files.id, fileId));

    const result = await getFileStream(db, TENANT_ID, fileId);
    expect(result.originalName).toBe("eicar-test.txt");
    result.stream.destroy();
  });

  it("T23-6: clean file can be downloaded repeatedly (idempotent)", async () => {
    // File is already clean from T23-5
    const r1 = await getFileStream(db, TENANT_ID, fileId);
    const r2 = await getFileStream(db, TENANT_ID, fileId);
    expect(r1.originalName).toBe("eicar-test.txt");
    expect(r2.originalName).toBe("eicar-test.txt");
    r1.stream.destroy();
    r2.stream.destroy();
  });
});
