import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { initiateUploadHandler } from "./initiate.js";
import { getDownloadUrlHandler } from "./download.js";
import { deleteFileHandler } from "./delete.js";
import { getFileScanStatusHandler } from "./status.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.post("/", ...initiateUploadHandler);
router.get("/:id/status", ...getFileScanStatusHandler);
router.get("/:id", ...getDownloadUrlHandler);
router.delete("/:id", ...deleteFileHandler);

export { router as filesRouter };
