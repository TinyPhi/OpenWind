import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  waitFor,
  cleanup,
  fireEvent,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// docs/specs/third-party-api-origin-tagging.md — the records-list "Source"
// filter (Internal / External / Redirected), covering apps/admin-ui/src/
// pages/records/workflow-records.tsx's filterOrigin state and the chips
// that set it. Kept in its own file (workflow-records.test.tsx already
// covers a different concern — per-role ticket visibility).

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
      return Promise.resolve({
        data: [
          {
            id: "internal-ticket",
            currentState: null,
            fields: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            origin: null,
          },
          {
            id: "api-ticket",
            currentState: null,
            fields: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            origin: {
              mechanism: "api",
              appName: "Acme Sync",
              performerUserId: "u1",
              performerDisplayName: "Jane Doe",
            },
          },
          {
            id: "handoff-ticket",
            currentState: null,
            fields: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            origin: {
              mechanism: "handoff",
              appName: "Acme Portal",
              performerUserId: "u2",
              performerDisplayName: "Real User",
            },
          },
        ],
      });
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

describe("WorkflowRecords — Source filter (Internal / External / Redirected)", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
  });

  it("shows all three tickets before any Source filter is applied", async () => {
    mockRoutes();
    const container = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(3);
    });
  });

  it('selecting "External" shows only api-origin tickets', async () => {
    mockRoutes();
    const container = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(3);
    });

    fireEvent.click(screen.getByTitle("Filters"));
    fireEvent.click(screen.getByRole("button", { name: "External" }));

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(1);
    });
    expect(container.textContent).toContain("api-ticket".slice(0, 8));
  });

  it('selecting "Redirected" shows only handoff-origin tickets', async () => {
    mockRoutes();
    const container = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(3);
    });

    fireEvent.click(screen.getByTitle("Filters"));
    fireEvent.click(screen.getByRole("button", { name: "Redirected" }));

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(1);
    });
  });

  it('selecting "Internal" shows only tickets with no origin tag', async () => {
    mockRoutes();
    const container = renderPage();
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(3);
    });

    fireEvent.click(screen.getByTitle("Filters"));
    fireEvent.click(screen.getByRole("button", { name: "Internal" }));

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(1);
    });
    expect(container.querySelectorAll(".kb-card-origin-corner").length).toBe(0);
  });
});
