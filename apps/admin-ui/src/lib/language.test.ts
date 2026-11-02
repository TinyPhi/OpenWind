import { describe, it, expect, beforeEach } from "vitest";
import "../i18n.js";

// Import after i18n initialises so the module sees a live i18n instance.
const {
  getSavedLanguage,
  setSavedLanguage,
  changeLocale,
  SUPPORTED_LANGUAGES,
  TRANSLATED_LANGUAGES,
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

  it("returns the stored value when it is an enabled translated language", () => {
    localStorage.setItem(STORAGE_KEY, "en");
    expect(getSavedLanguage()).toBe("en");
  });

  it("falls back to en when localStorage holds an untranslated supported language", () => {
    localStorage.setItem(STORAGE_KEY, "hi");
    expect(getSavedLanguage()).toBe("en");
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

  it("returns en when localStorage holds a script tag injection attempt", () => {
    localStorage.setItem(STORAGE_KEY, "<script>alert(1)</script>");
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
  it("updates document.documentElement.lang to the validated translated code", async () => {
    await changeLocale("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("falls back to en when attempting an untranslated supported language", async () => {
    await changeLocale("de");
    expect(document.documentElement.lang).toBe("en");
  });

  it("does not set document.lang to an unrecognised code", async () => {
    document.documentElement.lang = "en";
    await changeLocale("zz");
    expect(document.documentElement.lang).toBe("en");
  });

  it("does not set document.lang to a script injection attempt", async () => {
    document.documentElement.lang = "en";
    await changeLocale("<script>alert('xss')</script>");
    expect(document.documentElement.lang).toBe("en");
  });

  it("persists the validated code to localStorage", async () => {
    await changeLocale("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("persists en to localStorage when attempting an untranslated language", async () => {
    await changeLocale("es");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
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

describe("TRANSLATED_LANGUAGES", () => {
  it("contains en", () => {
    expect(TRANSLATED_LANGUAGES).toContain("en");
  });

  it("is a subset of SUPPORTED_LANGUAGES", () => {
    for (const lng of TRANSLATED_LANGUAGES) {
      expect(SUPPORTED_LANGUAGES).toContain(lng);
    }
  });
});
