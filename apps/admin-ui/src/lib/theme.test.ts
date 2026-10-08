import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSavedTheme,
  getSavedAccent,
  applyTheme,
  applyAccent,
  initTheme,
  makeCustomAccent,
  hexToHsl,
  hslToHex,
  ACCENT_COLORS,
} from "./theme.js";

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe("theme module", () => {
  let mockStorage: MockStorage;
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    mockStorage = new MockStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      configurable: true,
      writable: true,
    });
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  describe("getSavedTheme and applyTheme", () => {
    it("defaults to dark theme when nothing is stored", () => {
      expect(getSavedTheme()).toBe("dark");
    });

    it("reads stored theme from localStorage", () => {
      mockStorage.setItem("ow_theme", "light");
      expect(getSavedTheme()).toBe("light");
    });

    it("applies theme mode to DOM and persists in localStorage", () => {
      applyTheme("light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(mockStorage.getItem("ow_theme")).toBe("light");
    });
  });

  describe("getSavedAccent and applyAccent", () => {
    it("defaults to teal accent when nothing is stored", () => {
      const accent = getSavedAccent();
      expect(accent.id).toBe("teal");
    });

    it("retrieves a saved predefined accent", () => {
      mockStorage.setItem("ow_accent", "purple");
      const accent = getSavedAccent();
      expect(accent.id).toBe("purple");
    });

    it("retrieves and parses a saved custom accent", () => {
      mockStorage.setItem("ow_accent", "custom");
      mockStorage.setItem("ow_accent_custom", "#ff0000");
      const accent = getSavedAccent();
      expect(accent.id).toBe("custom");
      expect(accent.h).toBe(0);
      expect(accent.s).toBe(100);
      expect(accent.l).toBe(50);
    });

    it("applies predefined accent CSS variables and persists to storage", () => {
      const purple = ACCENT_COLORS.find((c) => c.id === "purple")!;
      applyAccent(purple);

      const root = document.documentElement;
      expect(root.style.getPropertyValue("--accent-h")).toBe(String(purple.h));
      expect(root.style.getPropertyValue("--accent-s")).toBe(`${purple.s}%`);
      expect(root.style.getPropertyValue("--accent-l")).toBe(`${purple.l}%`);
      expect(mockStorage.getItem("ow_accent")).toBe("purple");
    });

    it("applies custom accent CSS variables and persists hex value", () => {
      const custom = makeCustomAccent("#00ff00");
      applyAccent(custom);

      expect(mockStorage.getItem("ow_accent")).toBe("custom");
      expect(mockStorage.getItem("ow_accent_custom")).toBe("#00ff00");
    });
  });

  describe("initTheme", () => {
    it("initializes theme and accent on DOM", () => {
      mockStorage.setItem("ow_theme", "light");
      mockStorage.setItem("ow_accent", "blue");

      initTheme();

      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(
        document.documentElement.style.getPropertyValue("--accent-h"),
      ).toBe("213");
    });
  });

  describe("Storage Guards (sandbox / disabled storage resilience)", () => {
    it("handles SecurityError / exception when reading localStorage.getItem", () => {
      vi.spyOn(mockStorage, "getItem").mockImplementation(() => {
        throw new DOMException(
          "Access denied by security settings",
          "SecurityError",
        );
      });

      expect(getSavedTheme()).toBe("dark");
      expect(getSavedAccent().id).toBe("teal");
    });

    it("handles SecurityError / exception when writing localStorage.setItem in applyTheme", () => {
      vi.spyOn(mockStorage, "setItem").mockImplementation(() => {
        throw new DOMException(
          "The quota has been exceeded or access denied",
          "QuotaExceededError",
        );
      });

      expect(() => applyTheme("light")).not.toThrow();
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });

    it("handles SecurityError / exception when writing localStorage.setItem in applyAccent (predefined)", () => {
      vi.spyOn(mockStorage, "setItem").mockImplementation(() => {
        throw new DOMException(
          "Access denied by security settings",
          "SecurityError",
        );
      });

      const blue = ACCENT_COLORS.find((c) => c.id === "blue")!;
      expect(() => applyAccent(blue)).not.toThrow();
      expect(
        document.documentElement.style.getPropertyValue("--accent-h"),
      ).toBe("213");
    });

    it("handles SecurityError / exception when writing localStorage.setItem in applyAccent (custom)", () => {
      vi.spyOn(mockStorage, "setItem").mockImplementation(() => {
        throw new DOMException(
          "Access denied by security settings",
          "SecurityError",
        );
      });

      const custom = makeCustomAccent("#ff8800");
      expect(() => applyAccent(custom)).not.toThrow();
      expect(
        document.documentElement.style.getPropertyValue("--accent-h"),
      ).toBe(String(custom.h));
    });

    it("initTheme succeeds cleanly when storage operations throw", () => {
      vi.spyOn(mockStorage, "getItem").mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });
      vi.spyOn(mockStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });

      expect(() => initTheme()).not.toThrow();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });

    it("functions execute safely when localStorage methods are undefined (restricted environment)", () => {
      Object.defineProperty(globalThis, "localStorage", {
        value: {},
        configurable: true,
        writable: true,
      });

      expect(getSavedTheme()).toBe("dark");
      expect(getSavedAccent().id).toBe("teal");
      expect(() => applyTheme("light")).not.toThrow();
      const blue = ACCENT_COLORS.find((c) => c.id === "blue")!;
      expect(() => applyAccent(blue)).not.toThrow();
      expect(() => initTheme()).not.toThrow();
    });
  });

  describe("color helpers", () => {
    it("converts hex to hsl and hsl to hex accurately", () => {
      const hsl = hexToHsl("#ffffff");
      expect(hsl).toEqual({ h: 0, s: 0, l: 100 });
      expect(hslToHex(0, 0, 100)).toBe("#ffffff");

      const black = hexToHsl("#000000");
      expect(black).toEqual({ h: 0, s: 0, l: 0 });
      expect(hslToHex(0, 0, 0)).toBe("#000000");
    });
  });
});
