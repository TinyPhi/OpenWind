import { describe, it, expect, beforeEach } from "vitest";
import "../i18n.js";

// Import after i18n initialises so the module sees a live i18n instance.
const {
  getSavedLanguage,
  setSavedLanguage,
  changeLocale,
  SUPPORTED_LANGUAGES,
} = await import("./language.js");

const STORAGE_KEY = "ow:language";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("getSavedLanguage", () => {
  it("returns en when localStorage is empty", () => {
    expect(getSavedLanguage()).toBe("en");
  });

  it("returns the stored value when it is a valid supported language", () => {
    localStorage.setItem(STORAGE_KEY, "hi");
    expect(getSavedLanguage()).toBe("hi");
  });

  it("returns en when localStorage holds an unrecognised code", () => {
    localStorage.setItem(STORAGE_KEY, "xx");
    expect(getSavedLanguage()).toBe("en");
  });

  it("returns en when localStorage holds an empty string", () => {
    localStorage.setItem(STORAGE_KEY, "");
    expect(getSavedLanguage()).toBe("en");
  });

  it("returns en when localStorage holds a path-like injection attempt", () => {
    localStorage.setItem(STORAGE_KEY, "../../etc/passwd");
    expect(getSavedLanguage()).toBe("en");
  });
});

describe("setSavedLanguage", () => {
  it("writes the value to localStorage", () => {
    setSavedLanguage("fr");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("fr");
  });
});

describe("changeLocale", () => {
  it("updates document.documentElement.lang to the validated code", async () => {
    await changeLocale("de");
    expect(document.documentElement.lang).toBe("de");
  });

  it("does not set document.lang to an unrecognised code", async () => {
    document.documentElement.lang = "en";
    await changeLocale("zz");
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists the validated code to localStorage", async () => {
    await changeLocale("es");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("es");
  });

  it("writes en to localStorage when given an invalid code", async () => {
    await changeLocale("invalid");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("contains exactly 11 entries including en", () => {
    expect(SUPPORTED_LANGUAGES).toHaveLength(11);
    expect(SUPPORTED_LANGUAGES).toContain("en");
  });
});
