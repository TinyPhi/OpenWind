import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  waitFor,
  cleanup,
  fireEvent,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// docs/specs/ticket-severity-and-tags.md T16 — the records-list severity
// and tag filters, both server-side (re-fetch with severity=/tag= query
// params), same pattern as workflow-records-origin-filter.test.tsx.

const mockFetchWithAuth = vi.fn(
  (_url: string): Promise<unknown> => Promise.resolve({ data: undefined }),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

vi.mock("../../authProvider.js", () => ({
  userManager: {
    getUser: () =>
      Promise.resolve({
        profile: {
          sub: "admin-1",
          "urn:zitadel:iam:org:project:roles": { admin: {} },
        },
      } as unknown),
  },
}));

const { WorkflowRecords } = await import("./workflow-records.js");

const WORKFLOW_ID = "wf-1";
const ENTITY_TYPE_ID = "et-1";

const ALL_TICKETS = [
  {
    id: "low-ticket",
    currentState: null,
    fields: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    severity: "low",
  },
  {
    id: "critical-ticket",
    currentState: null,
    fields: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    severity: "critical",
  },
];

function mockRoutes(): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/workflows/slugs")) {
      return Promise.resolve({
        data: [{ id: WORKFLOW_ID, name: "Support" }],
      });
    }
    if (url.endsWith(`/workflows/${WORKFLOW_ID}`)) {
      return Promise.resolve({
        data: {
          id: WORKFLOW_ID,
          name: "Support",
          entityTypeId: ENTITY_TYPE_ID,
          createdBy: "admin-1",
          assignedTo: [],
          states: [],
          transitions: [],
        },
      });
    }
    if (url.includes(`/entity-types/${ENTITY_TYPE_ID}/fields`)) {
      return Promise.resolve({ data: [] });
    }
    if (url.includes(`/entities?entityTypeId=${ENTITY_TYPE_ID}`)) {
      // Server-side severity filter — mirrors list.ts's inArray semantics.
      const params = new URL(url, "http://localhost").searchParams;
      const severityParam = params.get("severity");
      const filtered = severityParam
        ? ALL_TICKETS.filter((t) =>
            severityParam.split(",").includes(t.severity),
          )
        : ALL_TICKETS;
      return Promise.resolve({ data: filtered });
    }
    if (url.includes("/users")) {
      return Promise.resolve({ data: [] });
    }
    return Promise.resolve({ data: [] });
  });
}

function renderPage(): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={["/workflows/support/records"]}>
      <Routes>
        <Route
          path="/workflows/:workflowSlug/records"
          element={<WorkflowRecords />}
        />
      </Routes>
    </MemoryRouter>,
  );
  return container;
}

describe("WorkflowRecords — severity filter (server-side)", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
  });

  it("shows both tickets before any severity filter is applied", async () => {
    mockRoutes();
    const container = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });
  });

  it('selecting "Critical" re-fetches with severity=critical and shows only that ticket', async () => {
    mockRoutes();
    const container = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });

    fireEvent.click(screen.getByTitle("Filters"));
    fireEvent.click(screen.getByRole("button", { name: /Critical/ }));

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(1);
    });
    expect(
      mockFetchWithAuth.mock.calls.some(([url]) =>
        String(url).includes("severity=critical"),
      ),
    ).toBe(true);
  });
});
