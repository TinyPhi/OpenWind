import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const mockGetUser =
  vi.fn<() => Promise<{ profile: Record<string, unknown> } | undefined>>();
vi.mock("../authProvider.js", () => ({
  userManager: { getUser: (): unknown => mockGetUser() },
}));

const mockGetOrgTree = vi.fn<() => Promise<unknown>>();
const mockGetOrgSyncStatus = vi.fn<() => Promise<unknown>>();
const mockTriggerOrgSync = vi.fn<() => Promise<unknown>>();
vi.mock("../lib/org-directory-client.js", () => ({
  getOrgTree: (): unknown => mockGetOrgTree(),
  getOrgSyncStatus: (): unknown => mockGetOrgSyncStatus(),
  triggerOrgSync: (): unknown => mockTriggerOrgSync(),
}));

const { OrgDirectoryPage } = await import("./org-directory.js");

const ROOT = {
  userId: "root-id",
  parentId: null,
  name: "Acme Corp",
  title: "",
  department: "",
  email: "",
  isRoot: true,
};
const CEO = {
  userId: "ceo",
  parentId: "root-id",
  name: "CEO Person",
  title: "Chief Executive",
  department: "executive",
  email: "ceo@example.com",
  isRoot: false,
};
const VP = {
  userId: "vp",
  parentId: "ceo",
  name: "VP Person",
  title: "VP Eng",
  department: "engineering",
  email: "vp@example.com",
  isRoot: false,
};

const TREE = {
  root: ROOT,
  nodesByParentId: {
    "root-id": [CEO],
    ceo: [VP],
  },
};

const SYNC_STATUS = {
  lastSyncedAt: new Date().toISOString(),
  lastSyncOk: true,
  staleSinceMs: 1000,
  syncInProgress: false,
};

function agentProfile(): { profile: Record<string, unknown> } {
  return { profile: { "urn:zitadel:iam:org:project:roles": { agent: {} } } };
}
function adminProfile(): { profile: Record<string, unknown> } {
  return { profile: { "urn:zitadel:iam:org:project:roles": { admin: {} } } };
}

describe("OrgDirectoryPage", () => {
  beforeEach(() => {
    mockGetOrgTree.mockResolvedValue(TREE);
    mockGetOrgSyncStatus.mockResolvedValue(SYNC_STATUS);
    mockGetUser.mockResolvedValue(agentProfile());
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the tree with the root and default-expanded levels visible", async () => {
    render(<OrgDirectoryPage />);

    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeTruthy());
    expect(screen.getByText("CEO Person")).toBeTruthy();
    expect(screen.getByText("VP Person")).toBeTruthy();
  });

  it("does not show the Sync now button for a non-admin", async () => {
    render(<OrgDirectoryPage />);

    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeTruthy());
    expect(screen.queryByText("Sync now")).toBeNull();
  });

  it("shows the Sync now button for an admin and triggers a sync on click", async () => {
    mockGetUser.mockResolvedValue(adminProfile());
    mockTriggerOrgSync.mockResolvedValue({
      status: "completed",
      syncedAt: new Date().toISOString(),
      employeeCount: 3,
      cyclesBroken: 0,
      reparented: 0,
    });

    render(<OrgDirectoryPage />);

    await waitFor(() => expect(screen.getByText("Sync now")).toBeTruthy());
    fireEvent.click(screen.getByText("Sync now"));

    await waitFor(() => expect(mockTriggerOrgSync).toHaveBeenCalled());
  });

  it("shows a no-tree message when nothing has been synced yet", async () => {
    mockGetOrgTree.mockResolvedValue(null);

    render(<OrgDirectoryPage />);

    await waitFor(() =>
      expect(
        screen.getByText(/an admin needs to run the first sync/),
      ).toBeTruthy(),
    );
  });

  it("shows the last-sync-failed indicator without blanking the tree (R -- stale-but-working)", async () => {
    mockGetOrgSyncStatus.mockResolvedValue({
      ...SYNC_STATUS,
      lastSyncOk: false,
    });

    render(<OrgDirectoryPage />);

    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeTruthy());
    expect(screen.getByText(/Last sync failed/)).toBeTruthy();
  });
});
