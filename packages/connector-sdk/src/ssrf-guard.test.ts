/**
 * ssrf-guard.test.ts
 *
 * Unit tests for assertEgressAllowed. DNS is fully mocked — no network calls.
 * Coverage mirrors packages/automation-engine/src/ssrf-guard.test.ts (M2,
 * PR #381 review), minus operator-configured extra CIDRs (deliberately not
 * ported — see ssrf-guard.ts's module doc comment) and using plain `Error`
 * instead of `AutomationError`.
 *
 * Covers:
 *  - All hardcoded blocked ranges (loopback, RFC 1918, link-local, CGNAT,
 *    both ULA halves)
 *  - IPv4-mapped IPv6 normalisation and blocking
 *  - DNS timeout / DNS error / empty results all treated as a block
 *  - Valid public URL passes and returns the resolved IP (for pinning)
 *  - Invalid URL / bad scheme / bad port blocked, before any DNS lookup
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLookup = vi.fn();

vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { assertEgressAllowed } = await import("./ssrf-guard.js");

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

describe("assertEgressAllowed — blocked ranges", () => {
  it("blocks loopback IPv4 (127.0.0.1)", async () => {
    mockLookup.mockReturnValue(dnsResult(["127.0.0.1"]));
    await expect(assertEgressAllowed("http://localhost/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks loopback IPv6 (::1)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::1"]));
    await expect(assertEgressAllowed("http://ip6-localhost/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks RFC 1918 — 10.x.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["10.0.0.1"]));
    await expect(assertEgressAllowed("https://internal.corp/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks RFC 1918 — 172.16.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["172.31.255.255"]));
    await expect(assertEgressAllowed("https://internal.corp/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks RFC 1918 — 192.168.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["192.168.1.100"]));
    await expect(assertEgressAllowed("https://home.router/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks link-local / cloud metadata endpoint (169.254.169.254)", async () => {
    mockLookup.mockReturnValue(dnsResult(["169.254.169.254"]));
    await expect(
      assertEgressAllowed("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks CGNAT / shared address space (100.64.x.x)", async () => {
    mockLookup.mockReturnValue(dnsResult(["100.127.255.255"]));
    await expect(assertEgressAllowed("https://carrier.nat/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks ULA IPv6 — fd00::/8 (locally assigned half)", async () => {
    mockLookup.mockReturnValue(dnsResult(["fd12:3456:789a::1"]));
    await expect(assertEgressAllowed("https://internal.v6/")).rejects.toThrow(
      /private\/reserved address/,
    );
  });

  it("blocks ULA IPv6 — fc00::/8 (central, reserved half — M1 fix)", async () => {
    mockLookup.mockReturnValue(dnsResult(["fc00::1"]));
    await expect(
      assertEgressAllowed("https://internal-central.v6/"),
    ).rejects.toThrow(/private\/reserved address/);
  });
});

describe("assertEgressAllowed — IPv4-mapped IPv6", () => {
  it("blocks ::ffff:169.254.169.254 (link-local via IPv4-mapped IPv6)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::ffff:169.254.169.254"]));
    await expect(
      assertEgressAllowed("https://bypass-attempt.example.com/"),
    ).rejects.toThrow(/private\/reserved address/);
  });

  it("blocks ::ffff:10.0.0.1 (RFC1918 via IPv4-mapped IPv6)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::ffff:10.0.0.1"]));
    await expect(
      assertEgressAllowed("https://bypass.example.com/"),
    ).rejects.toThrow(/private\/reserved address/);
  });
});

describe("assertEgressAllowed — DNS failures (fail-closed)", () => {
  it("blocks when DNS times out", async () => {
    mockLookup.mockReturnValue(dnsTimeout());
    await expect(
      assertEgressAllowed("https://slow-dns.example.com/"),
    ).rejects.toThrow(/DNS resolution failed/);
  }, 10_000);

  it("blocks when DNS returns an error (NXDOMAIN etc.)", async () => {
    mockLookup.mockRejectedValue(
      Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(
      assertEgressAllowed("https://nonexistent.invalid/"),
    ).rejects.toThrow(/DNS resolution failed/);
  });

  it("blocks when DNS returns no addresses", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(
      assertEgressAllowed("https://empty.example.com/"),
    ).rejects.toThrow(/DNS returned no addresses/);
  });
});

describe("assertEgressAllowed — valid public URLs", () => {
  it("returns the resolved IP for a valid public URL (for connection pinning)", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    const ip = await assertEgressAllowed("https://api.example.com/endpoint");
    expect(ip).toBe("1.2.3.4");
  });

  it("returns the first IP when DNS returns multiple addresses", async () => {
    mockLookup.mockReturnValue(dnsResult(["5.6.7.8", "9.10.11.12"]));
    const ip = await assertEgressAllowed("https://multi-a.example.com/");
    expect(ip).toBe("5.6.7.8");
  });

  it("allows permitted port 8080", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    const ip = await assertEgressAllowed("http://api.example.com:8080/");
    expect(ip).toBe("1.2.3.4");
  });
});

describe("assertEgressAllowed — invalid input (blocked before any DNS lookup)", () => {
  it("blocks a malformed URL", async () => {
    await expect(assertEgressAllowed("not a url")).rejects.toThrow(
      /malformed URL/,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks non-http/https schemes (ftp://)", async () => {
    await expect(
      assertEgressAllowed("ftp://files.example.com/"),
    ).rejects.toThrow(/scheme.*not allowed/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks file:// scheme", async () => {
    await expect(assertEgressAllowed("file:///etc/passwd")).rejects.toThrow(
      /scheme.*not allowed/,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks non-permitted port 6379 (H1 — a connector could otherwise port-scan an allowed hostname)", async () => {
    await expect(
      assertEgressAllowed("http://api.example.com:6379/"),
    ).rejects.toThrow(/port.*not allowed/);
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
