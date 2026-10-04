import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  waitFor,
  cleanup,
  screen,
  fireEvent,
} from "@testing-library/react";
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

const { WorkflowRecords, buildRecordsRequest } =
  await import("./workflow-records.js");

const WORKFLOW_ID = "wf-1";
const ENTITY_TYPE_ID = "et-1";

function mockRoutes(assignedTo: string[]): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith("/workflows/slugs")) {
      return Promise.resolve({
        data: [
          { id: WORKFLOW_ID, name: "Leave Approval" },
          { id: "wf-2", name: "Incident Management" },
        ],
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
    if (url.endsWith("/workflows/wf-2")) {
      return Promise.resolve({
        data: {
          id: "wf-2",
          name: "Incident Management",
          entityTypeId: "et-2",
          createdBy: "someone-else",
          assignedTo: [],
          states: [],
          transitions: [],
        },
      });
    }
    if (url.includes("/entity-types/et-2/fields")) {
      return Promise.resolve({ data: [] });
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
    if (url.includes("/entities?entityTypeId=et-2")) {
      return Promise.resolve({
        data: [
          {
            id: "incident-ticket-1",
            currentState: null,
            fields: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
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

function renderPage(
  initialPath = "/workflows/leave-approval/records",
): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={[initialPath]}>
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

describe("WorkflowRecords — concurrency, initialLoadedUrlRef dedup, and filter refetching", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
  });

  it("deduplicates initial ticket load so only one /entities request is made (initialLoadedUrlRef)", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });

    // The shell effect fetched records concurrently with fields/users and set
    // initialLoadedUrlRef, allowing the ticket list effect to skip duplicate fetch.
    const entityCalls = mockFetchWithAuth.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/entities") && !url.includes("/users"));

    expect(entityCalls).toHaveLength(1);
    expect(entityCalls[0]).toContain(
      `/entities?entityTypeId=${ENTITY_TYPE_ID}&rootOnly=true`,
    );
  });

  it("triggers refetch when changing severity filter (not swallowed by initialLoadedUrlRef)", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });

    // Open filter panel
    const filterBtn = container.querySelector('button[title="Filters"]');
    expect(filterBtn).not.toBeNull();
    if (filterBtn) {
      fireEvent.click(filterBtn);
    }

    // Severity section starts open; click Critical severity chip
    const criticalChip = await screen.findByRole("button", {
      name: /Critical/i,
    });
    fireEvent.click(criticalChip);

    // Verify a fresh request was issued with severity=critical
    await waitFor(() => {
      const entityCalls = mockFetchWithAuth.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("/entities") && !url.includes("/users"));
      expect(entityCalls.length).toBeGreaterThanOrEqual(2);
      expect(entityCalls.at(-1)).toContain("severity=critical");
    });
  });

  it("triggers refetch when changing origin filter (not swallowed by initialLoadedUrlRef)", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });

    // Open filter panel
    const filterBtn = container.querySelector('button[title="Filters"]');
    expect(filterBtn).not.toBeNull();
    if (filterBtn) {
      fireEvent.click(filterBtn);
    }

    // Source section starts open; click Internal chip
    const internalChip = await screen.findByRole("button", {
      name: /Internal/i,
    });
    fireEvent.click(internalChip);

    // Verify a fresh request was issued with origin=internal
    await waitFor(() => {
      const entityCalls = mockFetchWithAuth.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes("/entities") && !url.includes("/users"));
      expect(entityCalls.length).toBeGreaterThanOrEqual(2);
      expect(entityCalls.at(-1)).toContain("origin=internal");
    });
  });

  it("switches workflow slug properly and fetches new workflow and tickets", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);

    const container = renderPage("/workflows/incident-management/records");

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(1);
    });

    const calls = mockFetchWithAuth.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.endsWith("/workflows/wf-2"))).toBe(true);
    expect(calls.some((url) => url.includes("entityTypeId=et-2"))).toBe(true);
  });

  it("keeps workflow shell, states, and columns rendered if initial record fetch fails", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
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
            assignedTo: [],
            states: [
              { id: "s-1", name: "open", label: "Open", color: "#3b82f6" },
              { id: "s-2", name: "closed", label: "Closed", color: "#10b981" },
            ],
            transitions: [],
          },
        });
      }
      if (url.includes(`/entity-types/${ENTITY_TYPE_ID}/fields`)) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes("/users")) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes("/entities")) {
        return Promise.reject(new Error("Database connection timed out"));
      }
      return Promise.resolve({ data: [] });
    });

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelector(".kb-error")).toBeNull();
      expect(container.querySelectorAll(".kb-col").length).toBe(2);
      expect(screen.getByText("Open")).not.toBeNull();
      expect(screen.getByText("Closed")).not.toBeNull();
    });

    expect(container.querySelectorAll(".kb-card").length).toBe(0);
    expect(container.querySelector('button[title="Filters"]')).not.toBeNull();
  });
});

