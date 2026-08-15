import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// ui-feature-checklist-and-rules.md §2.9/§2.10 — an access request must
// reach the ticket's admin/agent/workflow-admin viewers live (WebSocket push)
// AND on initial page load, not only when the Access Requests tab is
// manually clicked. This regressed once already: both the mount-time
// preload effect and the live-push handler in record-detail.tsx checked only
// `isOwner` (creator/assignee), silently excluding admin/agent viewers who
// aren't personally the creator or assignee of the ticket they're viewing —
// even though the tab itself was already visible to them.

const RECORD_ID = "rec-1";
const ENTITY_TYPE_ID = "et-1";
const OTHER_USER = "u-someone-else";
const ADMIN_USER = "u-admin-viewer";

let mockProfileRoles: string[] = ["user"];
let mockUserId = OTHER_USER;

vi.mock("../../authProvider.js", () => ({
  userManager: {
    getUser: () =>
      Promise.resolve({
        profile: {
          sub: mockUserId,
          email: "viewer@example.com",
          "urn:zitadel:iam:org:project:roles": Object.fromEntries(
            mockProfileRoles.map((r) => [r, {}]),
          ),
        },
      } as unknown),
  },
}));

vi.mock("../../entity-type-context.js", () => ({
  useEntityTypes: () => ({
    getTypeBySlug: () => ({
      id: ENTITY_TYPE_ID,
      name: "Ticket",
      plural: "Tickets",
    }),
    getTypeById: () => ({
      id: ENTITY_TYPE_ID,
      name: "Ticket",
      plural: "Tickets",
    }),
  }),
  toTypeSlug: (s: string) => s.toLowerCase(),
}));

vi.mock("../../hooks/use-file-upload.js", () => ({
  useFileUpload: () => ({
    stagedFiles: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clearFiles: vi.fn(),
    pendingCount: 0,
    cleanFileIds: [],
  }),
}));

type PushHandler = (msg: unknown) => void;
let capturedRoomHandler: PushHandler | null = null;
const mockUnsubscribe = vi.fn();

vi.mock("../../lib/notifications-client.js", () => ({
  subscribeToTicketRoom: (_instanceId: string, handler: PushHandler) => {
    capturedRoomHandler = handler;
    return mockUnsubscribe;
  },
}));

const mockFetchWithAuth = vi.fn(
  (_url: string, _init?: unknown): Promise<unknown> => {
    throw new Error("unhandled fetchWithAuth URL in test — add a branch below");
  },
);
vi.mock("../../lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string, init?: unknown) => mockFetchWithAuth(url, init),
}));

const { CustomerRecordDetail } = await import("./record-detail.js");

const BASE_RECORD = {
  id: RECORD_ID,
  entityTypeId: ENTITY_TYPE_ID,
  workflowId: null,
  currentState: null,
  fields: { subject: "Test ticket" },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  assignedTo: null,
  dueDate: null,
  createdBy: OTHER_USER,
};

function mockRoutesForAccessRequests(
  accessRequests: Array<{
    id: string;
    requesterId: string;
    requestedLevel: string;
    status: "pending" | "approved" | "rejected";
    resolvedBy: string | null;
    resolvedAt: string | null;
    createdAt: string;
  }>,
): void {
  mockFetchWithAuth.mockImplementation((url: string) => {
    if (url === `/api/entities/${RECORD_ID}`) {
      return Promise.resolve({ data: BASE_RECORD });
    }
    if (url === `/api/entity-types/${ENTITY_TYPE_ID}/fields`) {
      return Promise.resolve({ data: [] });
    }
    if (url === "/api/users") {
      return Promise.resolve({ data: [] });
    }
    if (url === `/api/entities/${RECORD_ID}/access`) {
      return Promise.resolve({ data: [] });
    }
    if (url === `/api/entities/${RECORD_ID}/access-requests`) {
      return Promise.resolve({ data: accessRequests });
    }
    if (url.startsWith(`/api/entities/${RECORD_ID}/transitions/history`)) {
      return Promise.resolve({ data: [] });
    }
    if (url === `/api/entities/${RECORD_ID}/attachments`) {
      return Promise.resolve({ data: [] });
    }
    if (url === `/api/entities/${RECORD_ID}/children`) {
      return Promise.resolve({ data: [] });
    }
    if (url === `/api/entities/${RECORD_ID}/references`) {
      return Promise.resolve({ data: [] });
    }
    // Anything else (workflow lookups, alerts, etc.) — safe empty default.
    return Promise.resolve({ data: [] });
  });
}

