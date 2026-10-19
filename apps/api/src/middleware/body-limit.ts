import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { env } from "@platform/config";

// Upload routes read the whole body into memory and enforce the real per-file limits afterwards
// (packages/files: 100 MB ceiling), so this only has to stop a body of unbounded size reaching
// them. 5 MB of headroom covers multipart framing.
export const UPLOAD_BODY_LIMIT_BYTES = 105 * 1024 * 1024;

function tooLarge(c: Context): Response {
  return c.json(
    {
      error: "PAYLOAD_TOO_LARGE",
      message: "Request body is too large",
    },
    413,
  );
}

// Only the two routes that take file bytes get the larger cap, and only with an upload content
// type. Anywhere else the content type is the caller's choice, so it must not buy a bigger cap.
const UPLOAD_PATHS = [
  /^\/files\/?$/,
  /^\/api\/v1\/attachments\/[^/]+\/upload$/,
];

function isUpload(path: string, contentType: string | undefined): boolean {
  const type = (contentType ?? "").toLowerCase();
  return (
    UPLOAD_PATHS.some((p) => p.test(path)) &&
    (type.startsWith("multipart/form-data") ||
      type.startsWith("application/octet-stream"))
  );
}

/**
 * Caps request bodies before any route reads them: `API_BODY_LIMIT_BYTES` (default 2 MiB) for
 * everything, and `UPLOAD_BODY_LIMIT_BYTES` for multipart and octet-stream bodies sent to the two upload routes. Checked
 * against Content-Length when present and against the bytes actually received otherwise.
 */
export function requestBodyLimit(): MiddlewareHandler {
  const standard = bodyLimit({
    maxSize: env.API_BODY_LIMIT_BYTES,
    onError: tooLarge,
  });
  const upload = bodyLimit({
    maxSize: UPLOAD_BODY_LIMIT_BYTES,
    onError: tooLarge,
  });
  return (c, next) =>
    isUpload(c.req.path, c.req.header("content-type"))
      ? upload(c, next)
      : standard(c, next);
}
