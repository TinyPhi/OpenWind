import type { ReactElement } from "react";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import "../i18n.js";

vi.mock("../authProvider.js", () => ({
  userManager: {
    removeUser: vi.fn(),
    signinRedirect: vi.fn(),
  },
}));

const { Login } = await import("./login.js");
const { userManager } = await import("../authProvider.js");

function Where(): ReactElement {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Login />
    </MemoryRouter>,
  );
}

afterEach(() => {
  // a matched sandbox link is remembered in storage; keep that out of the next test
  localStorage.clear();
});

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe("returning to an organisation's own login link", () => {
    const KEY = "d06206191c8c8062";
    function renderRouted(path: string): ReturnType<typeof render> {
      return render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/login"
              element={
                <>
                  <Login />
                  <Where />
                </>
              }
            />
          </Routes>
        </MemoryRouter>,
      );
    }

    afterEach(() => {
      localStorage.clear();
    });

    it("sends plain /login on to the remembered organisation link", () => {
      localStorage.setItem("ow-login-org", KEY);
      renderRouted("/login");
      expect(screen.getByTestId("where").textContent).toBe(`/login?org=${KEY}`);
    });

    it("leaves plain /login alone when nothing is remembered", () => {
      renderRouted("/login");
      expect(screen.getByTestId("where").textContent).toBe("/login");
    });

    it("does not redirect when the link already names an organisation", () => {
      localStorage.setItem("ow-login-org", "aaaaaaaaaaaaaaaa");
      renderRouted(`/login?org=${KEY}`);
      expect(screen.getByTestId("where").textContent).toBe(`/login?org=${KEY}`);
    });

    it("ignores a remembered value that is not a valid key", () => {
      localStorage.setItem("ow-login-org", "not-valid");
      renderRouted("/login");
      expect(screen.getByTestId("where").textContent).toBe("/login");
    });
  });

  it("renders translated strings from the i18n common namespace", () => {
    renderAt("/login");

    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Login" })).toBeDefined();
    expect(screen.getByText("Contact us")).toBeDefined();
  });

  it("'Contact us' opens a Gmail trial-request draft to info@rokkalabs.com in a new tab", () => {
    renderAt("/login");

    const link = screen.getByRole("link", { name: "Contact us" });
    const href = new URL(link.getAttribute("href") ?? "");
    expect(href.origin).toBe("https://mail.google.com");
    expect(href.searchParams.get("to")).toBe("info@rokkalabs.com");
    expect(href.searchParams.get("su")).toMatch(/trial/i);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows no brand at the top left (neither OpenWind nor an org) and no footer", () => {
    const { container } = renderAt("/login");

    expect(container.querySelector(".lp-float-logo")).toBeNull();
    expect(container.querySelector("img.logo-icon")).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.queryByText(/© 2026/)).toBeNull();
  });

  // Hosted ticket-create handoff (docs/specs/hosted-ticket-create-handoff.md,
  // spec R2 + T5) — the default login flow (no handoff query params) must be
  // completely unaffected by this feature's addition.
  it("with no handoff query params, a manual sign-in still calls signinRedirect with prompt: login and removeUser first", async () => {
    renderAt("/login");
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.removeUser).toHaveBeenCalled();
    });
    expect(userManager.signinRedirect).toHaveBeenCalledWith({
      prompt: "login",
    });
  });

  it("shows a sign-in failure to the user, logs it, and re-enables the button", async () => {
    const failure = new Error(
      "Crypto.subtle is available only in secure contexts (HTTPS)",
    );
    vi.mocked(userManager.signinRedirect).mockRejectedValueOnce(failure);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderAt("/login");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Sign-in failed before redirect:",
        failure,
      );
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Login" }).hasAttribute("disabled"),
      ).toBe(false);
    });
    // A fixed sentence for the user; the raw error stays out of the page.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "Sign-in failed. If this continues, please contact support.",
    );
    expect(document.body.textContent).not.toContain("Crypto.subtle");
    consoleError.mockRestore();
  });

  it("shows the same message when the handoff sign-in fails", async () => {
    vi.mocked(userManager.signinRedirect).mockRejectedValueOnce(
      new Error("discovery failed"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderAt(
      "/login?workflowId=11111111-1111-4111-a111-111111111111&entityTypeId=22222222-2222-4222-a222-222222222222&appClientId=app-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in failed. If this continues, please contact support.",
    );
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Corrected after live testing: the handoff redirect is NOT auto-triggered
  // on mount (that skipped straight to Zitadel's hosted login page with no
  // visible OpenWind screen) -- the user still sees this page and clicks
  // Sign In themselves, same as the default flow.
  it("with handoff query params present, does nothing until the user clicks Sign In", async () => {
    renderAt(
      "/login?workflowId=11111111-1111-4111-a111-111111111111&entityTypeId=22222222-2222-4222-a222-222222222222&title=Client+dinner&remark=needs+approval&appClientId=app-1",
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(userManager.signinRedirect).not.toHaveBeenCalled();
  });

  it("with handoff query params present, clicking Sign In calls signinRedirect with state and WITHOUT prompt: login or removeUser (spec R1)", async () => {
    renderAt(
      "/login?workflowId=11111111-1111-4111-a111-111111111111&entityTypeId=22222222-2222-4222-a222-222222222222&title=Client+dinner&remark=needs+approval&appClientId=app-1",
    );
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        state: {
          workflowId: "11111111-1111-4111-a111-111111111111",
          entityTypeId: "22222222-2222-4222-a222-222222222222",
          prefillFields: { title: "Client dinner", remark: "needs approval" },
          appClientId: "app-1",
        },
      });
    });
    expect(userManager.removeUser).not.toHaveBeenCalled();
  });

  it("ignores handoff params missing workflowId or entityTypeId and falls back to normal login on click", async () => {
    renderAt("/login?title=Client+dinner");
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        prompt: "login",
      });
    });
    expect(userManager.removeUser).toHaveBeenCalled();
  });

  // issue #544 — UUID_RE defence-in-depth guard in readHandoffParams
  it("rejects a non-UUID workflowId and falls back to normal login", async () => {
    renderAt(
      "/login?workflowId=not-a-uuid&entityTypeId=22222222-2222-4222-a222-222222222222&appClientId=app-1",
    );
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        prompt: "login",
      });
    });
    expect(userManager.removeUser).toHaveBeenCalled();
  });

  it("rejects a non-UUID entityTypeId and falls back to normal login", async () => {
    renderAt(
      "/login?workflowId=11111111-1111-4111-a111-111111111111&entityTypeId=et-1&appClientId=app-1",
    );
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        prompt: "login",
      });
    });
    expect(userManager.removeUser).toHaveBeenCalled();
  });

  it("accepts all fields when workflowId/entityTypeId are valid UUIDs and appClientId is present (positive path)", async () => {
    renderAt(
      "/login?workflowId=11111111-1111-4111-a111-111111111111&entityTypeId=22222222-2222-4222-a222-222222222222&appClientId=app-1",
    );
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        state: {
          workflowId: "11111111-1111-4111-a111-111111111111",
          entityTypeId: "22222222-2222-4222-a222-222222222222",
          prefillFields: {},
          appClientId: "app-1",
        },
      });
    });
    expect(userManager.removeUser).not.toHaveBeenCalled();
  });

  // docs/specs/third-party-api-origin-tagging.md R2 -- appClientId is
  // required exactly like workflowId/entityTypeId (not optional), so a
  // handoff URL missing it must be treated identically: fall back to normal
  // login, never a partial/untagged handoff attempt.
  it("ignores handoff params missing appClientId and falls back to normal login on click", async () => {
    renderAt(
      "/login?workflowId=11111111-1111-4111-a111-111111111111&entityTypeId=22222222-2222-4222-a222-222222222222&title=Client+dinner",
    );
    screen.getByRole("button", { name: "Login" }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        prompt: "login",
      });
    });
    expect(userManager.removeUser).toHaveBeenCalled();
  });
});

