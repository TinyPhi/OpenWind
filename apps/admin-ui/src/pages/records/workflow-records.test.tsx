import { describe, it, expect, vi, afterEach } from "vitest";
import {
  act,
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
function mockUser(): unknown {
  return {
    profile: {
      sub: mockUserId,
      "urn:zitadel:iam:org:project:roles": Object.fromEntries(
        mockProfileRoles.map((r) => [r, {}]),
      ),
    },
  };
}
const defaultGetUser = (): Promise<unknown> => Promise.resolve(mockUser());
const mockGetUser = vi.fn(defaultGetUser);
vi.mock("../../authProvider.js", () => ({
  userManager: {
    getUser: () => mockGetUser(),
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

function ticket(id: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return { id, currentState: null, fields: {}, createdAt: now, updatedAt: now };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Layers a records-endpoint handler over the routes already installed by
// mockRoutes(); `call` is the 1-based count of records requests so far.
function interceptRecords(
  handler: (url: string, call: number) => Promise<unknown>,
): void {
  const base = mockFetchWithAuth.getMockImplementation();
  let call = 0;
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url.includes("/entities")) {
      call += 1;
      return handler(url, call);
    }
    return base ? base(url) : Promise.resolve({ data: [] });
  });
}

function recordCalls(): string[] {
  return mockFetchWithAuth.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.includes("/entities"));
}

function cardCount(container: HTMLElement): number {
  return container.querySelectorAll(".kb-card").length;
}

function refreshingPill(container: HTMLElement): Element | null {
  return container.querySelector(".kb-records-refreshing-pill");
}

async function toggleCriticalSeverity(container: HTMLElement): Promise<void> {
  if (!container.querySelector(".kb-filter-panel")) {
    const filterBtn = container.querySelector('button[title="Filters"]');
    expect(filterBtn).not.toBeNull();
    if (filterBtn) fireEvent.click(filterBtn);
  }
  fireEvent.click(await screen.findByRole("button", { name: /Critical/i }));
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

describe("WorkflowRecords — concurrency, appliedRecordsUrlRef dedup, and filter refetching", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
  });

  it("deduplicates initial ticket load so only one /entities request is made (appliedRecordsUrlRef)", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);

    const container = renderPage();

    await waitFor(() => {
      expect(container.querySelectorAll(".kb-card").length).toBe(2);
    });

    // The shell effect fetched records concurrently with fields/users and set
    // appliedRecordsUrlRef, allowing the ticket list effect to skip duplicate fetch.
    const entityCalls = mockFetchWithAuth.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/entities") && !url.includes("/users"));

    expect(entityCalls).toHaveLength(1);
    expect(entityCalls[0]).toContain(
      `/entities?entityTypeId=${ENTITY_TYPE_ID}&rootOnly=true`,
    );
  });

  it("triggers refetch when changing severity filter (not swallowed by appliedRecordsUrlRef)", async () => {
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

  it("triggers refetch when changing origin filter (not swallowed by appliedRecordsUrlRef)", async () => {
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

  it("surfaces an error, not an empty board, when the initial records fetch and its retry both fail", async () => {
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
      expect(container.querySelector(".kb-error")?.textContent).toBe(
        "Database connection timed out",
      );
    });
    // The shell's own failure is not what surfaced this: it resolved the
    // workflow, then the list effect retried the records URL and failed.
    const calls = recordCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(container.querySelector(".kb-board")).toBeNull();
  });
});

describe("WorkflowRecords — records load retries and in-flight races", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockGetUser.mockReset();
    mockGetUser.mockImplementation(defaultGetUser);
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
  });

  it("retries a failed initial records fetch and renders the retry's records without a full-page error", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);
    interceptRecords((_url, call) =>
      call === 1
        ? Promise.reject(new Error("Database connection timed out"))
        : Promise.resolve({ data: [ticket("t-1"), ticket("t-2")] }),
    );

    const container = renderPage();

    await waitFor(() => {
      expect(cardCount(container)).toBe(2);
    });
    expect(container.querySelector(".kb-error")).toBeNull();
    expect(refreshingPill(container)).toBeNull();
    const calls = recordCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("issues exactly one records request on a successful my-tickets load", async () => {
    mockProfileRoles = ["user"];
    mockUserId = "u-random";
    mockRoutes(["some-other-admin"]);

    const container = renderPage();

    await waitFor(() => {
      expect(cardCount(container)).toBe(1);
    });
    // Let any follow-up list-effect run (e.g. currentUserId settling) fire.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(recordCalls()).toEqual([
      `/api/entities/my-tickets?workflowId=${WORKFLOW_ID}`,
    ]);
    expect(refreshingPill(container)).toBeNull();
  });

  it("toggling a filter away and back before its fetch resolves clears the refresh indicator and keeps the original records", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);
    const critical = deferred<unknown>();
    interceptRecords((url) =>
      url.includes("severity=critical")
        ? critical.promise
        : Promise.resolve({ data: [ticket("t-1"), ticket("t-2")] }),
    );

    const container = renderPage();
    await waitFor(() => {
      expect(cardCount(container)).toBe(2);
    });

    await toggleCriticalSeverity(container);
    await waitFor(() => {
      expect(refreshingPill(container)).not.toBeNull();
    });

    await toggleCriticalSeverity(container);
    await waitFor(() => {
      expect(refreshingPill(container)).toBeNull();
    });
    expect(cardCount(container)).toBe(2);
    // The unfiltered records are still applied, so going back to them must
    // not refetch.
    expect(recordCalls()).toHaveLength(2);
    expect(recordCalls()[1]).toContain("severity=critical");

    // The abandoned critical-only response must not overwrite them later.
    await act(async () => {
      critical.resolve({ data: [ticket("critical-only")] });
      await critical.promise;
    });
    expect(cardCount(container)).toBe(2);
    expect(refreshingPill(container)).toBeNull();
  });

  it("still applies records when a same-URL dependency change cancels the in-flight fetch", async () => {
    mockProfileRoles = ["admin"];
    mockUserId = "admin-1";
    mockRoutes([]);
    // Hold the mount-time getUser() (the first call) so currentUserId only
    // resolves once the filtered fetch is in flight. That changes a list
    // effect dependency without changing its URL for an admin.
    const userGate = deferred<undefined>();
    mockGetUser.mockImplementationOnce(() =>
      userGate.promise.then(() => mockUser()),
    );
    const firstCritical = deferred<unknown>();
    let criticalCalls = 0;
    interceptRecords((url) => {
      if (!url.includes("severity=critical")) {
        return Promise.resolve({ data: [ticket("t-1"), ticket("t-2")] });
      }
      criticalCalls += 1;
      return criticalCalls === 1
        ? firstCritical.promise
        : Promise.resolve({ data: [ticket("critical-only")] });
    });

    const container = renderPage();
    await waitFor(() => {
      expect(cardCount(container)).toBe(2);
    });

    await toggleCriticalSeverity(container);
    await waitFor(() => {
      expect(criticalCalls).toBe(1);
    });

    await act(async () => {
      userGate.resolve(undefined);
      await userGate.promise;
    });

    await waitFor(() => {
      expect(cardCount(container)).toBe(1);
    });
    expect(refreshingPill(container)).toBeNull();
    expect(criticalCalls).toBe(2);

    // The cancelled first request resolving late is ignored.
    await act(async () => {
      firstCritical.resolve({ data: [ticket("stale-1"), ticket("stale-2")] });
      await firstCritical.promise;
    });
    expect(cardCount(container)).toBe(1);
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
