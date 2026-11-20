import { describe, it, expect } from "vitest";
import { i18n, i18nReady, loadLocale } from "./i18n.js";
import fr from "./locales/fr/common.json";

describe("lazy locale loading (#1120)", () => {
  it("bundles only English up front", async () => {
    await i18nReady;
    expect(i18n.hasResourceBundle("en", "common")).toBe(true);
    expect(i18n.hasResourceBundle("fr", "common")).toBe(false);
  });

  it("loads a non-English bundle on demand", async () => {
    await loadLocale("fr");
    expect(i18n.hasResourceBundle("fr", "common")).toBe(true);
    expect(i18n.getResourceBundle("fr", "common")).toEqual(fr);
  });

  it("is idempotent for an already loaded locale", async () => {
    await loadLocale("fr");
    await expect(loadLocale("fr")).resolves.toBeUndefined();
    expect(i18n.getResourceBundle("fr", "common")).toEqual(fr);
  });

  it("ignores a language with no bundle, including path-like input", async () => {
    await expect(loadLocale("xx")).resolves.toBeUndefined();
    await expect(loadLocale("../../etc/passwd")).resolves.toBeUndefined();
    expect(i18n.hasResourceBundle("xx", "common")).toBe(false);
  });

  it("falls back to English for keys a loaded locale lacks", async () => {
    await loadLocale("de");
    i18n.addResource("de", "common", "onlyInGermanTest", "Hallo");
    expect(i18n.t("onlyInGermanTest", { lng: "de" })).toBe("Hallo");
    expect(i18n.t("roster.failedToSave", { lng: "de" })).not.toBe(
      "roster.failedToSave",
    );
  });
});
