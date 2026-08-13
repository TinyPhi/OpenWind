import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockInit = vi.fn();
const mockRegisterRemotes = vi.fn();
const mockLoadRemote = vi.fn();

vi.mock("@module-federation/runtime", () => ({
  init: (...args: unknown[]) => mockInit(...args),
  registerRemotes: (...args: unknown[]) => mockRegisterRemotes(...args),
  loadRemote: (...args: unknown[]) => mockLoadRemote(...args),
}));

const {
  parseSriIntegrity,
  verifyIntegrity,
  loadPluginRemote,
  loadPluginModule,
} = await import("./plugin-remote-loader.js");

async function sha384Of(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-384", bytes);
  const digestBytes = new Uint8Array(digest);
  let binary = "";
  for (const b of digestBytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe("parseSriIntegrity", () => {
  it("parses a valid sha384 integrity string", () => {
    expect(parseSriIntegrity("sha384-abc123==")).toEqual({
      algorithm: "sha384",
      hash: "abc123==",
    });
  });

  it("returns null for an unsupported algorithm", () => {
    expect(parseSriIntegrity("md5-abc123")).toBeNull();
  });

  it("returns null for a malformed string", () => {
    expect(parseSriIntegrity("not-an-integrity-string")).toBeNull();
  });
});

describe("verifyIntegrity", () => {
  it("returns true when the hash matches the real digest of the bytes", async () => {
    const content = "console.log('hello plugin');";
    const hash = await sha384Of(content);
    const bytes = new TextEncoder().encode(content).buffer;

    const result = await verifyIntegrity(bytes, `sha384-${hash}`);
    expect(result).toBe(true);
  });

  it("returns false when the bytes don't match the claimed hash", async () => {
    const hash = await sha384Of("original content");
    const tamperedBytes = new TextEncoder().encode("tampered content").buffer;

    const result = await verifyIntegrity(tamperedBytes, `sha384-${hash}`);
    expect(result).toBe(false);
  });

  it("returns false for an unparseable integrity string", async () => {
    const bytes = new TextEncoder().encode("x").buffer;
    expect(await verifyIntegrity(bytes, "garbage")).toBe(false);
  });
});

describe("loadPluginRemote", () => {
  const REAL_CONTENT = "export const version = 1;";
  let realHash: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    realHash = await sha384Of(REAL_CONTENT);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // Patch createObjectURL on the real URL constructor rather than replacing
    // the global entirely — jsdom's own setup relies on `new URL(...)`
    // elsewhere, which a plain-object replacement breaks.
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    mockInit.mockClear();
    mockRegisterRemotes.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchResponse(content: string, ok = true, status = 200) {
    fetchMock.mockResolvedValueOnce({
      ok,
      status,
      arrayBuffer: async () => new TextEncoder().encode(content).buffer,
    });
  }

  it("registers a pinned blob URL (not the original remote URL) when integrity matches", async () => {
    mockFetchResponse(REAL_CONTENT);

    const result = await loadPluginRemote({
      pluginSlug: "my_plugin",
      remoteEntryUrl: "https://cdn.example.com/my_plugin/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });

    expect(result).toEqual({ ok: true });
    expect(mockRegisterRemotes).toHaveBeenCalledWith([
      { name: "my_plugin", entry: "blob:mock-url" },
    ]);
    // The registered entry must NOT be the original remote URL — that would
    // reopen the TOCTOU gap this function exists to close.
    const registeredEntry = mockRegisterRemotes.mock.calls[0]?.[0]?.[0]?.entry;
    expect(registeredEntry).not.toBe(
      "https://cdn.example.com/my_plugin/remoteEntry.js",
    );
  });

  it("initializes the federation runtime exactly once across multiple loads", async () => {
    // The module-level "initialized" flag persists across tests in this file
    // (it's real singleton state, working as intended) — vi.resetModules() +
    // a fresh import gives this specific test its own isolated instance of
    // that flag, rather than inheriting whatever earlier tests left behind.
    vi.resetModules();
    const fresh = await import("./plugin-remote-loader.js");
    mockFetchResponse(REAL_CONTENT);
    mockFetchResponse(REAL_CONTENT);

    await fresh.loadPluginRemote({
      pluginSlug: "plugin_a",
      remoteEntryUrl: "https://cdn.example.com/a/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });
    await fresh.loadPluginRemote({
      pluginSlug: "plugin_b",
      remoteEntryUrl: "https://cdn.example.com/b/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });

    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an integrity mismatch and never registers the remote", async () => {
    mockFetchResponse("tampered content, different from what was hashed");

    const result = await loadPluginRemote({
      pluginSlug: "my_plugin",
      remoteEntryUrl: "https://cdn.example.com/my_plugin/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });

    expect(result).toEqual({ ok: false, reason: "integrity mismatch" });
    expect(mockRegisterRemotes).not.toHaveBeenCalled();
  });

  it("fails closed on a non-2xx fetch response", async () => {
    mockFetchResponse("", false, 404);

    const result = await loadPluginRemote({
      pluginSlug: "my_plugin",
      remoteEntryUrl: "https://cdn.example.com/my_plugin/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });

    expect(result).toEqual({ ok: false, reason: "fetch failed: HTTP 404" });
    expect(mockRegisterRemotes).not.toHaveBeenCalled();
  });

  // Review finding (PR #397, PrabhuVijit, L-blob): blob URLs from
  // URL.createObjectURL were never revoked, accumulating across reloads
  // (tenant switches, reinstalls) of the same plugin slug.
  it("revokes the previous blob URL when the same plugin slug reloads", async () => {
    vi.resetModules();
    const fresh = await import("./plugin-remote-loader.js");
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:mock-url-1")
      .mockReturnValueOnce("blob:mock-url-2");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL");
    // Both spies persist (with accumulated call history) across every test in
    // this file — clear the counters here so this test only measures its own
    // two loadPluginRemote calls, not earlier tests' calls to the same spy.
    createObjectURLSpy.mockClear();
    revokeObjectURLSpy.mockClear();

    mockFetchResponse(REAL_CONTENT);
    await fresh.loadPluginRemote({
      pluginSlug: "reloadable_plugin",
      remoteEntryUrl:
        "https://cdn.example.com/reloadable_plugin/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });
    expect(revokeObjectURLSpy).not.toHaveBeenCalled();

    mockFetchResponse(REAL_CONTENT);
    await fresh.loadPluginRemote({
      pluginSlug: "reloadable_plugin",
      remoteEntryUrl:
        "https://cdn.example.com/reloadable_plugin/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });

    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:mock-url-1");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the fetch itself throws (e.g. network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await loadPluginRemote({
      pluginSlug: "my_plugin",
      remoteEntryUrl: "https://cdn.example.com/my_plugin/remoteEntry.js",
      integrity: `sha384-${realHash}`,
    });

    expect(result).toEqual({
      ok: false,
      reason: "fetch failed: network down",
    });
    expect(mockRegisterRemotes).not.toHaveBeenCalled();
  });
});

describe("loadPluginModule", () => {
  it("calls loadRemote with the remoteName/exposePath convention", async () => {
    mockLoadRemote.mockResolvedValueOnce({ default: "the-component" });

    const result = await loadPluginModule("my_plugin", "ticket-widget");

    expect(mockLoadRemote).toHaveBeenCalledWith("my_plugin/ticket-widget");
    expect(result).toEqual({ default: "the-component" });
  });
});
