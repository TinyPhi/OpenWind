import React, { act } from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  renderHook,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { useModal } from "./hooks/use-modal.js";
import { useDebouncedCallback } from "./hooks/use-debounce.js";
import { useFormState } from "./hooks/use-form-state.js";
import { useAsyncAction } from "./hooks/use-async-action.js";

// ============================================================================
// Types & Mocks for Integration Tests
// ============================================================================

interface MockProfile {
  readonly sub: string;
  readonly email: string;
  readonly "urn:zitadel:iam:org:project:roles": Record<
    string,
    Record<string, never>
  >;
}

interface MockUserSession {
  readonly profile: MockProfile;
}

interface TestEntityInstance {
  readonly id: string;
  readonly entityTypeId: string;
  readonly workflowId: string | null;
  readonly currentState: string | null;
  readonly fields: Record<string, string>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly assignedTo: string | null;
  readonly dueDate: string | null;
  readonly createdBy: string;
}

let mockCurrentUserId = "u-user-1";
let mockCurrentRoles: readonly string[] = ["admin"];

vi.mock("./authProvider.js", () => ({
  userManager: {
    getUser: (): Promise<MockUserSession> =>
      Promise.resolve({
        profile: {
          sub: mockCurrentUserId,
          email: "test@example.com",
          "urn:zitadel:iam:org:project:roles": Object.fromEntries(
            mockCurrentRoles.map((r) => [r, {}]),
          ),
        },
      }),
  },
}));

vi.mock("./entity-type-context.js", () => ({
  useEntityTypes: () => ({
    getTypeBySlug: () => ({
      id: "et-ticket",
      name: "Ticket",
      plural: "Tickets",
    }),
    getTypeById: () => ({
      id: "et-ticket",
      name: "Ticket",
      plural: "Tickets",
    }),
  }),
  toTypeSlug: (s: string): string => s.toLowerCase(),
}));

vi.mock("./hooks/use-file-upload.js", () => ({
  useFileUpload: () => ({
    stagedFiles: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clearFiles: vi.fn(),
    pendingCount: 0,
    cleanFileIds: [],
  }),
}));

const mockUnsubscribe = vi.fn();
vi.mock("./lib/notifications-client.js", () => ({
  subscribeToTicketRoom: () => mockUnsubscribe,
}));

type FetchResponse = { readonly data: unknown };
const mockFetchWithAuth = vi.fn(
  (_url: string, _init?: unknown): Promise<FetchResponse> => {
    return Promise.resolve({ data: [] });
  },
);

vi.mock("./lib/api.js", () => ({
  API_URL: "/api",
  fetchWithAuth: (url: string, init?: unknown): Promise<FetchResponse> =>
    mockFetchWithAuth(url, init),
}));

// Mock sub-pages for OnCallAdminPage to test tab-level code splitting & suspense
vi.mock("./pages/teams/index.js", () => ({
  TeamsPage: (): React.ReactElement => (
    <div data-testid="teams-tab-view">Teams Page Active</div>
  ),
}));

vi.mock("./pages/services/index.js", () => ({
  ServicesPage: (): React.ReactElement => (
    <div data-testid="services-tab-view">Services Page Active</div>
  ),
}));

vi.mock("./pages/roster/index.js", () => ({
  RosterPage: (): React.ReactElement => (
    <div data-testid="roster-tab-view">On-Call Roster Page Active</div>
  ),
}));

vi.mock("./pages/notification-policies/index.js", () => ({
  NotificationPoliciesPage: (): React.ReactElement => (
    <div data-testid="policies-tab-view">Notification Policies Page Active</div>
  ),
}));

const { CustomerRecordDetail } =
  await import("./pages/customer/record-detail.js");
const { OnCallAdminPage } = await import("./pages/admin-oncall/index.js");

// ============================================================================
// Test Suite: Frontend State & Rendering Optimizations Regression Verification
// ============================================================================

