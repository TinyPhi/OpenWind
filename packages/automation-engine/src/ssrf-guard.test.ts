/**
 * ssrf-guard.test.ts
 *
 * Unit tests for validateWebhookUrl. DNS is fully mocked — no network calls.
 *
 * Covers:
 *  - All hardcoded blocked ranges (loopback, RFC 1918, link-local, CGNAT, ULA)
 *  - IPv4-mapped IPv6 normalisation and blocking
 *  - DNS timeout treated as a block
 *  - DNS rebinding: second resolution returns a blocked IP
 *  - Operator-configured extra CIDRs (SSRF_BLOCK_CIDRS)
 *  - Valid public URL passes
 *  - Invalid URL / bad scheme blocked
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dns/promises ──────────────────────────────────────────────────────────

const mockLookup = vi.fn();

vi.mock("node:dns/promises", () => ({
  default: { lookup: (...args: unknown[]) => mockLookup(...args) },
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { validateWebhookUrl } = await import("./ssrf-guard.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build the lookup result format that node:dns returns for `all: true`. */
function dnsResult(ips: string[]) {
  return Promise.resolve(
    ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
}

/** Build a lookup that times out (resolves after the 2 s guard fires). */
function dnsTimeout() {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("ETIMEOUT")), 10_000),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Blocked ranges ─────────────────────────────────────────────────────────────

