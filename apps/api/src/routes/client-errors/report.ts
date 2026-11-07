/**
 * POST /client-errors — browser-side errors (a route's render or lazy-chunk failure) forwarded to
 * the server's error tracking, so a spike after a redeploy reaches Sentry instead of staying in one
 * person's devtools (#810, ADR-015). The browser holds no tracking DSN: it sends here, and the
 * event goes through the same scrubbing as every server error.
 *
 * Any signed-in user may report. The body is untrusted: every field is length-capped, the page is
 * reduced to its path, and a per-user rate limit stops a looping client from flooding the tracker.
 */
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { requireAuth } from "@platform/auth";
import { logger } from "@platform/logger";
import { captureException } from "@platform/telemetry";
import { zValidator } from "../../lib/validator.js";
import { enforceClientErrorRateLimit } from "../../lib/rate-limit-tiers.js";
import { factory } from "./factory.js";

const MAX_BODY_BYTES = 16 * 1024;

export const ClientErrorSchema = z.object({
  kind: z.enum(["route_boundary"]),
  message: z.string().min(1).max(1_000),
  stack: z.string().max(8_000).optional(),
  componentStack: z.string().max(4_000).optional(),
  path: z.string().max(300).optional(),
});

export const reportClientErrorHandler = factory.createHandlers(
  requireAuth(),
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        { error: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
        413,
      ),
  }),
  zValidator("json", ClientErrorSchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const input = c.req.valid("json");

    const { allowed, resetAt } = await enforceClientErrorRateLimit(
      tenantId,
      userId,
    );
    if (!allowed) {
      c.header(
        "Retry-After",
        String(Math.max(1, resetAt - Math.ceil(Date.now() / 1000))),
      );
      return c.json(
        { error: "RATE_LIMITED", message: "Too many error reports" },
        429,
      );
    }

    // Path only: a query string or fragment can carry ids or tokens.
    const path = input.path?.split(/[?#]/)[0] ?? "";

    // The body is untrusted. Keep it from passing as a server stack: one-line message, and every
    // browser line prefixed so Sentry's "at fn (file:line:col)" frame parser cannot read it as
    // frames (which could merge this event into a real server issue's group). Query strings and
    // fragments inside stack lines are dropped.
    const oneLine = input.message.replace(/\s+/g, " ").trim();
    const quote = (label: string, text: string | undefined): string[] =>
      (text ?? "")
        .split(/\r?\n/)
        .map((line) => line.replace(/[?#][^\s)]*/g, "").trim())
        .filter(Boolean)
        .map((line) => `    ${label} | ${line}`);

    const error = new Error(oneLine);
    error.name = "ClientError";
    error.stack = [
      `ClientError: ${oneLine}`,
      ...quote("browser", input.stack),
      ...quote("component", input.componentStack),
      path ? `    page | ${path}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    captureException(error);

    logger.warn(
      { tenantId, kind: input.kind, path },
      "Client error reported from the browser",
    );
    return c.body(null, 204);
  },
);
