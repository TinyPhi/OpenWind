import { describe, it, expect, vi, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// A "user"-role caller who is this workflow's creator or in its assignedTo
// list is a workflow admin and must see every ticket, the same as
// apps/api/src/routes/entities/list.ts's isWorkflowAdmin check grants at the
// API layer — this page previously ignored that and routed anyone without
// the raw admin/agent role through /entities/my-tickets regardless.

const mockFetchWithAuth = vi.fn(
  (_url: string): Promise<unknown> => Promise.resolve({ data: undefined }),
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
}));

let mockProfileRoles: string[] = ["user"];
let mockUserId = "u-random";
vi.mock("../../authProvider.js", () => ({
  userManager: {
    getUser: () =>
      Promise.resolve({
        profile: {
          sub: mockUserId,
          "urn:zitadel:iam:org:project:roles": Object.fromEntries(
            mockProfileRoles.map((r) => [r, {}]),
          ),
        },
      } as unknown),
  },
}));

const { WorkflowRecords } = await import("./workflow-records.js");

const WORKFLOW_ID = "wf-1";
const ENTITY_TYPE_ID = "et-1";

function mockRoutes(assignedTo: string[]): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/workflows/slugs")) {
      return Promise.resolve({
        data: [{ id: WORKFLOW_ID, name: "Leave Approval" }],
      });
    }
    if (url.endsWith(`/workflows/${WORKFLOW_ID}`)) {
      return Promise.resolve({
        data: {
          id: WORKFLOW_ID,
          name: "Leave Approval",
          entityTypeId: ENTITY_TYPE_ID,
          createdBy: "someone-else",
          assignedTo,
          states: [],
          transitions: [],
        },
      });
    }
    if (url.includes(`/entity-types/${ENTITY_TYPE_ID}/fields`)) {
      return Promise.resolve({ data: [] });
    }
    if (url.includes("/entities/my-tickets")) {
      return Promise.resolve({
        data: {
          parentTickets: [
            {
              id: "my-ticket",
              currentState: null,
              fields: {},
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          childTickets: [],
        },
      });
    }
    if (url.includes(`/entities?entityTypeId=${ENTITY_TYPE_ID}`)) {
      return Promise.resolve({
        data: [
          {
            id: "someone-elses-ticket",
            currentState: null,
            fields: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: "my-ticket-2",
            currentState: null,
            fields: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
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
    <MemoryRouter initialEntries={["/workflows/leave-approval/records"]}>
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

describe("WorkflowRecords — workflow-admin ticket visibility", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockProfileRoles = ["user"];
    mockUserId = "u-random";
  });

  it("a workflow admin (user role, in the workflow's assignedTo) sees every ticket, not just their own", async () => {
    mockProfileRoles = ["user"];
    mockUserId = "admin-user-1";
    mockRoutes(["admin-user-1"]);

    const container = renderPage();

    // Role resolution is async (userManager.getUser()), so the very first
    // fetch pass can fire before isUserRole settles — what must hold is the
    // FINAL settled state: two cards rendered, and the last relevant
    // /entities call was the unrestricted list, never my-tickets.
    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });
    const listCalls = mockFetchWithAuth.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/entities") && !url.includes("/users"));
    expect(listCalls.at(-1)).toContain(
      `/entities?entityTypeId=${ENTITY_TYPE_ID}&rootOnly=true`,
    );
    expect(listCalls.at(-1)).not.toContain("/my-tickets");
  });

  it("a plain user (not this workflow's creator or assignedTo) only sees their own tickets", async () => {
    mockProfileRoles = ["user"];
    mockUserId = "u-random";
    mockRoutes(["some-other-admin"]);

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(1);
    });
    const listCalls = mockFetchWithAuth.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/entities") && !url.includes("/users"));
    expect(listCalls.at(-1)).toContain(
      `/entities/my-tickets?workflowId=${WORKFLOW_ID}`,
    );
  });

  it("an admin/agent-role caller always uses the unrestricted list endpoint", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });
    const listCalls = mockFetchWithAuth.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/entities") && !url.includes("/users"));
    expect(listCalls.every((url) => !url.includes("/my-tickets"))).toBe(true);
  });
});
