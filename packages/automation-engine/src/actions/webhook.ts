/**
 * webhook.ts
 *
 * Executes an outbound webhook automation action.
 *
 * Security invariants:
 *  - URL is validated against SSRF block list BEFORE any network call
 *  - TCP connection is pinned to the DNS-resolved IP via a one-shot https/http
 *    Agent with a custom `lookup` callback — no second DNS resolution at connect
 *    time (prevents DNS rebinding)
 *  - Uses node:http(s).request (NOT global fetch) because Node's fetch is
 *    Undici-based and silently ignores the `agent` option — the `@ts-expect-error`
 *    work-around does not actually pin the connection
 *  - TLS SNI and certificate validation use the original hostname — the URL and
 *    Host header are never rewritten to an IP address
 *  - Blocked attempts are logged with tenantId, ruleId, targetUrl, resolvedIp,
 *    and reason; no internal detail is surfaced to the tenant API response
 */

import https from "node:https";
import http from "node:http";
import type { TriggerEvent } from "../event-schemas.js";
import { validateWebhookUrl } from "../ssrf-guard.js";
import { AutomationError } from "../types.js";
import type { WebhookActionConfig } from "../types.js";
import { logger } from "@platform/logger";

export type { WebhookActionConfig };

export type WebhookActionOptions = {
  /** Extra CIDRs to block, sourced from SSRF_BLOCK_CIDRS env var.
   *  Always an array (env transform guarantees it); defaults to [] if omitted. */
  extraBlockCidrs?: string[] | undefined;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

export async function executeWebhookAction(
  tenantId: string,
  ruleId: string,
  event: TriggerEvent,
  config: WebhookActionConfig,
  options: WebhookActionOptions = {},
): Promise<void> {
  const {
    url,
    method = "POST",
    headers = {},
    includePayload = false,
    sendFields,
  } = config;
  const timeoutMs = Math.min(
    config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  // ── 1. SSRF validation — throws AutomationError('WEBHOOK_SSRF_BLOCKED') if blocked ──
  let validatedIp: string;
  try {
    validatedIp = await validateWebhookUrl(url, options.extraBlockCidrs ?? []);
  } catch (err) {
    if (err instanceof AutomationError && err.code === "WEBHOOK_SSRF_BLOCKED") {
      // Already logged inside validateWebhookUrl with full context.
      // Re-throw so executor records this as degraded (not failed).
      throw err;
    }
    throw err;
  }

  // ── 2. Build request body ─────────────────────────────────────────────────
  let payload: Record<string, unknown> = {};
  if (includePayload) {
    if (event.eventType === "entity.created") {
      const filteredFields: Record<string, unknown> = {};
      if (sendFields) {
        for (const f of sendFields) {
          if (f in event.fields) {
            filteredFields[f] = event.fields[f];
          }
        }
      }
      payload = {
        ...event,
        fields: filteredFields,
      };
    } else {
      payload = event as unknown as Record<string, unknown>;
    }
  }
  const body = JSON.stringify(payload);

  const fieldCount =
    includePayload && event.eventType === "entity.created"
      ? Object.keys(payload.fields as Record<string, unknown>).length
      : 0;

  logger.info(
    { tenantId, ruleId, url, fieldCount },
    "automation: dispatching webhook action",
  );

  // ── 3. Construct a one-shot Agent with lookup pinned to the validated IP ──
  // This prevents DNS rebinding: Node's net.createConnection would otherwise
  // perform a second DNS lookup at the TCP connect phase.  By pinning the
  // lookup callback to return the pre-validated IP, we guarantee the
  // connection goes to exactly the address we checked.
  //
  // Crucially we do NOT rewrite the URL or Host header — the original hostname
  // is preserved so that TLS SNI and certificate CN/SAN validation work
  // correctly against the remote server's certificate.
  const isHttps = url.startsWith("https:");
  // Node's net module may call the lookup callback with `opts.all = true`
  // (happy-eyeballs / multiple-address path).  When `all` is truthy the
  // callback must receive an *array* of { address, family } objects; when
  // falsy (single-address path) it must receive (null, string, number).
  // Passing a bare string when all=true causes Node to read `.address` off
  // each character of the string, resolving to `undefined`, and throwing:
  //   TypeError [ERR_INVALID_IP_ADDRESS]: Invalid IP address: undefined
  const lookupFn = (
    _hostname: string,
    opts: { all?: boolean },
    callback: (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const family = validatedIp.includes(":") ? 6 : 4;
    if (opts.all) {
      callback(null, [{ address: validatedIp, family }]);
    } else {
      callback(null, validatedIp, family);
    }
  };

  // `lookup` is typed as the overloaded `dns.lookup` signature which Node
  // types differently from our narrower callback shape — cast required.
  const agent = isHttps
    ? new https.Agent({ lookup: lookupFn as never })
    : new http.Agent({ lookup: lookupFn as never });

  // ── 4. Dispatch via node:http(s).request — honours the pinned agent ─────
  // IMPORTANT: global fetch (Undici) silently ignores the `agent` option and
  // performs its own DNS resolution, which would re-open the DNS rebinding
  // vector.  node:https.request / node:http.request use the agent's `lookup`
  // callback correctly, ensuring the connection goes to the pre-validated IP.
  await new Promise<void>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestOptions: https.RequestOptions = {
      method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "OpenWind-Webhook/1.0",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
      agent,
      timeout: timeoutMs,
    };

    const req = (isHttps ? https : http).request(requestOptions, (res) => {
      const status = res.statusCode ?? 0;
      // Drain the response to free the socket
      res.resume();
      if (status < 200 || status >= 300) {
        logger.warn(
          { tenantId, ruleId, url, status },
          "automation: webhook action received non-2xx response",
        );
        reject(
          new AutomationError("ACTION_FAILED", {
            url,
            status,
            reason: "non-2xx-response",
          }),
        );
        return;
      }
      logger.info(
        { tenantId, ruleId, url, status },
        "automation: webhook action delivered",
      );
      resolve();
    });

    req.on("timeout", () => {
      req.destroy();
      reject(
        new AutomationError("ACTION_FAILED", {
          url,
          reason: "timeout",
        }),
      );
    });

    req.on("error", (err) => {
      reject(
        new AutomationError("ACTION_FAILED", {
          url,
          reason: "network-error",
          detail: String(err),
        }),
      );
    });

    req.write(body);
    req.end();
  });
}
