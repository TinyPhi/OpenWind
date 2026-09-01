/**
 * ssrf-guard.ts
 *
 * Security-review finding (docs/specs/third-party-key-external-org-mapping.md
 * Phase 2 review): `jwks.ts`'s per-issuer discovery/JWKS fetches follow an
 * admin-supplied `external_issuer` URL (validated only as `z.string().url()`
 * at creation time — no scheme/host restriction). A tenant admin is not a
 * fully-trusted platform operator (same actor class the platform's other
 * outbound-fetch paths already refuse to trust with a raw URL — see
 * automation-engine's and connector-sdk's own ssrf-guard.ts), so an
 * `external_issuer` pointed at a cloud-metadata address or an internal
 * service is a real SSRF vector once a key using it is exercised.
 *
 * Ported (not imported) from connector-sdk's ssrf-guard.ts, which itself was
 * ported from automation-engine's rather than adding a cross-package
 * dependency — packages/auth has none of those two packages' dependencies
 * today (db, config, logger, redis, jose, hono, zod only; see the
 * dependency-rule comment in either source file for the full reasoning) and
 * shouldn't gain one just for this. Deliberately narrower than both: no
 * operator-configurable extra CIDRs, and https-only (an OIDC issuer has no
 * legitimate reason to be plain http, unlike a webhook/connector target).
 *
 * Does NOT pin the resolved IP for the actual connection (unlike
 * connector-sdk's version, PR #381 review C1) — `createRemoteJWKSet`'s
 * underlying fetch does its own DNS resolution, and pinning it would need a
 * custom http(s) agent plumbed through jose's fetch option, a larger change
 * than this fix's scope. This still closes the primary gap (no check at
 * all); the residual DNS-rebinding window between this check and the actual
 * fetch is a known, smaller-severity limitation, consistent with how this
 * repo has previously scoped SSRF fixes incrementally (connector-sdk's own
 * guard shipped without IP pinning first, per its file header).
 */

import dns from "node:dns/promises";
import * as ipaddr from "ipaddr.js";
import { logger } from "@platform/logger";

const HARDCODED_BLOCKED_CIDRS: readonly string[] = [
  "127.0.0.0/8", // Loopback IPv4
  "::1/128", // Loopback IPv6
  "10.0.0.0/8", // RFC 1918
  "172.16.0.0/12", // RFC 1918
  "192.168.0.0/16", // RFC 1918
  "169.254.0.0/16", // Link-local / cloud metadata
  "fe80::/10", // Link-local IPv6
  "100.64.0.0/10", // CGNAT / shared address space (RFC 6598)
  "fc00::/7", // Unique local addresses (RFC 4193)
  "::ffff:0:0/96", // IPv4-mapped IPv6
  "0.0.0.0/8", // Unspecified
];

const ALLOWED_PORTS = new Set([443, 8443]);

type ParsedCidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseCidrs(cidrs: readonly string[]): ParsedCidr[] {
  const result: ParsedCidr[] = [];
  for (const cidr of cidrs) {
    try {
      result.push(ipaddr.parseCIDR(cidr) as ParsedCidr);
    } catch {
      logger.warn({ cidr }, "auth ssrf-guard: skipping malformed CIDR");
    }
  }
  return result;
}

const BLOCKED_PARSED: ParsedCidr[] = parseCidrs(HARDCODED_BLOCKED_CIDRS);

function isBlockedIp(ipStr: string): { blocked: boolean; reason: string } {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ipStr);
  } catch {
    return { blocked: true, reason: "unparseable-ip" };
  }

  const normalized: ipaddr.IPv4 | ipaddr.IPv6 =
    addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()
      ? (addr as ipaddr.IPv6).toIPv4Address()
      : addr;

  for (const [network, prefix] of BLOCKED_PARSED) {
    try {
      if (
        normalized.kind() === network.kind() &&
        normalized.match(network, prefix)
      ) {
        return { blocked: true, reason: `${network.toString()}/${prefix}` };
      }
    } catch {
      // Kind mismatch (ipv4 vs ipv6 range) — not a match, continue
    }
  }

  return { blocked: false, reason: "" };
}

const DNS_TIMEOUT_MS = 2_000;

/**
 * Validates that `url` is safe to use as an external OIDC issuer: https
 * only, an allowed port, and every DNS-resolved address outside the
 * private/loopback/link-local/metadata ranges above. Fails closed — DNS
 * timeout, DNS error, or zero resolved addresses are all treated as
 * blocked. Throws a plain `Error` (message safe to surface to an admin —
 * no internal details) on any violation.
 */
export async function assertExternalIssuerEgressAllowed(
  url: string,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Malformed issuer URL: "${url}"`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Issuer scheme "${parsed.protocol}" is not allowed — https only`,
    );
  }

  const portStr = parsed.port;
  if (portStr) {
    const portNum = Number(portStr);
    if (isNaN(portNum) || !ALLOWED_PORTS.has(portNum)) {
      throw new Error(`Issuer port "${portStr}" is not allowed`);
    }
  }

  const hostname = parsed.hostname;

  let addresses: string[];
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookupPromise = dns
      .lookup(hostname, { all: true })
      .then((res) => res.map((r) => r.address));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            Object.assign(new Error("DNS_TIMEOUT"), { name: "AbortError" }),
          ),
        DNS_TIMEOUT_MS,
      );
    });
    addresses = await Promise.race([lookupPromise, timeoutPromise]);
  } catch (err) {
    const isTimeout =
      (err as { name?: string }).name === "AbortError" ||
      (err as { message?: string }).message === "DNS_TIMEOUT";
    logger.warn(
      { hostname, reason: isTimeout ? "dns-timeout" : "dns-error" },
      "auth ssrf-guard: DNS resolution failed — blocking issuer",
    );
    throw new Error(`Could not resolve issuer host "${hostname}"`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (addresses.length === 0) {
    throw new Error(`Issuer host "${hostname}" resolved to no addresses`);
  }

  for (const ip of addresses) {
    const { blocked, reason } = isBlockedIp(ip);
    if (blocked) {
      logger.warn(
        { hostname, resolvedIp: ip, reason },
        "auth ssrf-guard: blocked issuer — resolves to a private/reserved address",
      );
      throw new Error(
        `Issuer host "${hostname}" resolves to a private/reserved address`,
      );
    }
  }
}
