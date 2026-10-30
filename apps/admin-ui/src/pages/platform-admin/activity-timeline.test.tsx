import { describe, it, expect, vi, afterEach } from "vitest";
import "../../i18n.js";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import type { AuditEntry } from "./format.js";

const mockFetchWithAuth = vi.fn(
  (_url: string): Promise<unknown> => Promise.resolve({ data: [] }),
);
vi.mock("../../lib/api.js", () => ({
  fetchWithAuth: (url: string) => mockFetchWithAuth(url),
  API_URL: "/api",
}));

const { ActivityTimeline } = await import("./activity-timeline.js");

const LIVE_TENANT = "11111111-1111-4111-8111-111111111111";
const GONE_TENANT = "99999999-9999-4999-8999-999999999999";

function entry(n: number, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: `0000000${n}-0000-4000-8000-000000000000`.slice(0, 36),
    actorSub: "pa-1",
    action: "sandbox.created",
    targetTenantId: LIVE_TENANT,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const NAMES = new Map([[LIVE_TENANT, "Acme Sandbox"]]);

function renderTimeline(
  props: Partial<{ targetTenantId: string; compact: boolean }> = {},
): ReturnType<typeof render> {
  return render(
    <ActivityTimeline
      tenantNames={NAMES}
      currentUserId="pa-1"
      refreshKey={0}
      {...props}
    />,
  );
}

describe("ActivityTimeline", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("requests the first page of the audit log", async () => {
    renderTimeline();
    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        "/api/platform-admin/audit-log?limit=20",
      );
    });
  });

  it("scopes the request to one tenant when targetTenantId is given", async () => {
    renderTimeline({ targetTenantId: LIVE_TENANT, compact: true });
    await waitFor(() => {
      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        `/api/platform-admin/audit-log?limit=20&targetTenantId=${LIVE_TENANT}`,
      );
    });
  });

  it("shows an empty state", async () => {
    renderTimeline();
    await waitFor(() => {
      expect(screen.getByText("No activity yet.")).toBeTruthy();
    });
  });

  it("renders entries under a day heading with tenant name and actor", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [
        entry(1),
        entry(2, {
          action: "sandbox.deleted",
          targetTenantId: GONE_TENANT,
          actorSub: "other-admin-sub",
        }),
      ],
    });
    renderTimeline();

    await waitFor(() => screen.getByText("Today"));
    expect(screen.getByText("Created sandbox")).toBeTruthy();
    expect(screen.getByText("Acme Sandbox")).toBeTruthy();
    expect(screen.getByText("Deleted tenant 99999999")).toBeTruthy();
    expect(screen.getByText(/^You ·/)).toBeTruthy();
    expect(screen.getByText(/^Admin other-ad ·/)).toBeTruthy();
  });

  it("labels trial extensions and ends", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [
        entry(1, { action: "sandbox.trial_changed" }),
        entry(2, { action: "sandbox.trial_ended" }),
      ],
    });
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText("Extended trial")).toBeTruthy();
      expect(screen.getByText("Ended trial")).toBeTruthy();
    });
  });

  it("filters loaded entries by action", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [entry(1), entry(2, { action: "sandbox.reset" })],
    });
    renderTimeline();

    await waitFor(() => screen.getByText("Reset sandbox"));
    fireEvent.change(screen.getByLabelText("Filter activity by action"), {
      target: { value: "sandbox.reset" },
    });
    expect(screen.queryByText("Created sandbox")).toBeNull();
    expect(screen.getByText("Reset sandbox")).toBeTruthy();
  });

  it("hides the action filter and tenant names in compact mode", async () => {
    mockFetchWithAuth.mockResolvedValueOnce({ data: [entry(1)] });
    renderTimeline({ targetTenantId: LIVE_TENANT, compact: true });

    await waitFor(() => screen.getByText("Created sandbox"));
    expect(screen.queryByLabelText("Filter activity by action")).toBeNull();
    expect(screen.queryByText("Acme Sandbox")).toBeNull();
  });

  it("loads the next page through the before cursor", async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) =>
      entry(i, {
        id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      }),
    );
    const last = firstPage[19];
    mockFetchWithAuth.mockResolvedValueOnce({ data: firstPage });
    mockFetchWithAuth.mockResolvedValueOnce({
      data: [
        entry(99, {
          id: "eeeeeeee-0000-4000-8000-000000000000",
          action: "sandbox.reset",
        }),
      ],
    });
    renderTimeline();

    await waitFor(() => screen.getByText("Load more"));
    fireEvent.click(screen.getByText("Load more"));

    await waitFor(() => screen.getByText("Reset sandbox"));
    expect(mockFetchWithAuth).toHaveBeenLastCalledWith(
      `/api/platform-admin/audit-log?limit=20&before=${last?.id ?? ""}`,
    );
    expect(screen.queryByText("Load more")).toBeNull();
  });

  it("shows an error when the audit log fails to load", async () => {
    mockFetchWithAuth.mockRejectedValueOnce(new Error("boom"));
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("boom");
    });
  });
});
