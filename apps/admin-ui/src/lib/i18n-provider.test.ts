import { describe, it, expect, vi } from "vitest";
import { createI18nProvider } from "./i18n-provider.js";

describe("createI18nProvider", () => {
  it("delegates translate to the provided translation function", () => {
    const mockTranslate = vi.fn((key: string) => `translated:${key}`);
    const provider = createI18nProvider(mockTranslate, () => "en");

    expect(provider.translate("common.save")).toBe("translated:common.save");
    expect(mockTranslate).toHaveBeenCalledWith("common.save", undefined);
  });

  it("passes interpolation parameters to translate", () => {
    const mockTranslate = vi.fn(
      (key: string, params?: Record<string, unknown>) =>
        `${key}:${params?.name}`,
    );
    const provider = createI18nProvider(mockTranslate, () => "en");

    expect(provider.translate("greeting", { name: "Alice" })).toBe(
      "greeting:Alice",
    );
    expect(mockTranslate).toHaveBeenCalledWith("greeting", { name: "Alice" });
  });

  it("delegates getLocale to the provided getLocaleFn", () => {
    let current = "en";
    const provider = createI18nProvider(vi.fn(), () => current);

    expect(provider.getLocale()).toBe("en");
    current = "hi";
    expect(provider.getLocale()).toBe("hi");
  });

  it("delegates changeLocale to the provided changeLocaleFn", async () => {
    const mockChangeLocale = vi.fn().mockResolvedValue(undefined);
    const provider = createI18nProvider(vi.fn(), () => "en", mockChangeLocale);

    await provider.changeLocale("en");
    expect(mockChangeLocale).toHaveBeenCalledWith("en");
  });
});
