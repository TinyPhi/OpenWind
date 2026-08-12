/**
 * runtime.ts
 *
 * Factory for the ConnectorContext given to a connector's triggers/actions
 * (ADR-009 Decision #5). Connector-authored code never receives a raw
 * credential — callApi() decrypts the specific credential(s) its
 * `auth` config declares, attaches them to the outgoing request, and lets
 * them fall out of scope. Nothing decrypted is ever stored on the returned
 * ConnectorContext object or any closure that outlives a single callApi()
 * invocation.
 *
 * Egress is constrained in order, before any credential is touched:
 *   1. `definition.allowedHosts` — the connector's declared allowlist.
 *   2. `assertEgressAllowed()` — a DNS-resolution SSRF check (private/
 *      loopback/link-local ranges, port allowlist), as defense-in-depth in
 *      case a host somehow got onto the allowlist incorrectly or resolves
 *      unexpectedly. Returns the validated IP.
 *   3. The outbound connection is pinned to that exact validated IP via a
 *      custom http(s).Agent `lookup` callback (PR #381 review, C1) — global
 *      fetch()/Undici silently ignores the `agent` option and performs its
 *      own independent DNS resolution, which would reopen a DNS-rebinding
 *      window between step 2's validation and the actual TCP connect. This
 *      mirrors automation-engine/src/actions/webhook.ts's established
 *      pattern exactly, including NOT rewriting the URL/Host header to the
 *      IP — the original hostname is preserved so TLS SNI and certificate
 *      validation still work correctly against the remote server's cert.
 * Steps 1-2 both run before decryptCredential() is ever called, so an
 * attacker who controls the target `url` cannot use callApi() as a
 * credential-exfiltration oracle (ADR-009's exact concern with this
 * ordering).
 */

import * as http from "node:http";
import * as https from "node:https";
import { logger } from "@platform/logger";
import { decryptCredential } from "@platform/secrets";
import type { ConnectorContext, ConnectorDefinition } from "./types.js";
import { assertEgressAllowed } from "./ssrf-guard.js";

interface CallApiConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

// "Hostnames only — no scheme, no path, no wildcards" (types.ts's own
// ConnectorDefinition.allowedHosts doc comment) was previously enforced only
// by convention. A connector author writing "https://api.slack.com" or
// "*.slack.com" would silently disable every call (M4, PR #381 review) —
// validated at construction time instead, failing loudly.
const HOSTNAME_PATTERN =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

/**
 * Builds a ConnectorContext for a single tenant-connector installation.
 *
 * @param tenantId              - tenant the connector is installed for
 * @param definition            - the connector's static definition (meta,
 *                                allowedHosts, auth config, triggers, actions)
 * @param encryptedCredentials  - credentialKey -> ciphertext, read from the
 *                                `connector_credentials.secrets` JSONB column
 *                                (issue #363 — that table's shape was
 *                                reworked to match this exact map). Passed
 *                                in rather than read here so this module
 *                                stays decoupled from @platform/db.
 */
