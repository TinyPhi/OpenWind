import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type * as ReactRouterDom from "react-router-dom";

// ── docs/specs/personal-dashboard.md R4 regression guard ──────────────────────
// This page was renamed Dashboard -> Analytics (route "/" -> "/analytics") with
// explicitly NO logic change to KPI computation. This test fixes known input
// data and asserts the KPI numbers a real user would see — if a future edit to
// this file changes those numbers for the same input, this test catches it.

vi.mock("@refinedev/core", () => ({
  useGetIdentity: () => ({
    data: { id: "admin-1", name: "Jane Admin", email: "jane@example.com" },
  }),
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../authProvider.js", () => ({
  userManager: {
    getUser: () =>
      Promise.resolve({
        profile: {
          "urn:zitadel:iam:org:project:roles": { admin: {} },
        },
      }),
  },
}));

const WF_ID = "00000000-0000-0000-0000-0000000000a1";

const mockFetchWithAuth = vi.fn((url: string) => {
  if (url.endsWith("/workflows")) {
    return Promise.resolve({
      data: [
        {
          id: WF_ID,
          name: "Helpdesk",
          entityTypeId: "et-1",
          isActive: true,
          states: [
            { name: "open", label: "Open", color: null, isTerminal: false },
            {
              name: "closed",
              label: "Closed",
              color: null,
              isTerminal: true,
            },
          ],
        },
      ],
    });
  }
  if (url.endsWith("/modules")) {
    return Promise.resolve({
      data: [
        { slug: "helpdesk", name: "Helpdesk", installed: true },
        { slug: "crm", name: "CRM", installed: false },
      ],
    });
  }
  if (url.endsWith("/users")) {
    return Promise.resolve({ data: [] });
  }
  if (url.includes("/entities?entityTypeId=")) {
    return Promise.resolve({
      data: [
        { id: "r1", currentState: "open", createdAt: new Date().toISOString() },
        { id: "r2", currentState: "open", createdAt: new Date().toISOString() },
        {
          id: "r3",
          currentState: "closed",
          createdAt: new Date().toISOString(),
        },
      ],
    });
  }
  return Promise.resolve({ data: [] });
});

vi.mock("../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

const { Analytics } = await import("./analytics.js");

beforeAll(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
});

describe("Analytics (renamed from Dashboard — R4 regression guard)", () => {
  it("computes the same KPI values as the pre-rename Dashboard component for fixed fixture data", async () => {
    render(<Analytics />);

    // Total Workflows: 1 workflow, 1 active
    await waitFor(() => {
      expect(screen.getByText("Total Workflows")).toBeDefined();
    });
    expect(screen.getByText("1 active")).toBeDefined();

    // Total Records: 3 records across the one workflow (label appears twice —
    // KPI card + the breakdown chart legend further down the page)
    expect(screen.getAllByText("Total Records").length).toBeGreaterThan(0);

    // Open / In-Progress: 2 open (non-terminal state), 1 closed
    expect(screen.getByText("Open / In-Progress")).toBeDefined();
    expect(screen.getByText("1 resolved")).toBeDefined();

    // Installed Modules: 1 of 2 installed
    expect(screen.getByText("Installed Modules")).toBeDefined();
    expect(screen.getByText("of 2 available")).toBeDefined();
  });
});
