import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type * as ReactRouterDom from "react-router-dom";

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

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

const { ApiKeys } = await import("./index.js");

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ApiKeys />
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

describe("ApiKeys card grid (admin-ui API Keys restructuring)", () => {
  beforeEach(() => {
    mockFetchWithAuth.mockReset();
    mockShowAlert.mockReset();
    mockNavigate.mockReset();
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

  it("renders one card per unique application, showing its name, key count, and overall status", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ACTIVE_KEY] });
    renderPage();

    await screen.findByText("Acme Helpdesk Sync");
    expect(screen.getByText("1 key")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("groups two keys with a normalized-equal application name into a single card", async () => {
    const secondKey = {
      ...ACTIVE_KEY,
      id: "key-1b",
      applicationName: "  acme helpdesk sync ",
      revokedAt: "2026-06-01T00:00:00Z",
    };
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [ACTIVE_KEY, secondKey],
    });
    renderPage();

    await screen.findByText("2 keys");
    // Only one card — the display name is the most-recently-created key's
    // own exact text, which for this fixture is ACTIVE_KEY's casing.
    expect(screen.getAllByText("Acme Helpdesk Sync")).toHaveLength(1);
  });

  it("shows a Revoked overall status for an application whose only key is revoked", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [REVOKED_KEY] });
    renderPage();

    await screen.findByText("Old Integration");
    expect(screen.getByText("Revoked")).toBeTruthy();
  });

  it("navigates to the application's detail route when a card is clicked", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [ACTIVE_KEY] });
    renderPage();

    const card = await screen.findByText("Acme Helpdesk Sync");
    fireEvent.click(card);

    expect(mockNavigate).toHaveBeenCalledWith(
      `/admin/api-keys/${encodeURIComponent("acme helpdesk sync")}`,
    );
  });

  it("opens the create-key modal when New Key is clicked", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "New Key" }));
    await screen.findByText("New API Key");
  });

  it("shows the empty state and a create-first-key button when there are no applications", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [] });
    renderPage();

    await screen.findByText("No API keys yet");
    expect(
      screen.getByRole("button", { name: "Create your first key" }),
    ).toBeTruthy();
  });
});
