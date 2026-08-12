/**
 * ssrf-guard.ts
 *
 * Self-contained SSRF guard for connector-sdk's outbound callApi() (ADR-009
 * Decision #5). Ported from @platform/automation-engine's ssrf-guard.ts —
 * same core logic (resolve DNS, reject private/loopback/link-local ranges) —
 * rather than importing that package directly: automation-engine depends on
 * @platform/db, @platform/entity-engine, @platform/workflow-engine, bullmq,
 * drizzle-orm and ioredis, all of which would be heavyweight, architecturally
 * wrong transitive dependencies for the lightweight connector-sdk (see
 * PROGRESS.md for the full reasoning on this choice).
 *
 * Deliberately narrower than the automation-engine version in one respect:
 * no operator-configurable extra CIDRs (SSRF_BLOCK_CIDRS) — that's
 * automation-engine-specific webhook-delivery policy. The port DOES include
 * the port allowlist (H1, PR #381 review — a real security control, not
 * policy preference: without it, an allowlisted hostname could still be
 * reached on an arbitrary internal port).
 *
 * PR #381 review (C1): the original returns the first validated IP so the
 * caller can pin the outbound TCP connection to it — without that, a second,
 * independent DNS lookup at connect time (e.g. inside fetch()) is a DNS
 * rebinding vector: the hostname could resolve somewhere private between the
 * validation call and the actual connection. This port now does the same —
 * see runtime.ts's callApi() for how the returned IP is used to pin the
 * connection via a custom http(s).Agent, matching
 * automation-engine/src/actions/webhook.ts's established pattern (global
 * fetch/Undici silently ignores the `agent` option and re-resolves DNS
 * itself, which is exactly why callApi() uses node:http(s).request instead).
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
  "fc00::/7", // Unique local addresses (RFC 4193) - both fc00::/8 (central,
  // reserved) and fd00::/8 (locally assigned) halves. Was incorrectly
  // fd00::/8 only (M1, PR #381 review) - fc00::/8 addresses are formally
  // private too and were not being blocked.
  "::ffff:0:0/96", // IPv4-mapped IPv6 (covers ::ffff:10.x, ::ffff:169.254.x etc.)
  "0.0.0.0/8", // Unspecified
];

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

type ParsedCidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

function parseCidrs(cidrs: readonly string[]): ParsedCidr[] {
  const result: ParsedCidr[] = [];
  for (const cidr of cidrs) {
    try {
      result.push(ipaddr.parseCIDR(cidr) as ParsedCidr);
    } catch {
      logger.warn(
        { cidr },
        "connector-sdk ssrf-guard: skipping malformed CIDR",
      );
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
    // Unparseable address — block it (fail-safe)
    return { blocked: true, reason: "unparseable-ip" };
  }

  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:169.254.1.1 → 169.254.1.1) so it
  // matches IPv4 CIDR rules correctly.
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
 * Validates that `url` is safe for a connector to make an outbound HTTP(S)
 * call to: http/https scheme only, an allowed port, and every DNS-resolved
 * address is outside the private/loopback/link-local ranges above.
 *
 * Fails closed: DNS timeout, DNS error, or zero resolved addresses are all
 * treated as blocked, same as automation-engine's webhook guard. Throws a
 * plain `Error` on any violation.
 *
 * @returns the first validated IP address — the CALLER MUST pin the outbound
 * connection to this exact address (not re-resolve the hostname), or this
 * guard provides no real protection against DNS rebinding (C1, PR #381
 * review). See runtime.ts's callApi().
 */
export async function assertEgressAllowed(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Connector egress blocked: malformed URL "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Connector egress blocked: scheme "${parsed.protocol}" is not allowed`,
    );
  }

  const portStr = parsed.port;
  if (portStr) {
    const portNum = Number(portStr);
    if (isNaN(portNum) || !ALLOWED_PORTS.has(portNum)) {
      throw new Error(
        `Connector egress blocked: port "${portStr}" is not allowed`,
      );
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
      { url, hostname, reason: isTimeout ? "dns-timeout" : "dns-error" },
      "connector-sdk ssrf-guard: DNS resolution failed — blocking egress",
    );
    throw new Error(
      `Connector egress blocked: DNS resolution failed for "${hostname}"`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (addresses.length === 0) {
    throw new Error(
      `Connector egress blocked: DNS returned no addresses for "${hostname}"`,
    );
  }

  for (const ip of addresses) {
    const { blocked, reason } = isBlockedIp(ip);
    if (blocked) {
      logger.warn(
        { url, hostname, resolvedIp: ip, reason },
        "connector-sdk ssrf-guard: blocked outbound call — IP is in a reserved range",
      );
      throw new Error(
        `Connector egress blocked: "${hostname}" resolves to a private/reserved address (${reason})`,
      );
    }
  }

  // addresses.length > 0 is guaranteed — checked above.
  const firstAddress = addresses[0];
  if (!firstAddress) {
    throw new Error(
      `Connector egress blocked: DNS returned no addresses for "${hostname}"`,
    );
  }
  return firstAddress;
}
