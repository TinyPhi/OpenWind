import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isLoginOrgKey,
  rememberLoginOrg,
  rememberedLoginOrg,
} from "./login-org.js";

const KEY = "d06206191c8c8062";

beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
});

afterEach(() => {
  localStorage.clear();
});

describe("login-org", () => {
  it("accepts exactly 16 lowercase hex characters", () => {
    expect(isLoginOrgKey(KEY)).toBe(true);
    expect(isLoginOrgKey("D06206191C8C8062")).toBe(false);
    expect(isLoginOrgKey("d0620619")).toBe(false);
    expect(isLoginOrgKey("../../etc/passwd")).toBe(false);
    expect(isLoginOrgKey(null)).toBe(false);
  });

  it("remembers a valid key and returns it", () => {
    expect(rememberedLoginOrg()).toBeNull();
    rememberLoginOrg(KEY);
    expect(rememberedLoginOrg()).toBe(KEY);
  });

  it("never stores a malformed key, and ignores a malformed stored value", () => {
    rememberLoginOrg("not-a-key");
    expect(rememberedLoginOrg()).toBeNull();
    localStorage.setItem("ow-login-org", "javascript:alert(1)");
    expect(rememberedLoginOrg()).toBeNull();
  });

  it("falls back to nothing when storage throws", () => {
    const working = localStorage;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberLoginOrg(KEY)).not.toThrow();
    expect(rememberedLoginOrg()).toBeNull();
    vi.stubGlobal("localStorage", working);
  });
});