export function createConnectorContext(
  tenantId: string,
  definition: ConnectorDefinition,
  encryptedCredentials: Record<string, string>,
): ConnectorContext {
  const connectorId = definition.meta.id;

  for (const host of definition.allowedHosts) {
    if (!HOSTNAME_PATTERN.test(host)) {
      throw new Error(
        `Connector "${connectorId}": allowedHosts entry "${host}" is not a bare hostname (no scheme, path, or wildcard allowed)`,
      );
    }
  }
  const allowedHosts = new Set(
    definition.allowedHosts.map((host) => host.toLowerCase()),
  );

  function requireCiphertext(credentialKey: string): string {
    const ciphertext = encryptedCredentials[credentialKey];
    if (ciphertext === undefined) {
      // Does not include credentialKey in the message (L1, PR #381 review)
      // — it discloses the connector's auth configuration structure into
      // logs/errors a tenant may see.
      throw new Error(
        `Connector "${connectorId}" is missing a required credential`,
      );
    }
    return ciphertext;
  }

  // Decrypts exactly the credential(s) definition.auth calls for and
  // returns headers with the resulting value attached. The decrypted
  // plaintext lives only in this function's local variables — never
  // assigned to `ctx` or any field with a lifetime beyond this call.
  async function attachAuthHeaders(
    baseHeaders: Record<string, string>,
  ): Promise<Record<string, string>> {
    const auth = definition.auth;

    switch (auth.type) {
      case "bearer": {
        const token = await decryptCredential(
          tenantId,
          requireCiphertext(auth.credentialKey),
        );
        return { ...baseHeaders, Authorization: `Bearer ${token}` };
      }
      case "basic": {
        const [username, password] = await Promise.all([
          decryptCredential(
            tenantId,
            requireCiphertext(auth.usernameCredentialKey),
          ),
          decryptCredential(
            tenantId,
            requireCiphertext(auth.passwordCredentialKey),
          ),
        ]);
        const encoded = Buffer.from(`${username}:${password}`, "utf8").toString(
          "base64",
        );
        return { ...baseHeaders, Authorization: `Basic ${encoded}` };
      }
      case "apiKey": {
        const value = await decryptCredential(
          tenantId,
          requireCiphertext(auth.credentialKey),
        );
        return { ...baseHeaders, [auth.headerName]: value };
      }
      default: {
        // Exhaustiveness guard (M3, PR #381 review): TypeScript enforces
        // completeness of the switch above at compile time, but a
        // ConnectorDefinition built from unvalidated data (e.g. read from
        // the future connector_credentials table before schema validation
        // runs) could carry an auth.type outside the union at runtime.
        // Fail loudly instead of silently returning undefined into the
        // request below.
        const unknownAuth: { type: string } = auth;
        throw new Error(
          `Connector "${connectorId}": unknown auth.type "${unknownAuth.type}"`,
        );
      }
    }
  }

  // Node's http(s).Agent `lookup` callback: net's happy-eyeballs path calls
  // it with `opts.all = true` (expects an array), the single-address path
  // calls it without (expects a bare string) — passing the wrong shape for
  // whichever path is taken causes Node to misparse the address. Mirrors
  // automation-engine/src/actions/webhook.ts's lookupFn exactly.
  function pinnedLookup(
    pinnedIp: string,
  ): (
    _hostname: string,
    opts: { all?: boolean },
    callback: (
      err: Error | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ) => void {
    const family = pinnedIp.includes(":") ? 6 : 4;
    return (_hostname, opts, callback) => {
      if (opts.all) {
        callback(null, [{ address: pinnedIp, family }]);
      } else {
        callback(null, pinnedIp, family);
      }
    };
  }

  async function callApi(config: CallApiConfig): Promise<Response> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.url);
    } catch {
      throw new Error(
        `Connector "${connectorId}": malformed URL "${config.url}"`,
      );
    }
    const hostname = parsedUrl.hostname.toLowerCase();

    // 1. Allowlist check — cheap, synchronous, and strictly before any
    // credential is decrypted or attached (ADR-009 Decision #5).
    if (!allowedHosts.has(hostname)) {
      throw new Error(
        `Connector "${connectorId}": host "${hostname}" is not in connector's allowedHosts`,
      );
    }

    // 2. SSRF defense-in-depth — also strictly before credential decrypt.
    // Returns the validated IP, which step 3 pins the connection to.
    const validatedIp = await assertEgressAllowed(config.url);

    // 3. Only now decrypt and attach credentials.
    const headers = await attachAuthHeaders(config.headers ?? {});

    logger.info(
      { tenantId, connectorId, method: config.method, host: hostname },
      "connector-sdk: outbound call",
    );

    const isHttps = parsedUrl.protocol === "https:";
    // `lookup` is typed as the overloaded `dns.lookup` signature which Node
    // types differently from our narrower callback shape — cast required.
    const agent = isHttps
      ? new https.Agent({ lookup: pinnedLookup(validatedIp) as never })
      : new http.Agent({ lookup: pinnedLookup(validatedIp) as never });

    const bodyBuffer =
      config.body !== undefined
        ? Buffer.from(JSON.stringify(config.body), "utf8")
        : undefined;

    // node:http(s).request, not global fetch() — fetch/Undici ignores the
    // `agent` option and would re-resolve DNS itself (C1, PR #381 review).
    return new Promise<Response>((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        {
          method: config.method,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          headers: {
            ...headers,
            ...(bodyBuffer !== undefined
              ? { "Content-Length": bodyBuffer.byteLength }
              : {}),
          },
          agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const v of Array.isArray(value) ? value : [value]) {
                responseHeaders.append(key, v);
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (bodyBuffer !== undefined) req.write(bodyBuffer);
      req.end();
    });
  }

  function log(
    level: "info" | "warn" | "error",
    message: string,
    meta?: object,
  ): void {
    // Delegates to @platform/logger's existing pino `redact` configuration
    // (password/token/secret/authorization/cookie) rather than reimplementing
    // redaction here — same protection as any other structured log call in
    // the codebase. `tenantId`/`connectorId` are applied last so connector
    // code can't spoof them via `meta`.
    logger[level]({ ...meta, tenantId, connectorId }, message);
  }

  return { tenantId, callApi, log };
}
