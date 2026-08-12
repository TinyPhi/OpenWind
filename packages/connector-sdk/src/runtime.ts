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
 * Egress is constrained twice, in order, before any credential is touched:
 *   1. `definition.allowedHosts` — the connector's declared allowlist.
 *   2. `assertEgressAllowed()` — a DNS-resolution SSRF check (private/
 *      loopback/link-local ranges), as defense-in-depth in case a host
 *      somehow got onto the allowlist incorrectly or resolves unexpectedly.
 * Both run before decryptCredential() is ever called, so an attacker who
 * controls the target `url` cannot use callApi() as a credential-
 * exfiltration oracle (ADR-009's exact concern with this ordering).
 */

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

/**
 * Builds a ConnectorContext for a single tenant-connector installation.
 *
 * @param tenantId              - tenant the connector is installed for
 * @param definition            - the connector's static definition (meta,
 *                                allowedHosts, auth config, triggers, actions)
 * @param encryptedCredentials  - credentialKey -> ciphertext, as will
 *                                eventually be read from the
 *                                `connector_credentials` table (issue #363).
 *                                Decoupled from that table here since it
 *                                doesn't exist yet.
 */
export function createConnectorContext(
  tenantId: string,
  definition: ConnectorDefinition,
  encryptedCredentials: Record<string, string>,
): ConnectorContext {
  const connectorId = definition.meta.id;
  const allowedHosts = new Set(
    definition.allowedHosts.map((host) => host.toLowerCase()),
  );

  function requireCiphertext(credentialKey: string): string {
    const ciphertext = encryptedCredentials[credentialKey];
    if (ciphertext === undefined) {
      throw new Error(
        `Connector "${connectorId}" is missing credential "${credentialKey}"`,
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
    }
  }

  async function callApi(config: CallApiConfig): Promise<Response> {
    let hostname: string;
    try {
      hostname = new URL(config.url).hostname.toLowerCase();
    } catch {
      throw new Error(
        `Connector "${connectorId}": malformed URL "${config.url}"`,
      );
    }

    // 1. Allowlist check — cheap, synchronous, and strictly before any
    // credential is decrypted or attached (ADR-009 Decision #5).
    if (!allowedHosts.has(hostname)) {
      throw new Error(
        `Connector "${connectorId}": host "${hostname}" is not in connector's allowedHosts`,
      );
    }

    // 2. SSRF defense-in-depth — also strictly before credential decrypt.
    await assertEgressAllowed(config.url);

    // 3. Only now decrypt and attach credentials.
    const headers = await attachAuthHeaders(config.headers ?? {});

    logger.info(
      { tenantId, connectorId, method: config.method, host: hostname },
      "connector-sdk: outbound call",
    );

    return fetch(config.url, {
      method: config.method,
      headers,
      ...(config.body !== undefined
        ? { body: JSON.stringify(config.body) }
        : {}),
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
