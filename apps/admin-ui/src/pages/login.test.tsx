import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "../i18n.js";

vi.mock("../authProvider.js", () => ({
  userManager: {
    removeUser: vi.fn(),
    signinRedirect: vi.fn(),
  },
}));

const { Login } = await import("./login.js");
const { userManager } = await import("../authProvider.js");

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Login />
    </MemoryRouter>,
  );
}

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

  it("renders translated strings from the i18n common namespace", () => {
    renderAt("/login");

    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Continue with SSO/ }),
    ).toBeDefined();
    expect(screen.getByText("Contact your admin")).toBeDefined();
  });

  // Hosted ticket-create handoff (docs/specs/hosted-ticket-create-handoff.md,
  // spec R2 + T5) — the default login flow (no handoff query params) must be
  // completely unaffected by this feature's addition.
  it("with no handoff query params, a manual sign-in still calls signinRedirect with prompt: login and removeUser first", async () => {
    renderAt("/login");
    screen.getByRole("button", { name: /Continue with SSO/ }).click();

    await waitFor(() => {
      expect(userManager.removeUser).toHaveBeenCalled();
    });
    expect(userManager.signinRedirect).toHaveBeenCalledWith({
      prompt: "login",
    });
  });

  // Corrected after live testing: the handoff redirect is NOT auto-triggered
  // on mount (that skipped straight to Zitadel's hosted login page with no
  // visible OpenWind screen) -- the user still sees this page and clicks
  // Sign In themselves, same as the default flow.
  it("with handoff query params present, does nothing until the user clicks Sign In", async () => {
    renderAt(
      "/login?workflowId=wf-1&entityTypeId=et-1&title=Client+dinner&remark=needs+approval",
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(userManager.signinRedirect).not.toHaveBeenCalled();
  });

  it("with handoff query params present, clicking Sign In calls signinRedirect with state and WITHOUT prompt: login or removeUser (spec R1)", async () => {
    renderAt(
      "/login?workflowId=wf-1&entityTypeId=et-1&title=Client+dinner&remark=needs+approval",
    );
    screen.getByRole("button", { name: /Continue with SSO/ }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        state: {
          workflowId: "wf-1",
          entityTypeId: "et-1",
          prefillFields: { title: "Client dinner", remark: "needs approval" },
        },
      });
    });
    expect(userManager.removeUser).not.toHaveBeenCalled();
  });

  it("ignores handoff params missing workflowId or entityTypeId and falls back to normal login on click", async () => {
    renderAt("/login?title=Client+dinner");
    screen.getByRole("button", { name: /Continue with SSO/ }).click();

    await waitFor(() => {
      expect(userManager.signinRedirect).toHaveBeenCalledWith({
        prompt: "login",
      });
    });
    expect(userManager.removeUser).toHaveBeenCalled();
  });
});
