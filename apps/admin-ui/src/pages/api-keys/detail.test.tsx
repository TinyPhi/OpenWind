import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mockFetchWithAuth = vi.fn(
  (..._args: unknown[]): Promise<unknown> => Promise.resolve(null),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockShowAlert = vi.fn((_message: string): void => undefined);
vi.mock("../../components/global-alert-dialog.js", () => ({
  showAlert: (message: string) => mockShowAlert(message),
}));

const { ApiKeyApplicationDetail } = await import("./detail.js");

const ACME_SLUG = encodeURIComponent("acme helpdesk sync");

function renderPage(slug: string = ACME_SLUG): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[`/admin/api-keys/${slug}`]}>
      <Routes>
        <Route
          path="/admin/api-keys/:slug"
          element={<ApiKeyApplicationDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

const ACTIVE_KEY = {
  id: "key-1",
  name: "acme-key",
  scopes: ["entity:ticket:read"],
  scopesFormat: "action" as const,
  applicationName: "Acme Helpdesk Sync",
  applicationDescription: "Syncs tickets nightly",
  applicationContactEmail: "ops@acme.example",
  rotatedFrom: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: "admin-1",
  expiresAt: "2027-01-01T00:00:00Z",
  revokedAt: null,
};

const REVOKED_KEY = {
  ...ACTIVE_KEY,
  id: "key-2",
  applicationName: "Old Integration",
  revokedAt: "2026-02-01T00:00:00Z",
};

// AccessLogsPanel makes its own fetchWithAuth call (via
// listThirdPartyAccessLogs) as soon as this page mounts — always stub a
// resolved response for it so tests don't need to know its exact call shape
// unless they're specifically testing it.
function stubAccessLogsFetch(): void {
  mockFetchWithAuth.mockImplementation((url: unknown) => {
    if (
      typeof url === "string" &&
      url.includes("/admin/third-party-access-logs")
    ) {
      return Promise.resolve({ data: [], nextCursor: null });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("ApiKeyApplicationDetail (admin-ui API Keys restructuring)", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });
  afterEach(() => cleanup());

  it("shows an 'Application not found' state for a slug matching no application", async () => {
    stubAccessLogsFetch();
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage(encodeURIComponent("does not exist"));

    await screen.findByText("Application not found");
  });

  it("sorts this application's keys newest-first, so a rotation's dying predecessor and its new successor show together at the top", async () => {
    stubAccessLogsFetch();
    const older = {
      ...ACTIVE_KEY,
      id: "key-old",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const newer = {
      ...ACTIVE_KEY,
      id: "key-new",
      createdAt: "2026-06-01T00:00:00Z",
    };
    mockFetchWithAuth.mockResolvedValueOnce({ data: [older, newer] });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));

    const rows = screen.getAllByRole("row").slice(1); // drop header row
    const firstRowText = rows[0]?.textContent ?? "";
    const secondRowText = rows[1]?.textContent ?? "";
    expect(firstRowText).toContain("Jun");
    expect(secondRowText).toContain("Jan");
  });

  it("renders the application name as the page title, created-by, and a Read-only scope summary for an active key", async () => {
    stubAccessLogsFetch();
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ACTIVE_KEY] });
    renderPage();

    await screen.findByRole("heading", { name: "Acme Helpdesk Sync" });
    expect(screen.getByText("admin-1")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("shows a Revoked status and hides the row's kebab menu for a revoked key", async () => {
    stubAccessLogsFetch();
    mockFetchWithAuth.mockResolvedValueOnce({ data: [REVOKED_KEY] });
    renderPage(encodeURIComponent("old integration"));

    await screen.findByRole("heading", { name: "Old Integration" });
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("shows an amber expiry badge for a key expiring within 30 days", async () => {
    stubAccessLogsFetch();
    const soon = {
      ...ACTIVE_KEY,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    mockFetchWithAuth.mockResolvedValueOnce({ data: [soon] });
    renderPage();

    await screen.findByText(/Expires in \d+ days?/);
  });

  it("shows a red 'Expired' badge for a past-expiry key", async () => {
    stubAccessLogsFetch();
    const expired = {
      ...ACTIVE_KEY,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    mockFetchWithAuth.mockResolvedValueOnce({ data: [expired] });
    renderPage();

    // Both the expiry badge and the status column read "Expired" for an
    // expired-but-not-revoked key — confirm both render, not just one.
    const matches = await screen.findAllByText("Expired");
    expect(matches).toHaveLength(2);
  });

  it("opens the kebab menu, then the Emergency Rotate confirm dialog with its distinct warning copy, and calls the endpoint on confirm", async () => {
    mockFetchWithAuth.mockImplementation((url: unknown) => {
      if (
        typeof url === "string" &&
        url.includes("/admin/third-party-access-logs")
      ) {
        return Promise.resolve({ data: [], nextCursor: null });
      }
      return Promise.resolve({ data: [ACTIVE_KEY] });
    });
    renderPage();
    await screen.findByRole("heading", { name: "Acme Helpdesk Sync" });

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Emergency Rotate" }));
    await screen.findByText(/breaks immediately/i);

    mockFetchWithAuth.mockImplementationOnce((url: unknown) => {
      if (url === "/api/api-keys/key-1/emergency-rotate") {
        return Promise.resolve({
          data: { id: "key-3", key: "sk_live_new", expiresAt: null },
        });
      }
      return Promise.resolve({ data: [] });
    });
    // refresh() after the action — a real emergency-rotate revokes the old
    // key and creates a new one under the SAME applicationName, so the
    // application is still found afterward (never an empty list).
    mockFetchWithAuth.mockImplementationOnce(() =>
      Promise.resolve({
        data: [{ ...ACTIVE_KEY, revokedAt: "2026-07-01T00:00:00Z" }],
      }),
    );

    // The dialog's own confirm button is the only "Emergency Rotate" button
    // left — the kebab menu item closed when it was clicked above.
    fireEvent.click(screen.getByRole("button", { name: "Emergency Rotate" }));

    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/api-keys/key-1/emergency-rotate",
        { method: "POST" },
      ),
    );

    // Shown in the KeyRevealModal (with a copy button), not a plain
    // text alert — the raw key is only ever shown once.
    await screen.findByText("sk_live_new");
    expect(screen.getByRole("button", { name: /copy key/i })).toBeTruthy();
  });

  it("renders an access-logs panel locked to this application's key ids", async () => {
    stubAccessLogsFetch();
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ACTIVE_KEY] });
    renderPage();

    await screen.findByText("Access logs for this application");
    // Locked mode hides the free-text Application (key id) filter entirely.
    expect(screen.queryByPlaceholderText("api key uuid")).toBeNull();
  });
});
