import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { createApiKeyHandler } from "./create.js";
import { listApiKeysHandler } from "./list.js";
import { deleteApiKeyHandler } from "./delete.js";
import { updateApiKeyHandler } from "./update.js";
import { rotateApiKeyHandler } from "./rotate.js";
import { emergencyRotateApiKeyHandler } from "./emergency-rotate.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.post("/", ...createApiKeyHandler);
router.get("/", ...listApiKeysHandler);
router.patch("/:id", ...updateApiKeyHandler);
router.delete("/:id", ...deleteApiKeyHandler);
router.post("/:id/rotate", ...rotateApiKeyHandler);
router.post("/:id/emergency-rotate", ...emergencyRotateApiKeyHandler);

export { router as apiKeysRouter };