describe("State & Rendering Optimizations — Architectural Regression Gate", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockCurrentUserId = "u-user-1";
    mockCurrentRoles = ["admin"];
  });

  afterEach(() => {
    cleanup();
    mockFetchWithAuth.mockReset();
    mockUnsubscribe.mockReset();
  });

  // --------------------------------------------------------------------------
  // 1. Centralized useModal Hook State Machine Contract
  // --------------------------------------------------------------------------
  describe("Hook Centralization: useModal State Machine Invariants", () => {
    interface TestItem {
      readonly id: string;
      readonly title: string;
    }

    it("initializes in closed state with null data and default mode", () => {
      const { result } = renderHook(() => useModal<TestItem>());
      expect(result.current.isOpen).toBe(false);
      expect(result.current.item).toBeNull();
      expect(result.current.mode).toBe("create");
    });

    it("transitions safely between create, edit with payload, and closed", () => {
      const { result } = renderHook(() => useModal<TestItem>());

      // Open in create mode
      act(() => {
        result.current.openCreate();
      });
      expect(result.current.isOpen).toBe(true);
      expect(result.current.item).toBeNull();
      expect(result.current.mode).toBe("create");

      // Transition to edit mode with payload
      const testItem: TestItem = { id: "item-123", title: "Urgent Incident" };
      act(() => {
        result.current.openEdit(testItem);
      });
      expect(result.current.isOpen).toBe(true);
      expect(result.current.item).toEqual(testItem);
      expect(result.current.mode).toBe("edit");

      // Update payload during edit
      act(() => {
        result.current.openEdit({ id: "item-123", title: "Renamed Incident" });
      });
      expect(result.current.item?.title).toBe("Renamed Incident");

      // Close modal - resets open state and payload
      act(() => {
        result.current.close();
      });
      expect(result.current.isOpen).toBe(false);
      expect(result.current.item).toBeNull();
      expect(result.current.isEditing).toBe(false);
      expect(result.current.isCreating).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 2. High-Frequency Debounce Hook Invariants
  // --------------------------------------------------------------------------
  describe("Hook Centralization: useDebouncedCallback Event Throttling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("collapses 10 rapid keystrokes into exactly 1 settled callback invocation", () => {
      const spy = vi.fn();
      const { result } = renderHook(() =>
        useDebouncedCallback<[string]>(spy, 250),
      );

      // Simulate fast user typing
      for (let i = 1; i <= 10; i++) {
        act(() => {
          result.current(`query-char-${i}`);
        });
      }

      // No execution before debounce window passes
      expect(spy).not.toHaveBeenCalled();
      expect(result.current.isPending()).toBe(true);

      // Advance clock past threshold
      act(() => {
        vi.advanceTimersByTime(250);
      });

      // Exactly 1 invocation with the final settled argument
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("query-char-10");
      expect(result.current.isPending()).toBe(false);
    });

    it("supports immediate flush() on form submit or blur", () => {
      const spy = vi.fn();
      const { result } = renderHook(() =>
        useDebouncedCallback<[string]>(spy, 500),
      );

      act(() => {
        result.current("final-value");
      });
      expect(spy).not.toHaveBeenCalled();

      // Immediately flush
      act(() => {
        result.current.flush();
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("final-value");
      expect(result.current.isPending()).toBe(false);
    });

    it("cancels pending timer cleanly when cancel() is called", () => {
      const spy = vi.fn();
      const { result } = renderHook(() =>
        useDebouncedCallback<[string]>(spy, 500),
      );

      act(() => {
        result.current("abandoned-query");
      });
      act(() => {
        result.current.cancel();
      });

      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(spy).not.toHaveBeenCalled();
      expect(result.current.isPending()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Unified Form State Model & Dirty Flag Tracking
  // --------------------------------------------------------------------------
  describe("Hook Centralization: useFormState Atomic State & Dirty Checking", () => {
    interface TestForm {
      readonly name: string;
      readonly description: string;
      readonly isEnabled: boolean;
    }

    const initial: TestForm = {
      name: "Default Rule",
      description: "Default Description",
      isEnabled: true,
    };

    it("tracks dirty flag and permits atomic field updates without scalar cascades", () => {
      const { result } = renderHook(() =>
        useFormState<TestForm>({ initialValues: initial }),
      );

      expect(result.current.values).toEqual(initial);
      expect(result.current.isDirty).toBe(false);

      // Single field update
      act(() => {
        result.current.setFieldValue("name", "Updated Rule");
      });
      expect(result.current.values.name).toBe("Updated Rule");
      expect(result.current.values.description).toBe("Default Description");
      expect(result.current.isDirty).toBe(true);

      // Bulk atomic update
      act(() => {
        result.current.setValues({
          description: "Updated Description",
          isEnabled: false,
        });
      });
      expect(result.current.values).toEqual({
        name: "Updated Rule",
        description: "Updated Description",
        isEnabled: false,
      });

      // Reset restores baseline and clears isDirty
      act(() => {
        result.current.reset();
      });
      expect(result.current.values).toEqual(initial);
      expect(result.current.isDirty).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 4. useAsyncAction Execution Lifecycle & Error Isolation
  // --------------------------------------------------------------------------
  describe("Hook Centralization: useAsyncAction Execution Invariants", () => {
    it("handles success lifecycle with loading flag and onSuccess callback", async () => {
      const onSuccessSpy = vi.fn();
      const actionFn = vi.fn(
        (id: string): Promise<{ readonly status: string }> => {
          return Promise.resolve({ status: `resolved-${id}` });
        },
      );

      const { result } = renderHook(() =>
        useAsyncAction<{ readonly status: string }, string>(actionFn, {
          onSuccess: onSuccessSpy,
        }),
      );

      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();

      let executionPromise: Promise<{ readonly status: string } | null>;
      act(() => {
        executionPromise = result.current.execute("item-1");
      });

      const outcome = await act(async () => await executionPromise);

      expect(outcome).toEqual({ status: "resolved-item-1" });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBeNull();
      expect(result.current.data).toEqual({ status: "resolved-item-1" });
      expect(onSuccessSpy).toHaveBeenCalledWith(
        { status: "resolved-item-1" },
        "item-1",
      );
    });

    it("captures and normalizes errors safely without uncaught exceptions", async () => {
      const actionFn = vi.fn((): Promise<string> => {
        return Promise.reject(new Error("Network timeout"));
      });

      const { result } = renderHook(() =>
        useAsyncAction<string, void>(actionFn),
      );

      let executionPromise: Promise<string | null>;
      act(() => {
        executionPromise = result.current.execute();
      });

      const outcome = await act(async () => await executionPromise);

      expect(outcome).toBeNull();
      expect(result.current.isLoading).toBe(false);
      expect(result.current.error).toBe("Network timeout");
      expect(result.current.data).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 5. CustomerRecordDetail Navigation Race Condition Guard (activeTicketIdRef)
  // --------------------------------------------------------------------------
  describe("Race Condition Guard: activeTicketIdRef & Out-of-Order Navigation", () => {
    const TICKET_A_ID = "ticket-alpha";
    const TICKET_B_ID = "ticket-beta";

    const TICKET_A: TestEntityInstance = {
      id: TICKET_A_ID,
      entityTypeId: "et-ticket",
      workflowId: null,
      currentState: null,
      fields: { subject: "Slow Ticket Alpha" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignedTo: null,
      dueDate: null,
      createdBy: "u-user-1",
    };

    const TICKET_B: TestEntityInstance = {
      id: TICKET_B_ID,
      entityTypeId: "et-ticket",
      workflowId: null,
      currentState: null,
      fields: { subject: "Fast Ticket Beta" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      assignedTo: null,
      dueDate: null,
      createdBy: "u-user-1",
    };

    it("discards delayed responses from abandoned tickets when user navigates quickly", async () => {
      let resolveTicketA: ((val: FetchResponse) => void) | null = null;

      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url === `/api/entities/${TICKET_A_ID}`) {
          // Slow response for Ticket A
          return new Promise<FetchResponse>((res) => {
            resolveTicketA = res;
          });
        }
        if (url === `/api/entities/${TICKET_B_ID}`) {
          // Fast response for Ticket B
          return Promise.resolve({ data: TICKET_B });
        }
        if (url.includes("/fields")) {
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
        if (url.includes("/access")) {
          return Promise.resolve({ data: [] });
        }
        if (url.includes("/comments") || url.includes("/transitions/history")) {
          return Promise.resolve({ data: [] });
        }
        return Promise.resolve({ data: [] });
      });

      let navigateFn: ((to: string) => void) | null = null;
      function NavHarness(): React.ReactElement {
        const navigate = useNavigate();
        navigateFn = navigate;
        return <CustomerRecordDetail />;
      }

      // Render on Ticket A
      render(
        <MemoryRouter initialEntries={[`/records/ticket/${TICKET_A_ID}`]}>
          <Routes>
            <Route path="/records/:typeSlug/:id" element={<NavHarness />} />
          </Routes>
        </MemoryRouter>,
      );

      // Verify Ticket A is currently loading and hasn't displayed yet
      expect(screen.queryByText("Slow Ticket Alpha")).toBeNull();

      // User navigates to Ticket B before Ticket A resolves
      act(() => {
        navigateFn?.(`/records/ticket/${TICKET_B_ID}`);
      });

      // Ticket B loads quickly and renders
      await waitFor(() => {
        const matches = screen.getAllByText("Fast Ticket Beta");
        expect(matches.length).toBeGreaterThanOrEqual(1);
      });

      // Now Ticket A's delayed network request finally arrives!
      act(() => {
        resolveTicketA?.({ data: TICKET_A });
      });

      // Regression Assertion: activeTicketIdRef MUST discard Ticket A's data!
      // Ticket B must remain authoritative and on the screen.
      await new Promise((r) => setTimeout(r, 50));
      const matches = screen.getAllByText("Fast Ticket Beta");
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("Slow Ticket Alpha")).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 6. Sub-Resource 404 Prevention Guard
  // --------------------------------------------------------------------------
  describe("Sub-Resource 404 Guard: Preventing Cascading Network Errors", () => {
    it("does not fire sub-resource requests (comments, attachments, tags) when record returns 404", async () => {
      const dispatchedUrls: string[] = [];

      mockFetchWithAuth.mockImplementation((url: string) => {
        dispatchedUrls.push(url);
        if (url === "/api/entities/missing-record-id") {
          return Promise.reject({ status: 404, message: "Record not found" });
        }
        return Promise.resolve({ data: [] });
      });

      render(
        <MemoryRouter initialEntries={["/records/ticket/missing-record-id"]}>
          <Routes>
            <Route
              path="/records/:typeSlug/:id"
              element={<CustomerRecordDetail />}
            />
          </Routes>
        </MemoryRouter>,
      );

      expect(
        await screen.findByText("You don't have access to this record"),
      ).toBeDefined();

      // Verify root record request was made
      expect(dispatchedUrls).toContain("/api/entities/missing-record-id");

      // Verify NO cascading sub-resource requests were fired
      expect(
        dispatchedUrls.some(
          (u) => u.includes("/comments") || u.includes("eventType=comment"),
        ),
      ).toBe(false);
      expect(dispatchedUrls.some((u) => u.includes("/attachments"))).toBe(
        false,
      );
      expect(dispatchedUrls.some((u) => u.includes("/tags"))).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 7. OnCallAdminPage Tab Route Code Splitting & Suspense Contract
  // --------------------------------------------------------------------------
  describe("OnCallAdminPage: Tab Route Code Splitting & Suspense Contract", () => {
    it("renders default tab under Suspense and transitions between tabs smoothly", async () => {
      render(
        <MemoryRouter initialEntries={["/admin/oncall?tab=teams"]}>
          <Routes>
            <Route path="/admin/oncall" element={<OnCallAdminPage />} />
          </Routes>
        </MemoryRouter>,
      );

      // Default Teams tab is active
      expect(await screen.findByTestId("teams-tab-view")).toBeDefined();
      expect(screen.queryByTestId("services-tab-view")).toBeNull();

      // Click "Services" tab
      const servicesTabButton = screen.getByRole("button", {
        name: "Services",
      });
      fireEvent.click(servicesTabButton);

      // Suspense resolves dynamic chunk and renders Services page
      expect(await screen.findByTestId("services-tab-view")).toBeDefined();
      expect(screen.queryByTestId("teams-tab-view")).toBeNull();

      // Click "On-Call Roster" tab
      const rosterTabButton = screen.getByRole("button", {
        name: "On-Call Roster",
      });
      fireEvent.click(rosterTabButton);

      expect(await screen.findByTestId("roster-tab-view")).toBeDefined();
      expect(screen.queryByTestId("services-tab-view")).toBeNull();

      // Click "Notification Policies" tab
      const policiesTabButton = screen.getByRole("button", {
        name: "Notification Policies",
      });
      fireEvent.click(policiesTabButton);

      expect(await screen.findByTestId("policies-tab-view")).toBeDefined();
      expect(screen.queryByTestId("roster-tab-view")).toBeNull();
    });
  });
});
