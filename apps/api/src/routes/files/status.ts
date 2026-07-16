import { requireAuth } from "@platform/auth";
import { files, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { factory } from "./factory.js";

export const getFileScanStatusHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const fileId = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");

    const [file] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: files.id,
          scanStatus: files.scanStatus,
        })
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
        .limit(1),
    );

    if (!file || file.scanStatus === "deleted") {
      return c.json({ error: "NOT_FOUND", message: "File not found" }, 404);
    }

    return c.json({ data: { fileId: file.id, scanStatus: file.scanStatus } });
  },
);