describe("buildRecordsRequest", () => {
  it("routes plain users to /entities/my-tickets", () => {
    const res = buildRecordsRequest({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      workflowCreatedBy: "creator-id",
      workflowAssignedTo: ["assignee-id"],
      userSub: "plain-user",
      isUserRole: true,
      filterSeverities: new Set(),
      filterTag: "",
      filterOrigin: "",
    });
    expect(res.useMyTickets).toBe(true);
    expect(res.url).toBe("/api/entities/my-tickets?workflowId=wf-1");
  });

  it("routes workflow creators (user role) to unrestricted list endpoint", () => {
    const res = buildRecordsRequest({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      workflowCreatedBy: "creator-id",
      workflowAssignedTo: [],
      userSub: "creator-id",
      isUserRole: true,
      filterSeverities: new Set(),
      filterTag: "",
      filterOrigin: "",
    });
    expect(res.useMyTickets).toBe(false);
    expect(res.url).toBe("/api/entities?entityTypeId=et-1&rootOnly=true");
  });

  it("routes assigned users (user role) to unrestricted list endpoint", () => {
    const res = buildRecordsRequest({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      workflowCreatedBy: "creator-id",
      workflowAssignedTo: ["assigned-user"],
      userSub: "assigned-user",
      isUserRole: true,
      filterSeverities: new Set(),
      filterTag: "",
      filterOrigin: "",
    });
    expect(res.useMyTickets).toBe(false);
    expect(res.url).toBe("/api/entities?entityTypeId=et-1&rootOnly=true");
  });

  it("routes admin/agent (isUserRole = false) to unrestricted list endpoint", () => {
    const res = buildRecordsRequest({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      workflowCreatedBy: "creator-id",
      workflowAssignedTo: [],
      userSub: "admin-id",
      isUserRole: false,
      filterSeverities: new Set(),
      filterTag: "",
      filterOrigin: "",
    });
    expect(res.useMyTickets).toBe(false);
    expect(res.url).toBe("/api/entities?entityTypeId=et-1&rootOnly=true");
  });

  it("includes filter query parameters properly in both my-tickets and list URLs", () => {
    const userRes = buildRecordsRequest({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      workflowCreatedBy: "creator-id",
      workflowAssignedTo: [],
      userSub: "plain-user",
      isUserRole: true,
      filterSeverities: new Set(["critical", "high"]),
      filterTag: "bug",
      filterOrigin: "external",
    });
    expect(userRes.url).toContain("/api/entities/my-tickets?workflowId=wf-1");
    expect(userRes.url).toContain("severity=critical%2Chigh");
    expect(userRes.url).toContain("tag=bug");
    expect(userRes.url).toContain("origin=external");

    const adminRes = buildRecordsRequest({
      entityTypeId: "et-1",
      workflowId: "wf-1",
      workflowCreatedBy: "creator-id",
      workflowAssignedTo: [],
      userSub: "admin-id",
      isUserRole: false,
      filterSeverities: new Set(["low"]),
      filterTag: "feature",
      filterOrigin: "internal",
    });
    expect(adminRes.url).toContain(
      "/api/entities?entityTypeId=et-1&rootOnly=true",
    );
    expect(adminRes.url).toContain("severity=low");
    expect(adminRes.url).toContain("tag=feature");
    expect(adminRes.url).toContain("origin=internal");
  });
});
