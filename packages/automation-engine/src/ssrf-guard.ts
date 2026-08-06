/**
 * ssrf-guard.ts
 *
 * Validates outbound webhook URLs against a blocklist of private/reserved
 * IP ranges to prevent Server-Side Request Forgery (SSRF) attacks.
 *
 * How it works:
 *  1. Parse and validate the URL is http/https
 *  2. Resolve the hostname to IP(s) via DNS with a 2-second timeout
 *  3. Normalise every resolved address (IPv4-mapped IPv6 → plain IPv4)
 *  4. Check each resolved IP against the hardcoded block list + any
 *     operator-configured extra CIDRs from SSRF_BLOCK_CIDRS env var
 *  5. Return the first validated IP so the caller can pin it to the
 *     outbound TCP connection — prevents DNS rebinding (no second lookup)
 *
 * Failure modes (all treated as a block):
 *  - DNS resolution timeout (> 2 s)
 *  - DNS resolution error (NXDOMAIN, SERVFAIL, etc.)
 *  - Resolved IP matches any blocked range
 *  - URL scheme is not http/https
 *  - Malformed URL
 */

import dns from "node:dns/promises";
import * as ipaddr from "ipaddr.js";
import { logger } from "@platform/logger";
import { AutomationError } from "./types.js";

// ── Hardcoded blocked ranges (IANA reserved + cloud metadata) ─────────────────

const HARDCODED_BLOCKED_CIDRS: readonly string[] = [
  "127.0.0.0/8", // Loopback IPv4
  "::1/128", // Loopback IPv6
  "10.0.0.0/8", // RFC 1918
  "172.16.0.0/12", // RFC 1918
  "192.168.0.0/16", // RFC 1918
  "169.254.0.0/16", // Link-local / AWS EC2 metadata
  "fe80::/10", // Link-local IPv6
  "100.64.0.0/10", // CGNAT / shared address space (RFC 6598)
  "fd00::/8", // Unique local addresses (RFC 4193)
  "::ffff:0:0/96", // IPv4-mapped IPv6 (covers ::ffff:10.x, ::ffff:169.254.x etc.)
  "0.0.0.0/8", // Unspecified
];

type ParsedCidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** Parse a list of CIDR strings, skipping any malformed entries with a warning. */
function parseCidrs(cidrs: readonly string[]): ParsedCidr[] {
  const result: ParsedCidr[] = [];
  for (const cidr of cidrs) {
    try {
      result.push(ipaddr.parseCIDR(cidr) as ParsedCidr);
    } catch {
      logger.warn({ cidr }, "ssrf-guard: skipping malformed CIDR");
    }
  }
  return result;
}

const HARDCODED_PARSED: ParsedCidr[] = parseCidrs(HARDCODED_BLOCKED_CIDRS);

// ── Core IP check ─────────────────────────────────────────────────────────────

function isBlockedIp(
  ipStr: string,
  extraParsed: ParsedCidr[],
): { blocked: boolean; reason: string } {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ipStr);
  } catch {
    // Unparseable address — block it (fail-safe)
    return { blocked: true, reason: "unparseable-ip" };
  }

  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:169.254.1.1 → 169.254.1.1)
  // so it matches IPv4 CIDR rules correctly
  const normalized: ipaddr.IPv4 | ipaddr.IPv6 =
    addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()
      ? (addr as ipaddr.IPv6).toIPv4Address()
      : addr;

  for (const [network, prefix] of [...HARDCODED_PARSED, ...extraParsed]) {
    try {
      if (
        normalized.kind() === network.kind() &&
        normalized.match(network, prefix)
      ) {
        return {
          blocked: true,
          reason: `${network.toString()}/${prefix}`,
        };
      }
    } catch {
      // Kind mismatch (ipv4 vs ipv6 range) — not a match, continue
    }
  }

  return { blocked: false, reason: "" };
}

// ── Public API ────────────────────────────────────────────────────────────────

const DNS_TIMEOUT_MS = 2_000;

/**
 * Validates that `url` is safe to send an outbound HTTP request to.
 *
 * Resolves the hostname via DNS (2 s timeout — failure treated as block),
 * checks all resolved IPs against the block list, and returns the first
 * validated IP so the caller can pin it to the TCP connection.
 *
 * Throws `AutomationError('WEBHOOK_SSRF_BLOCKED')` if any check fails.
 */
export async function validateWebhookUrl(
  url: string,
  extraCidrs: string[] = [],
): Promise<string> {
  // 1. Parse and validate URL scheme
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
      url,
      reason: "invalid-url",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
      url,
      reason: "scheme-not-allowed",
      scheme: parsed.protocol,
    });
  }

  // 1b. Validate destination port (issue #250)
  const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
  const portStr = parsed.port;
  if (portStr) {
    const portNum = Number(portStr);
    if (isNaN(portNum) || !ALLOWED_PORTS.has(portNum)) {
      throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
        url,
        reason: "port-not-allowed",
        port: portStr,
      });
    }
  }

  const hostname = parsed.hostname;

  // 2. Parse extra operator-configured CIDRs
  const extraParsed = parseCidrs(extraCidrs);

  // 3. Resolve hostname → IP(s) with a hard timeout.
  // A single hoisted timeoutId is cleared in the finally block regardless of
  // which branch (resolve or reject) wins — no timer leak.
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
      "ssrf-guard: DNS resolution failed — blocking webhook",
    );
    throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
      url,
      hostname,
      reason: isTimeout ? "dns-timeout" : "dns-error",
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (addresses.length === 0) {
    throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
      url,
      hostname,
      reason: "dns-no-results",
    });
  }

  // 4. Check every resolved IP against the block list
  for (const ip of addresses) {
    const { blocked, reason } = isBlockedIp(ip, extraParsed);
    if (blocked) {
      logger.warn(
        {
          url,
          hostname,
          resolvedIp: ip,
          reason,
          action: "webhook.blocked",
        },
        "ssrf-guard: blocked outbound webhook — IP is in a reserved range",
      );
      throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
        url,
        resolvedIp: ip,
        reason,
      });
    }
  }

  // Return the first validated IP for TCP connection pinning.
  // addresses.length > 0 is guaranteed — we throw on empty above.
  const firstAddress = addresses[0];
  if (!firstAddress) {
    // Unreachable — guarded above, but satisfies noUncheckedIndexedAccess
    throw new AutomationError("WEBHOOK_SSRF_BLOCKED", {
      url,
      reason: "dns-no-results",
    });
  }
  return firstAddress;
}
