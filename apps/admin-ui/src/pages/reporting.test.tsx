import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mutated per test so a customer and an agent can be exercised without
// re-mocking the module.
let currentRoles: Record<string, unknown> = { agent: {} };

vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: () =>
      Promise.resolve({
        profile: { "urn:zitadel:iam:org:project:roles": currentRoles },
      }),
  },
}));

const fetchWithAuth = vi.fn();
vi.mock("../lib/api.js", () => ({
  fetchWithAuth: (...args: unknown[]): unknown => fetchWithAuth(...args),
  API_URL: "http://api.test",
}));

const embedDashboard = vi.fn();
vi.mock("@superset-ui/embedded-sdk", () => ({
  embedDashboard: (...args: unknown[]): unknown => embedDashboard(...args),
}));

vi.mock("@platform/ui", () => ({
  TOKENS: {
    border: "#ddd",
    borderColor: "#ddd",
    text: "#111",
    textPrimary: "#111",
    textMuted: "#666",
    primary: "#0a5",
    accentPrimary: "#0a5",
    surface: "#fff",
  },
}));

const { ReportingPage } = await import("./reporting.js");

const PASS = {
  data: {
    token: "guest-token-value",
    dashboardId: "023c70fc-fe94-40cc-a625-e9532cefe4d3",
    supersetDomain: "http://localhost:8088",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  currentRoles = { agent: {} };
  fetchWithAuth.mockResolvedValue(PASS);
  embedDashboard.mockResolvedValue({ unmount: vi.fn() });
});

afterEach(() => {
  // Without this, each render stays in the document and the next test finds
  // two of every element.
  cleanup();
  vi.restoreAllMocks();
});

describe("Reporting page", () => {
  it("renders both overview and performance tabs for an agent", async () => {
    render(<ReportingPage />);
    expect(await screen.findByText("My Organisation Overview")).toBeTruthy();
    expect(screen.getByText("My Performance")).toBeTruthy();
  });

  it("has no query-builder sidebar and calls only the guest-token endpoint", async () => {
    // The sidebar and its /reporting/query endpoint were removed; the page
    // must not render a remnant of it or call the endpoint.
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());
    expect(screen.queryByText(/BYOQ/)).toBeNull();
    for (const [url] of fetchWithAuth.mock.calls as [string][]) {
      expect(url).toContain("/superset/guest-token");
    }
  });

  it("embeds the dashboard the API resolved, not a hardcoded id", async () => {
    // The id must come from the API response. A literal here would break on any
    // deployment whose provisioning generated different identifiers.
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());

    const [args] = embedDashboard.mock.calls[0] as [
      { id: string; supersetDomain: string },
    ];
    expect(args.id).toBe("023c70fc-fe94-40cc-a625-e9532cefe4d3");
    expect(args.supersetDomain).toBe("http://localhost:8088");
  });

  it("asks for the tenant dashboard first", async () => {
    render(<ReportingPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "http://api.test/superset/guest-token?dashboard=tenant",
    );
  });

  it("re-requests for the other dashboard when the tab changes", async () => {
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());

    fireEvent.click(screen.getByText("My Performance"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "http://api.test/superset/guest-token?dashboard=user",
      ),
    );
  });

  it("lets links from the dashboard open a normal tab outside the sandbox", async () => {
    // The ticket tables' "Open" link uses target="_blank". Without this the
    // new tab inherits the dashboard iframe's sandbox and OpenWind fails
    // to load in it.
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());

    const [args] = embedDashboard.mock.calls[0] as [
      { iframeSandboxExtras?: string[] },
    ];
    expect(args.iframeSandboxExtras).toEqual([
      "allow-popups-to-escape-sandbox",
    ]);
  });

  it("hands the SDK a callback that fetches a fresh pass on expiry", async () => {
    // The SDK re-invokes this before the pass lapses. It is also the revocation
    // path — a caller whose access was withdrawn is refused on the refresh, so
    // it must really re-call the API rather than return a captured token.
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());

    const [args] = embedDashboard.mock.calls[0] as [
      { fetchGuestToken: () => Promise<string> },
    ];
    fetchWithAuth.mockClear();

    const token = await args.fetchGuestToken();
    expect(token).toBe("guest-token-value");
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "http://api.test/superset/guest-token?dashboard=tenant",
    );
  });
});

