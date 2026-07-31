import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import "../i18n.js";

vi.mock("../authProvider.js", () => ({
  userManager: {
    removeUser: vi.fn(),
    signinRedirect: vi.fn(),
  },
}));

const { Login } = await import("./login.js");

beforeAll(() => {
  // This Node/jsdom combination leaves the bare `localStorage` global
  // disabled unless --localstorage-file is passed to node — unrelated to
  // this i18n change, stub it so the component's existing theme-preference
  // read doesn't throw during render.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
});

describe("Login", () => {
  it("renders translated strings from the i18n common namespace", () => {
    render(<Login />);

    expect(
      screen.getByRole("heading", { name: "Sign in to OpenWind" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Sign in with Zitadel/ }),
    ).toBeDefined();
    expect(screen.getByText("Contact your admin")).toBeDefined();
  });
});
