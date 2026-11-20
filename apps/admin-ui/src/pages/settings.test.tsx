import "../i18n.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { User } from "oidc-client-ts";
import * as languageModule from "../lib/language.js";
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
  vi.restoreAllMocks();
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

  it("disables clicking on untranslated languages and does not invoke changeLocale", () => {
    const changeLocaleMock = vi.fn();
    vi.spyOn(languageModule, "useLocale").mockReturnValue({
      locale: "en",
      changeLocale: changeLocaleMock,
    });

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

    expect(changeLocaleMock).not.toHaveBeenCalled();

    const englishOption = screen.getByRole("option", { name: /english/i });
    expect(englishOption.getAttribute("aria-selected")).toBe("true");

    // Clicking an enabled option does invoke changeLocale
    fireEvent.click(englishOption);
    expect(changeLocaleMock).toHaveBeenCalledWith("en");
  });
});

describe("Settings Organization tab (#1158)", () => {
  it("renders the organization tab and shows the timezone selector", async () => {
    const { fetchWithAuth } = await import("../lib/api.js");
    vi.mocked(fetchWithAuth).mockResolvedValue({
      data: { defaultTimezone: "Asia/Kolkata" },
    });

    render(<Settings />);

    const orgTab = screen.getByRole("tab", { name: /organization/i });
    expect(orgTab).toBeDefined();

    fireEvent.click(orgTab);

    const select = screen.getByLabelText(/default timezone/i);
    expect(select).toBeDefined();
    // Non-admin by default
    expect(select.hasAttribute("disabled")).toBe(true);
  });

  it("allows admin to change the default timezone", async () => {
    const { userManager } = await import("../authProvider.js");
    const { fetchWithAuth } = await import("../lib/api.js");

    vi.mocked(userManager.getUser).mockResolvedValue({
      profile: {
        "urn:zitadel:iam:org:project:roles": { admin: {} },
      },
    } as unknown as User);

    vi.mocked(fetchWithAuth).mockResolvedValue({
      data: { defaultTimezone: null },
    });

    render(<Settings />);

    // Wait for user role to load
    await new Promise((r) => setTimeout(r, 10));

    const orgTab = screen.getByRole("tab", { name: /organization/i });
    fireEvent.click(orgTab);

    const select = screen.getByLabelText(/default timezone/i);
    expect(select.hasAttribute("disabled")).toBe(false);

    fireEvent.change(select, { target: { value: "Europe/London" } });

    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining("/admin/tenant-settings"),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ defaultTimezone: "Europe/London" }),
      }),
    );
  });
});
