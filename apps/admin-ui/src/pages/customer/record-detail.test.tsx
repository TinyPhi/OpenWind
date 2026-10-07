import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

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

// 2026-09-22: team_id is a plain generic field on every entity type (no
// dedicated "team reference" field type) -- get.ts resolves it server-side
// to a live team name (`teamName`), and the field grid must show that
// resolved name instead of the raw id for any field literally named
// "team_id".
describe("CustomerRecordDetail — team_id field shows the resolved team name (2026-09-22)", () => {
  beforeEach(() => {
    capturedRoomHandler = null;
  });
  afterEach(() => cleanup());

  it("shows the resolved teamName, not the raw team_id, for a field named team_id", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        return Promise.resolve({
          data: {
            ...BASE_RECORD,
            fields: { subject: "Test ticket", team_id: "team-uuid-1" },
            teamName: "Dev Team",
          },
        });
      }
      if (url === `/api/entity-types/${ENTITY_TYPE_ID}/fields`) {
        return Promise.resolve({
          data: [
            {
              id: "f-team",
              name: "team_id",
              label: "Team",
              fieldType: "text",
              isRequired: false,
              isSystem: false,
              config: {},
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();

    await waitFor(() => expect(screen.getByText("Dev Team")).toBeTruthy());
    expect(screen.queryByText("team-uuid-1")).toBeNull();
  });
});

describe("CustomerRecordDetail — access denied accessibility", () => {
  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockProfileRoles = ["user"];
    mockUserId = OTHER_USER;
  });

  it("announces the blocking state as a labelled modal and moves focus to its title", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        return Promise.resolve({ data: BASE_RECORD });
      }
      if (url === `/api/entities/${RECORD_ID}/access`) {
        return Promise.resolve({
          data: [
            {
              userId: "u-authorized-viewer",
              level: "read_only",
              tag: "manual",
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();

    const dialog = await screen.findByRole("dialog", {
      name: "Access Restricted",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.textContent).toContain(
      "You don't have access to this ticket.",
    );
    expect(screen.getByRole("heading", { name: "Access Restricted" })).toBe(
      document.activeElement,
    );
  });
});

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

// 2026-09-22 fix — a ticket team-assigned at creation lands here unassigned
// (resolve_oncall resolves asynchronously); its system summary comment is a
// comment.created push like any other, and was previously handled only by
// refreshComments(), leaving assignedTo stale until a manual page refresh.
describe("CustomerRecordDetail — live comment push also refreshes the record (assignedTo)", () => {
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

  it("re-fetches the record (picking up a newly-set assignedTo) when a comment.created push arrives for this ticket", async () => {
    mockRoutesForAccessRequests([]);
    renderRecordDetail();
    await screen.findByText("Comments");
    await waitFor(() => expect(capturedRoomHandler).not.toBeNull());

    const callsBefore = mockFetchWithAuth.mock.calls.filter(
      ([url]) => url === `/api/entities/${RECORD_ID}`,
    ).length;

    // resolve_oncall has now assigned the ticket; simulate its system
    // comment's push arriving before any manual refresh.
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        return Promise.resolve({
          data: { ...BASE_RECORD, assignedTo: "u-oncall-primary" },
        });
      }
      if (url === `/api/entities/${RECORD_ID}/comments`) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });

    capturedRoomHandler?.({
      type: "comment.created",
      instanceId: RECORD_ID,
      commentId: "c-1",
      actorId: "system",
    });

    await waitFor(() => {
      const callsAfter = mockFetchWithAuth.mock.calls.filter(
        ([url]) => url === `/api/entities/${RECORD_ID}`,
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("live comment.created push for a different ticket's room does not re-fetch this record", async () => {
    mockRoutesForAccessRequests([]);
    renderRecordDetail();
    await screen.findByText("Comments");
    await waitFor(() => expect(capturedRoomHandler).not.toBeNull());

    const callsBefore = mockFetchWithAuth.mock.calls.length;

    capturedRoomHandler?.({
      type: "comment.created",
      instanceId: "some-other-ticket",
      commentId: "c-2",
      actorId: "system",
    });

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

describe("CustomerRecordDetail — regression vectors: error resilience & non-owner access requests", () => {
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

  it("renders core record view even if comments and attachments fail with 500", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        return Promise.resolve({ data: BASE_RECORD });
      }
      if (url === `/api/entity-types/${ENTITY_TYPE_ID}/fields`) {
        return Promise.resolve({
          data: [
            {
              id: "f-subject",
              name: "subject",
              label: "Subject",
              fieldType: "text",
              isRequired: true,
              isSystem: false,
              config: {},
            },
          ],
        });
      }
      if (url === "/api/users") {
        return Promise.resolve({ data: [] });
      }
      if (url === `/api/entities/${RECORD_ID}/access`) {
        return Promise.resolve({ data: [] });
      }
      if (url.startsWith(`/api/entities/${RECORD_ID}/transitions/history`)) {
        return Promise.reject(
          new Error("500 Internal Server Error: comments failed"),
        );
      }
      if (url === `/api/entities/${RECORD_ID}/attachments`) {
        return Promise.reject(
          new Error("500 Internal Server Error: attachments failed"),
        );
      }
      if (url === `/api/entities/${RECORD_ID}/tags`) {
        return Promise.reject(
          new Error("500 Internal Server Error: tags failed"),
        );
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();

    const titles = await screen.findAllByText("Test ticket");
    expect(titles.length).toBeGreaterThanOrEqual(1);
  });

  it("does not fire comments, attachments, or tags when loadRecord returns 404", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        return Promise.reject(err);
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();

    expect(
      await screen.findByText("You don't have access to this record"),
    ).toBeDefined();

    const secondaryEndpoints = [
      `/api/entities/${RECORD_ID}/transitions/history`,
      `/api/entities/${RECORD_ID}/attachments`,
      `/api/entities/${RECORD_ID}/tags`,
    ];
    for (const ep of secondaryEndpoints) {
      expect(
        mockFetchWithAuth.mock.calls.some(([url]) => url.startsWith(ep)),
      ).toBe(false);
    }
  });

  it("does not fire comments, attachments, or tags when loadRecord returns 403", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        const err = new Error("Forbidden") as Error & { status: number };
        err.status = 403;
        return Promise.reject(err);
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();

    expect(await screen.findByText("Forbidden")).toBeDefined();

    const secondaryEndpoints = [
      `/api/entities/${RECORD_ID}/transitions/history`,
      `/api/entities/${RECORD_ID}/attachments`,
      `/api/entities/${RECORD_ID}/tags`,
    ];
    for (const ep of secondaryEndpoints) {
      expect(
        mockFetchWithAuth.mock.calls.some(([url]) => url.startsWith(ep)),
      ).toBe(false);
    }
  });
});

describe("CustomerRecordDetail — non-owner access requests", () => {
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

  it("restores myAccessReqStatus properly for non-owner requesters on access-denied overlay", async () => {
    const REQUESTER_ID = "u-plain-requester";
    mockUserId = REQUESTER_ID;
    mockProfileRoles = ["user"];

    mockFetchWithAuth.mockImplementation((url: string, init?: unknown) => {
      if (url === `/api/entities/${RECORD_ID}`) {
        return Promise.resolve({
          data: {
            ...BASE_RECORD,
            createdBy: "u-owner",
          },
        });
      }
      if (url === `/api/entity-types/${ENTITY_TYPE_ID}/fields`) {
        return Promise.resolve({ data: [] });
      }
      if (url === "/api/users") {
        return Promise.resolve({ data: [] });
      }
      if (url === `/api/entities/${RECORD_ID}/access`) {
        // Owner only, REQUESTER_ID not in access list -> triggers accessDenied
        return Promise.resolve({
          data: [{ userId: "u-owner", level: "admin" }],
        });
      }
      if (url === `/api/entities/${RECORD_ID}/access-requests`) {
        const method = (init as { method?: string } | undefined)?.method;
        if (method === "POST") {
          return Promise.resolve({ data: { id: "req-1" } });
        }
        // Non-owner list endpoint returns 404 (caught gracefully)
        return Promise.reject(new Error("404 Not Found"));
      }
      return Promise.resolve({ data: [] });
    });

    renderRecordDetail();

    // Access restricted overlay appears
    expect(await screen.findByText("Access Restricted")).toBeDefined();
    const requestAccessBtn = screen.getByRole("button", {
      name: /Request Access/i,
    });
    expect(requestAccessBtn).toBeDefined();

    // Click "Request Access" to open confirmation modal
    fireEvent.click(requestAccessBtn);

    // Confirm sending access request
    const sendBtn = await screen.findByRole("button", {
      name: /Send request/i,
    });
    fireEvent.click(sendBtn);

    // Should now display "Access request sent — waiting for owner approval."
    expect(
      await screen.findByText(
        "Access request sent — waiting for owner approval.",
      ),
    ).toBeDefined();

    // Now simulate WebSocket push indicating request was declined
    expect(capturedRoomHandler).not.toBeNull();
    capturedRoomHandler?.({
      type: "access_request.updated",
      instanceId: RECORD_ID,
      request: {
        id: "req-1",
        requestedBy: REQUESTER_ID,
        status: "rejected",
      },
    });

    // Should now display rejection message and "Request Again" button
    expect(
      await screen.findByText(
        "Your access request was declined. You may request again.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: /Request Again/i }),
    ).toBeDefined();

    // GET /access-requests returns 404 for plain requesters; ensure it was NEVER called
    const getAccessReqCalls = mockFetchWithAuth.mock.calls.filter(
      ([url, init]) =>
        url === `/api/entities/${RECORD_ID}/access-requests` &&
        (!init || (init as { method?: string }).method !== "POST"),
    );
    expect(getAccessReqCalls.length).toBe(0);
  });
});

// accessDenied is derived from accessList rather than held in sticky state,
// so the overlay lifts as soon as an approved requester appears in a
// refreshed list. loadRecord() also runs silently (live comment.created
// push, manual refresh); a transient /access failure there must not wipe the
// list to [] and drop the overlay for a denied viewer, and the list kept on
// failure must never carry over from one record to the next.
describe("CustomerRecordDetail — access-denied overlay across silent refreshes and record navigation", () => {
  const PLAIN_VIEWER = "u-plain-viewer";
  const OTHER_RECORD_ID = "rec-2";
  const OWNER_ENTRY = {
    userId: "u-owner",
    level: "read_write",
    tag: "creator",
  };

  type GateRecord = { subject: string; access: () => Promise<unknown> };

  function mockAccessGateRoutes(records: Record<string, GateRecord>): void {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/entity-types/${ENTITY_TYPE_ID}/fields`) {
        return Promise.resolve({
          data: [
            {
              id: "f-subject",
              name: "subject",
              label: "Subject",
              fieldType: "text",
              isRequired: true,
              isSystem: false,
              config: {},
            },
          ],
        });
      }
      for (const [recId, rec] of Object.entries(records)) {
        if (url === `/api/entities/${recId}`) {
          return Promise.resolve({
            data: {
              ...BASE_RECORD,
              id: recId,
              createdBy: OWNER_ENTRY.userId,
              fields: { subject: rec.subject },
            },
          });
        }
        if (url === `/api/entities/${recId}/access`) return rec.access();
      }
      return Promise.resolve({ data: [] });
    });
  }

  const deniedAccess = (): Promise<unknown> =>
    Promise.resolve({ data: [OWNER_ENTRY] });
  const failedAccess = (): Promise<unknown> =>
    Promise.reject(new Error("503 Service Unavailable"));

  function pushCommentCreated(): void {
    capturedRoomHandler?.({
      type: "comment.created",
      instanceId: RECORD_ID,
      commentId: "c-live",
      actorId: OWNER_ENTRY.userId,
    });
  }

  beforeEach(() => {
    capturedRoomHandler = null;
    mockUserId = PLAIN_VIEWER;
    mockProfileRoles = ["user"];
  });

  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockUnsubscribe.mockReset();
    mockProfileRoles = ["user"];
    mockUserId = OTHER_USER;
  });

  it("shows the Access Restricted overlay for a plain user missing from the ticket's access list", async () => {
    mockAccessGateRoutes({
      [RECORD_ID]: { subject: "Gated ticket", access: deniedAccess },
    });

    renderRecordDetail();

    expect(await screen.findByText("Access Restricted")).toBeDefined();
  });

  it("keeps the overlay when a silent refresh's /access request fails", async () => {
    mockAccessGateRoutes({
      [RECORD_ID]: { subject: "Gated ticket", access: deniedAccess },
    });
    renderRecordDetail();
    await screen.findByText("Access Restricted");
    await waitFor(() => expect(capturedRoomHandler).not.toBeNull());

    // Same tick as setAccessList in loadRecord(), so once the new subject
    // renders the (skipped) access-list update has settled too.
    mockAccessGateRoutes({
      [RECORD_ID]: {
        subject: "Gated ticket (refreshed)",
        access: failedAccess,
      },
    });
    pushCommentCreated();

    await screen.findAllByText("Gated ticket (refreshed)");
    expect(screen.getByText("Access Restricted")).toBeDefined();
  });

  it("lifts the overlay when a silent refresh's access list now includes the viewer", async () => {
    mockAccessGateRoutes({
      [RECORD_ID]: { subject: "Gated ticket", access: deniedAccess },
    });
    renderRecordDetail();
    await screen.findByText("Access Restricted");
    await waitFor(() => expect(capturedRoomHandler).not.toBeNull());

    // The owner approved the request — the refreshed list now has the viewer.
    mockAccessGateRoutes({
      [RECORD_ID]: {
        subject: "Gated ticket (refreshed)",
        access: () =>
          Promise.resolve({
            data: [
              OWNER_ENTRY,
              { userId: PLAIN_VIEWER, level: "read_only", tag: "manual" },
            ],
          }),
      },
    });
    pushCommentCreated();

    await screen.findAllByText("Gated ticket (refreshed)");
    expect(screen.queryByText("Access Restricted")).toBeNull();
  });

  it("does not carry one record's access list onto another when navigating between record ids", async () => {
    mockAccessGateRoutes({
      [RECORD_ID]: { subject: "Gated ticket", access: deniedAccess },
      // Record B's /access fails: with no reset on id change, record A's
      // list (which denies this viewer) would survive and gate record B.
      [OTHER_RECORD_ID]: { subject: "Other ticket", access: failedAccess },
    });

    render(
      <MemoryRouter initialEntries={[`/records/ticket/${RECORD_ID}`]}>
        <Link to={`/records/ticket/${OTHER_RECORD_ID}`}>
          Go to other record
        </Link>
        <Routes>
          <Route
            path="/records/:typeSlug/:id"
            element={<CustomerRecordDetail />}
          />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Access Restricted");

    fireEvent.click(screen.getByText("Go to other record"));

    await screen.findAllByText("Other ticket");
    expect(screen.queryByText("Access Restricted")).toBeNull();
  });
});
