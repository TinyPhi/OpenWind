import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import React from "react";

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

const { ApiKeys } = await import("./index.js");

function renderPage(): ReturnType<typeof render> {
  return render(React.createElement(ApiKeys));
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

describe("ApiKeys list page (ADR-012 Phase A spec R10, PR A5)", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
  });
  afterEach(() => cleanup());

  it("fetches with includeRevoked=true so revoked keys are part of the lifecycle view", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();
    await waitFor(() =>
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/api-keys?includeRevoked=true",
      ),
    );
  });

  it("sorts rows newest-first, so a rotation's dying predecessor and its new successor show together at the top", async () => {
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

  it("renders application name, created-by, and a Read-only scope summary for an active key", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ACTIVE_KEY] });
    renderPage();

    await screen.findByText("Acme Helpdesk Sync");
    expect(screen.getByText("admin-1")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("shows a Revoked status and hides the row's kebab menu for a revoked key", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [REVOKED_KEY] });
    renderPage();

    await screen.findByText("Old Integration");
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("shows an amber expiry badge for a key expiring within 30 days", async () => {
    const soon = {
      ...ACTIVE_KEY,
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    };
    mockFetchWithAuth.mockResolvedValueOnce({ data: [soon] });
    renderPage();

    await screen.findByText(/Expires in \d+ days?/);
  });

  it("shows a red 'Expired' badge for a past-expiry key", async () => {
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
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ACTIVE_KEY] });
    renderPage();
    await screen.findByText("Acme Helpdesk Sync");

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Emergency Rotate" }));
    await screen.findByText(/breaks immediately/i);

    mockFetchWithAuth.mockResolvedValueOnce({
      data: { id: "key-3", key: "sk_live_new", expiresAt: null },
    });
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] }); // refresh after action

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

  it("opens the create-key modal when New Key is clicked", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "New Key" }));
    await screen.findByText("New API Key");
  });
});