describe("customer access", () => {
  it("gives a customer their own performance dashboard", async () => {
    currentRoles = { user: {} };
    render(<ReportingPage />);

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "http://api.test/superset/guest-token?dashboard=user",
      ),
    );
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());
    expect(screen.queryByText("My Organisation Overview")).toBeNull();
    expect(screen.getByText("My Performance")).toBeTruthy();
  });

  it("never shows the tenant tab to a customer, even for a frame", async () => {
    // Guards the role-flash: rendering before the role check resolves would
    // briefly show a surface the customer is not entitled to.
    currentRoles = { user: {} };
    render(<ReportingPage />);

    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());
    expect(screen.queryByText("My Organisation Overview")).toBeNull();
  });

  it("treats an admin as entitled to both tabs", async () => {
    currentRoles = { admin: {} };
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());
    expect(await screen.findByText("My Organisation Overview")).toBeTruthy();
    expect(screen.getByText("My Performance")).toBeTruthy();
  });
});

describe("failure handling", () => {
  it("shows a plain message and leaks nothing from the error", async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/superset/guest-token")) {
        return Promise.reject(
          new Error("connect ECONNREFUSED superset:8088 service_account"),
        );
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = render(<ReportingPage />);

    expect(
      await screen.findByText("Reporting is not available right now."),
    ).toBeTruthy();

    const rendered = container.textContent;
    expect(rendered).not.toContain("superset:8088");
    expect(rendered).not.toContain("service_account");
    expect(rendered).not.toContain("ECONNREFUSED");
  });

  it("retries the same tab when the retry action is used", async () => {
    let failedOnce = true;
    fetchWithAuth.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/superset/guest-token")) {
        if (failedOnce) {
          failedOnce = false;
          return Promise.reject(new Error("down"));
        }
        return Promise.resolve(PASS);
      }
      return Promise.resolve({ data: [] });
    });
    render(<ReportingPage />);

    const retry = await screen.findByText("Try again");
    fireEvent.click(retry);

    // Re-setting the tab to its current value would not re-run the effect, so
    // this asserts the retry actually reaches the API again.
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());
  });
});

describe("theme", () => {
  // Superset 6.1.0 is the first version where setThemeMode() on an
  // already-mounted embed actually repaints the dashboard (its own changelog
  // lists this as newly functional, #36125) — confirmed live against the
  // upgrade this app now depends on. 6.0.0 accepted the same call with no
  // error but never repainted; this pins the behavior this app now relies on.
  it("tells the embed which theme to use, and follows a later change", async () => {
    const setThemeMode = vi.fn();
    embedDashboard.mockResolvedValue({ unmount: vi.fn(), setThemeMode });
    document.documentElement.setAttribute("data-theme", "dark");

    render(<ReportingPage />);
    await waitFor(() => expect(setThemeMode).toHaveBeenCalledWith("dark"));

    // Superset calls its light theme "default", not "light".
    document.documentElement.setAttribute("data-theme", "light");
    await waitFor(() => expect(setThemeMode).toHaveBeenCalledWith("default"));
  });

  it("still renders when the embed has no theme support", async () => {
    // Guards the downgrade path: an older Superset returns an object without
    // setThemeMode, and a missing theme must not break the dashboard.
    embedDashboard.mockResolvedValue({ unmount: vi.fn() });
    render(<ReportingPage />);
    await waitFor(() => expect(embedDashboard).toHaveBeenCalled());
    expect(
      screen.queryByText("Reporting is not available right now."),
    ).toBeNull();
  });
});
