/**
 * ssrf-guard.test.ts
 *
 * Unit tests for assertExternalIssuerEgressAllowed. DNS is fully mocked — no
 * network calls. Coverage mirrors connector-sdk's/automation-engine's own
 * ssrf-guard.test.ts, adapted for this guard's narrower scope: https-only,
 * a smaller port allowlist (443/8443 — no plain-http ports), and a void
 * return (no IP-pinning contract — see this file's own module doc comment
 * for why pinning is out of scope here).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLookup = vi.fn();

vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { assertExternalIssuerEgressAllowed } = await import("./ssrf-guard.js");

function dnsResult(ips: string[]) {
  return Promise.resolve(
    ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
}

function dnsTimeout() {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("ETIMEOUT")), 10_000),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("assertExternalIssuerEgressAllowed — blocked ranges", () => {
  it("blocks loopback IPv4 (127.0.0.1)", async () => {
    mockLookup.mockReturnValue(dnsResult(["127.0.0.1"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://localhost/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks loopback IPv6 (::1)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::1"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://ip6-localhost/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks RFC 1918 — 10.x.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["10.0.0.1"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://internal.corp/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks RFC 1918 — 192.168.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["192.168.1.100"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://home.router/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks link-local / cloud metadata endpoint (169.254.169.254)", async () => {
    mockLookup.mockReturnValue(dnsResult(["169.254.169.254"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://169.254.169.254/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks CGNAT / shared address space (100.64.x.x)", async () => {
    mockLookup.mockReturnValue(dnsResult(["100.127.255.255"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://carrier.nat/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks ULA IPv6 — both fd00::/8 and fc00::/8 halves", async () => {
    mockLookup.mockReturnValue(dnsResult(["fd12:3456:789a::1"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://internal.v6/"),
    ).rejects.toThrow(/private\/reserved address/);
  });
});

describe("assertExternalIssuerEgressAllowed — IPv4-mapped IPv6", () => {
  it("blocks ::ffff:169.254.169.254 (link-local via IPv4-mapped IPv6)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::ffff:169.254.169.254"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://bypass-attempt.example.com/"),
    ).rejects.toThrow(/private\/reserved address/);
  });
});

describe("assertExternalIssuerEgressAllowed — DNS failures (fail-closed)", () => {
  it("blocks when DNS times out", async () => {
    mockLookup.mockReturnValue(dnsTimeout());
    await expect(
      assertExternalIssuerEgressAllowed("https://slow-dns.example.com/"),
    ).rejects.toThrow(/Could not resolve issuer host/);
  }, 10_000);

  it("blocks when DNS returns an error (NXDOMAIN etc.)", async () => {
    mockLookup.mockRejectedValue(
      Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(
      assertExternalIssuerEgressAllowed("https://nonexistent.invalid/"),
    ).rejects.toThrow(/Could not resolve issuer host/);
  });

  it("blocks when DNS returns no addresses", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(
      assertExternalIssuerEgressAllowed("https://empty.example.com/"),
    ).rejects.toThrow(/resolved to no addresses/);
  });
});

describe("assertExternalIssuerEgressAllowed — valid public issuers", () => {
  it("allows a valid public https URL", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://auth.example.com/"),
    ).resolves.toBeUndefined();
  });

  it("allows permitted port 8443", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    await expect(
      assertExternalIssuerEgressAllowed("https://auth.example.com:8443/"),
    ).resolves.toBeUndefined();
  });
});

describe("assertExternalIssuerEgressAllowed — invalid input (blocked before any DNS lookup)", () => {
  it("blocks a malformed URL", async () => {
    await expect(
      assertExternalIssuerEgressAllowed("not a url"),
    ).rejects.toThrow(/Malformed issuer URL/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks plain http — https only for an OIDC issuer", async () => {
    await expect(
      assertExternalIssuerEgressAllowed("http://auth.example.com/"),
    ).rejects.toThrow(/scheme.*not allowed/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks non-http(s) schemes (ftp://)", async () => {
    await expect(
      assertExternalIssuerEgressAllowed("ftp://files.example.com/"),
    ).rejects.toThrow(/scheme.*not allowed/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks a non-permitted port (6379 — an issuer could otherwise be used to port-scan an allowed hostname)", async () => {
    await expect(
      assertExternalIssuerEgressAllowed("https://auth.example.com:6379/"),
    ).rejects.toThrow(/port.*not allowed/);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