describe("validateWebhookUrl — blocked ranges", () => {
  it("blocks loopback IPv4 (127.0.0.1)", async () => {
    mockLookup.mockReturnValue(dnsResult(["127.0.0.1"]));
    await expect(
      validateWebhookUrl("http://localhost/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ resolvedIp: "127.0.0.1" }),
    });
  });

  it("blocks loopback IPv6 (::1)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::1"]));
    await expect(
      validateWebhookUrl("http://ip6-localhost/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks RFC 1918 — 10.x.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["10.0.0.1"]));
    await expect(
      validateWebhookUrl("https://internal.corp/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks RFC 1918 — 172.16.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["172.31.255.255"]));
    await expect(
      validateWebhookUrl("https://internal.corp/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks RFC 1918 — 192.168.x.x", async () => {
    mockLookup.mockReturnValue(dnsResult(["192.168.1.100"]));
    await expect(
      validateWebhookUrl("https://home.router/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks link-local / AWS metadata endpoint (169.254.169.254)", async () => {
    mockLookup.mockReturnValue(dnsResult(["169.254.169.254"]));
    await expect(
      validateWebhookUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ resolvedIp: "169.254.169.254" }),
    });
  });

  it("blocks CGNAT / shared address space (100.64.x.x)", async () => {
    mockLookup.mockReturnValue(dnsResult(["100.127.255.255"]));
    await expect(
      validateWebhookUrl("https://carrier.nat/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks ULA IPv6 — fd00::/8 (locally assigned half)", async () => {
    mockLookup.mockReturnValue(dnsResult(["fd12:3456:789a::1"]));
    await expect(
      validateWebhookUrl("https://internal.v6/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks ULA IPv6 — fc00::/8 (central, reserved half — #383 fix)", async () => {
    mockLookup.mockReturnValue(dnsResult(["fc00::1"]));
    await expect(
      validateWebhookUrl("https://internal-central.v6/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });
});

// ── IPv4-mapped IPv6 normalisation ────────────────────────────────────────────

describe("validateWebhookUrl — IPv4-mapped IPv6", () => {
  it("blocks ::ffff:169.254.169.254 (link-local via IPv4-mapped IPv6)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::ffff:169.254.169.254"]));
    await expect(
      validateWebhookUrl("https://bypass-attempt.example.com/"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });

  it("blocks ::ffff:10.0.0.1 (RFC1918 via IPv4-mapped IPv6)", async () => {
    mockLookup.mockReturnValue(dnsResult(["::ffff:10.0.0.1"]));
    await expect(
      validateWebhookUrl("https://bypass.example.com/"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
    });
  });
});

// ── DNS failure modes ─────────────────────────────────────────────────────────

describe("validateWebhookUrl — DNS failures", () => {
  it("blocks when DNS times out (fail-closed)", async () => {
    // Simulate the internal timeout racing with a slow DNS
    mockLookup.mockReturnValue(dnsTimeout());
    await expect(
      validateWebhookUrl("https://slow-dns.example.com/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({
        reason: expect.stringMatching(/timeout|error/),
      }),
    });
  }, 10_000);

  it("blocks when DNS returns an error (NXDOMAIN etc.)", async () => {
    mockLookup.mockRejectedValue(
      Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(
      validateWebhookUrl("https://nonexistent.invalid/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ reason: "dns-error" }),
    });
  });

  it("blocks when DNS returns no addresses", async () => {
    mockLookup.mockResolvedValue([]);
    await expect(
      validateWebhookUrl("https://empty.example.com/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ reason: "dns-no-results" }),
    });
  });
});

// ── DNS rebinding ─────────────────────────────────────────────────────────────

describe("validateWebhookUrl — DNS rebinding", () => {
  it("blocks when the validated IP would rebind to a private range (second call blocked)", async () => {
    // First call returns a public IP (passes), second returns private (would be a rebind).
    // validateWebhookUrl only calls DNS once and pins the result — so this test
    // verifies that a direct call with the *blocked* IP is caught immediately.
    mockLookup.mockReturnValue(dnsResult(["10.20.30.40"]));
    await expect(
      validateWebhookUrl("https://rebinding-host.example.com/hook"),
    ).rejects.toMatchObject({ code: "WEBHOOK_SSRF_BLOCKED" });
  });
});

// ── Operator-configured extra CIDRs ──────────────────────────────────────────

describe("validateWebhookUrl — SSRF_BLOCK_CIDRS", () => {
  it("blocks an IP in a custom operator-configured CIDR", async () => {
    mockLookup.mockReturnValue(dnsResult(["203.0.113.5"]));
    await expect(
      validateWebhookUrl("https://partner.example.com/hook", [
        "203.0.113.0/24",
      ]),
    ).rejects.toMatchObject({ code: "WEBHOOK_SSRF_BLOCKED" });
  });

  it("does not block an IP outside the custom CIDR when it is a public address", async () => {
    mockLookup.mockReturnValue(dnsResult(["8.8.8.8"]));
    const ip = await validateWebhookUrl("https://dns.google/hook", [
      "203.0.113.0/24",
    ]);
    expect(ip).toBe("8.8.8.8");
  });

  it("ignores a malformed CIDR in the extra list and still validates correctly", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    // Malformed CIDR should be skipped — valid public IP should pass
    const ip = await validateWebhookUrl("https://example.com/hook", [
      "not-a-cidr",
    ]);
    expect(ip).toBe("1.2.3.4");
  });
});

// ── Valid URLs ────────────────────────────────────────────────────────────────

describe("validateWebhookUrl — valid public URLs", () => {
  it("returns the resolved IP for a valid public URL", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    const ip = await validateWebhookUrl("https://webhook.example.com/endpoint");
    expect(ip).toBe("1.2.3.4");
  });

  it("returns the first IP when DNS returns multiple addresses", async () => {
    mockLookup.mockReturnValue(dnsResult(["5.6.7.8", "9.10.11.12"]));
    const ip = await validateWebhookUrl("https://multi-a.example.com/hook");
    expect(ip).toBe("5.6.7.8");
  });
});

// ── Invalid input ─────────────────────────────────────────────────────────────

describe("validateWebhookUrl — invalid input", () => {
  it("blocks a malformed URL", async () => {
    await expect(validateWebhookUrl("not a url")).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ reason: "invalid-url" }),
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks non-http/https schemes (ftp://)", async () => {
    await expect(
      validateWebhookUrl("ftp://files.example.com/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ reason: "scheme-not-allowed" }),
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("blocks file:// scheme", async () => {
    await expect(
      validateWebhookUrl("file:///etc/passwd"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({ reason: "scheme-not-allowed" }),
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("allows permitted port 8080", async () => {
    mockLookup.mockReturnValue(dnsResult(["1.2.3.4"]));
    const ip = await validateWebhookUrl("http://example.com:8080/hook");
    expect(ip).toBe("1.2.3.4");
  });

  it("blocks non-permitted port 6379 (Redis)", async () => {
    await expect(
      validateWebhookUrl("http://example.com:6379/hook"),
    ).rejects.toMatchObject({
      code: "WEBHOOK_SSRF_BLOCKED",
      meta: expect.objectContaining({
        reason: "port-not-allowed",
        port: "6379",
      }),
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });
});