// docs/specs/multi-org-sandbox.md R13 -- a sandbox's own login link shows its brand; every other way
// of reaching the page (plain /login, every miss, a lookup still running) shows no brand at all.
describe("Login brand for a sandbox login link", () => {
  const mockFetch = vi.fn();
  const KEY = "3f9a1c7e2b4d8a60";
  const initialTitle = document.title;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    document.title = initialTitle;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.title = initialTitle;
  });

  function ok(data: unknown): Response {
    return new Response(JSON.stringify({ data }), { status: 200 });
  }

  function brand(container: HTMLElement): Element | null {
    return container.querySelector(".lp-float-logo");
  }

  function crumb(container: HTMLElement): string {
    return container.querySelector(".lp-notebook-crumb")?.textContent ?? "";
  }

  /** Everything the page draws as a brand: top-left block, breadcrumb, tab title. */
  function brandAreas(container: HTMLElement): string {
    return [
      brand(container)?.textContent ?? "",
      crumb(container),
      document.title,
    ].join(" | ");
  }

  it("shows the sandbox's logo and name at the top left", async () => {
    mockFetch.mockResolvedValue(
      ok({ name: "Acme Demo", logo: "data:image/png;base64,AAAA" }),
    );

    const { container } = renderAt(`/login?org=${KEY}`);

    await waitFor(() =>
      expect(brand(container)?.textContent).toContain("Acme Demo"),
    );
    expect(
      brand(container)?.querySelector('img[src="data:image/png;base64,AAAA"]'),
    ).not.toBeNull();
    expect(
      brand(container)?.querySelector('img[src="/favicon.svg"]'),
    ).toBeNull();
  });

  it("shows the initials tile and name when the sandbox has no logo", async () => {
    mockFetch.mockResolvedValue(ok({ name: "Acme Demo", logo: null }));

    const { container } = renderAt(`/login?org=${KEY}`);

    await waitFor(() =>
      expect(brand(container)?.textContent).toContain("Acme Demo"),
    );
    expect(brand(container)?.textContent).toContain("AD");
    expect(brand(container)?.querySelector("img")).toBeNull();
  });

  it("names the sandbox in the card's breadcrumb", async () => {
    mockFetch.mockResolvedValue(ok({ name: "Acme Demo", logo: null }));

    const { container } = renderAt(`/login?org=${KEY}`);

    await waitFor(() => expect(crumb(container)).toContain("Acme Demo"));
    expect(crumb(container)).toBe("Acme Demo/Sign in");
  });

  it("sets the browser tab title to the sandbox's name, and puts the old one back on leaving", async () => {
    mockFetch.mockResolvedValue(ok({ name: "Acme Demo", logo: null }));
    document.title = "before";

    const view = renderAt(`/login?org=${KEY}`);

    await waitFor(() => expect(document.title).toBe("Acme Demo"));
    view.unmount();
    expect(document.title).toBe("before");
  });

  it("leaves the rest of the page, and signing in, exactly as before", async () => {
    mockFetch.mockResolvedValue(ok({ name: "Acme Demo", logo: null }));

    renderAt(`/login?org=${KEY}`);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    await waitFor(() =>
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        prompt: "login",
      }),
    );
  });

  it("does not wait for the lookup before signing in", () => {
    mockFetch.mockReturnValue(new Promise(() => undefined));

    renderAt(`/login?org=${KEY}`);

    expect(
      screen.getByRole("button", { name: "Login" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("carries the org value into the lookup only, never into the sign-in redirect", async () => {
    mockFetch.mockResolvedValue(ok({ name: "Acme Demo", logo: null }));

    renderAt(`/login?org=${KEY}`);
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => expect(userManager.signinRedirect).toHaveBeenCalled());
    expect(userManager.signinRedirect).toHaveBeenCalledWith({
      prompt: "login",
    });
  });

  describe("with no match, the page carries no brand at all", () => {
    function expectBlank(container: HTMLElement): void {
      expect(brand(container)).toBeNull();
      expect(container.querySelector("img.logo-icon")).toBeNull();
      expect(crumb(container)).toBe("Sign in");
      expect(document.title).toBe("Sign in");
      expect(brandAreas(container)).not.toMatch(/openwind/i);
    }

    it("on plain /login, with no lookup", () => {
      const { container } = renderAt("/login");

      expect(mockFetch).not.toHaveBeenCalled();
      expectBlank(container);
    });

    it("while the lookup is still running, never flashing a name first", () => {
      mockFetch.mockReturnValue(new Promise(() => undefined));

      const { container } = renderAt(`/login?org=${KEY}`);

      expectBlank(container);
    });

    it.each([
      [
        "an edited or unknown key (404)",
        () => Promise.resolve(new Response("{}", { status: 404 })),
      ],
      [
        "a rate limit (429)",
        () => Promise.resolve(new Response("{}", { status: 429 })),
      ],
      [
        "a server error (500)",
        () => Promise.resolve(new Response("{}", { status: 500 })),
      ],
      [
        "a network failure",
        () => Promise.reject(new TypeError("Failed to fetch")),
      ],
      [
        "a malformed answer",
        () => Promise.resolve(ok({ name: 42, logo: "x" })),
      ],
      [
        "a logo that is not a raster data URL",
        () =>
          Promise.resolve(
            ok({ name: "Acme Demo", logo: "https://evil.example/pixel.png" }),
          ),
      ],
    ])("for %s, once the lookup has finished", async (_label, answer) => {
      mockFetch.mockImplementation(answer);

      const { container } = renderAt(`/login?org=${KEY}`);

      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expectBlank(container);
      expect(screen.getByRole("button", { name: "Login" })).toBeDefined();
    });

    it.each([
      ["a readable slug", "acme-demo-4821"],
      ["markup", "%3Cscript%3E"],
      [
        "a key with one character changed to a non-hex letter",
        "3f9a1c7e2b4d8a6g",
      ],
      ["a key one character short", "3f9a1c7e2b4d8a6"],
      ["an empty value", ""],
    ])("for %s, without even asking the server", (_label, value) => {
      const { container } = renderAt(`/login?org=${value}`);

      expect(mockFetch).not.toHaveBeenCalled();
      expectBlank(container);
    });

    it("never shows OpenWind in any brand area, whatever the miss", async () => {
      mockFetch.mockResolvedValue(new Response("{}", { status: 404 }));

      const { container } = renderAt(`/login?org=${KEY}`);

      await waitFor(() => expect(mockFetch).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(brandAreas(container)).not.toMatch(/openwind/i);
    });
  });
});