function renderRecordDetail(): void {
  render(
    <MemoryRouter initialEntries={[`/records/ticket/${RECORD_ID}`]}>
      <Routes>
        <Route
          path="/records/:typeSlug/:id"
          element={<CustomerRecordDetail />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CustomerRecordDetail — Access Requests tab (ui-feature-checklist §2.9/§2.10)", () => {
  beforeEach(() => {
    capturedRoomHandler = null;
  });

  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockUnsubscribe.mockReset();
    mockProfileRoles = ["user"];
    mockUserId = OTHER_USER;
  });

  it("shows the tab and preloads the list for an admin/agent viewer who is not the ticket's creator or assignee", async () => {
    mockUserId = ADMIN_USER;
    mockProfileRoles = ["agent"];
    mockRoutesForAccessRequests([
      {
        id: "req-1",
        requesterId: "u-requester",
        requestedLevel: "read_comment",
        status: "pending",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    renderRecordDetail();

    expect(await screen.findByText("Access Requests")).toBeDefined();

    // Regression guard: this must be fetched on mount, without clicking the
    // tab — a prior bug gated this preload on `isOwner` alone (creator/
    // assignee), which silently excluded every admin/agent viewer.
    await waitFor(() => {
      expect(
        mockFetchWithAuth.mock.calls.some(
          ([url]) => url === `/api/entities/${RECORD_ID}/access-requests`,
        ),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByText("1")).toBeDefined();
    });
  });

  it("does not show the Access Requests tab for a plain user with no relationship to the ticket", async () => {
    mockUserId = "u-random-viewer";
    mockProfileRoles = ["user"];
    mockRoutesForAccessRequests([]);

    renderRecordDetail();

    // "Comments" is the default active tab, always rendered once the record
    // has loaded — a reliable "page finished loading" signal here.
    await screen.findByText("Comments");
    expect(screen.queryByText("Access Requests")).toBeNull();

    // Never fetched either — a plain viewer has no business seeing pending
    // requests for a ticket they don't own or administer.
    expect(
      mockFetchWithAuth.mock.calls.some(
        ([url]) => url === `/api/entities/${RECORD_ID}/access-requests`,
      ),
    ).toBe(false);
  });

  it("live WebSocket push (access_request.created) refreshes the list for an admin/agent viewer without any tab click", async () => {
    mockUserId = ADMIN_USER;
    mockProfileRoles = ["admin"];
    mockRoutesForAccessRequests([]);

    renderRecordDetail();
    await screen.findByText("Access Requests");

    await waitFor(() => {
      expect(capturedRoomHandler).not.toBeNull();
    });

    // A second request now exists server-side — simulate the room push that
    // announces it, then confirm the component re-fetches the list live.
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}/access-requests`) {
        return Promise.resolve({
          data: [
            {
              id: "req-2",
              requesterId: "u-new-requester",
              requestedLevel: "read_write",
              status: "pending",
              resolvedBy: null,
              resolvedAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    capturedRoomHandler?.({
      type: "access_request.created",
      instanceId: RECORD_ID,
      request: {
        id: "req-2",
        requestedBy: "u-new-requester",
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    });

    await waitFor(() => {
      expect(screen.getByText("1")).toBeDefined();
    });
  });

  it("live WebSocket push for a different ticket's room is ignored", async () => {
    mockUserId = ADMIN_USER;
    mockProfileRoles = ["admin"];
    mockRoutesForAccessRequests([]);

    renderRecordDetail();
    await screen.findByText("Access Requests");
    await waitFor(() => expect(capturedRoomHandler).not.toBeNull());

    const callsBefore = mockFetchWithAuth.mock.calls.length;

    capturedRoomHandler?.({
      type: "access_request.created",
      instanceId: "some-other-ticket",
      request: {
        id: "req-3",
        requestedBy: "u-someone",
        status: "pending",
        createdAt: new Date().toISOString(),
      },
    });

    // Give any (incorrect) async refetch a chance to fire before asserting
    // it didn't.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetchWithAuth.mock.calls.length).toBe(callsBefore);
  });
});

describe("CustomerRecordDetail — History tab access-event rendering (ui-feature-checklist §3.3)", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockProfileRoles = ["user"];
    mockUserId = OTHER_USER;
  });

  it("renders access_grant/access_update/access_revoke/access_reject as distinct lines, not a generic update/transition", async () => {
    mockUserId = ADMIN_USER;
    mockProfileRoles = ["admin"];

    const historyEvents = [
      {
        id: "ev-grant",
        fromState: null,
        toState: "",
        actorId: ADMIN_USER,
        triggeredAt: new Date().toISOString(),
        metadata: {
          type: "access_grant",
          targetUserId: "u-target",
          level: "read_write",
        },
      },
      {
        id: "ev-reject",
        fromState: null,
        toState: "",
        actorId: ADMIN_USER,
        triggeredAt: new Date().toISOString(),
        metadata: {
          type: "access_reject",
          targetUserId: "u-target",
          level: "read_comment",
        },
      },
      {
        id: "ev-request",
        fromState: null,
        toState: "",
        actorId: "u-requester",
        triggeredAt: new Date().toISOString(),
        metadata: {
          type: "access_request",
          level: "read_write",
        },
      },
      {
        id: "ev-link-removed",
        fromState: null,
        toState: "",
        actorId: ADMIN_USER,
        triggeredAt: new Date().toISOString(),
        metadata: {
          type: "link_removed",
          counterpartId: "22222222-2222-2222-2222-222222222222",
          relationType: "blocks",
        },
      },
      {
        id: "ev-file-downloaded",
        fromState: null,
        toState: "",
        actorId: ADMIN_USER,
        triggeredAt: new Date().toISOString(),
        metadata: {
          type: "file_downloaded",
          fileId: "file-1",
          originalName: "report.pdf",
        },
      },
    ];

    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        return Promise.resolve({ data: BASE_RECORD });
      }
      if (url === `/api/entity-types/${ENTITY_TYPE_ID}/fields`) {
        return Promise.resolve({ data: [] });
      }
      if (url === "/api/users") {
        return Promise.resolve({ data: [] });
      }
      if (url === `/api/entities/${RECORD_ID}/access`) {
        return Promise.resolve({ data: [] });
      }
      if (url === `/api/entities/${RECORD_ID}/access-requests`) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes("eventType=history")) {
        return Promise.resolve({ data: historyEvents });
      }
      if (url.includes("eventType=comment")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();
    await screen.findByText("Comments");

    const historyTab = screen.getByText("History");
    historyTab.click();

    // A future regression that removes the isAccessReject branch would fall
    // through to the generic transition renderer instead — this line
    // wouldn't exist and the grant line's wording would be the only proof
    // the switch ran at all.
    expect(await screen.findByText(/granted/)).toBeDefined();
    expect(await screen.findByText(/rejected.*access request/)).toBeDefined();
    // §3.6 — the request submission itself gets its own distinct line, not
    // just its eventual approval/rejection.
    expect(await screen.findByText(/requested access/)).toBeDefined();
    // §3.1/§3.2 — unlinking a ticket gets its own history line too.
    expect(await screen.findByText(/removed the link to/)).toBeDefined();
    // §3.4 — a file download gets its own history line, distinct from
    // attach/delete.
    expect(await screen.findByText(/downloaded/)).toBeDefined();
  });
});
