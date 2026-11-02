import "../i18n.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Settings } from "./settings.js";

vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("../lib/api.js", () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({ data: [] }),
  API_URL: "http://localhost:3000",
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Settings Language tab (#1110)", () => {
  it("renders the language tab and lists all supported languages", () => {
    render(<Settings />);

    const languageTab = screen.getByRole("tab", { name: /language/i });
    expect(languageTab).toBeDefined();

    fireEvent.click(languageTab);

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeDefined();

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(11);
  });

  it("enables translated languages and marks untranslated languages as coming soon", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("tab", { name: /language/i }));

    const englishOption = screen.getByRole("option", { name: /english/i });
    expect(englishOption.hasAttribute("disabled")).toBe(false);
    expect(englishOption.getAttribute("aria-disabled")).toBe("false");
    expect(englishOption.getAttribute("aria-selected")).toBe("true");

    const comingSoonBadges = screen.getAllByText(/coming soon/i);
    expect(comingSoonBadges).toHaveLength(10);
  });

  it("disables clicking on untranslated languages", () => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("tab", { name: /language/i }));

    const disabledOptions = screen
      .getAllByRole("option")
      .filter((opt) => opt.hasAttribute("disabled"));

    expect(disabledOptions).toHaveLength(10);

    const firstDisabled = disabledOptions[0];
    expect(firstDisabled).toBeDefined();
    if (!firstDisabled) throw new Error("Expected disabled option");
    fireEvent.click(firstDisabled);

    const englishOption = screen.getByRole("option", { name: /english/i });
    expect(englishOption.getAttribute("aria-selected")).toBe("true");
  });
});
