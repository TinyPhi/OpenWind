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
// Depth 3 -- still rendered by default (its parent, VP at depth 2, is
// expanded), but LEAF itself is not expanded by default, so LEAF_CHILD
// (depth 4) starts genuinely hidden. This is what proves R9's auto-expand
// actually reveals a collapsed node, not just highlights an already-visible
// one.
const LEAF = {
  userId: "leaf",
  parentId: "vp",
  name: "Leaf Person",
  title: "Engineer",
  department: "engineering",
  email: "leaf@example.com",
  isRoot: false,
};
const LEAF_CHILD = {
  userId: "leaf-child",
  parentId: "leaf",
  name: "Hidden Report",
  title: "Engineer",
  department: "engineering",
  email: "hidden-report@example.com",
  isRoot: false,
};

const TREE = {
  root: ROOT,
  nodesByParentId: {
    "root-id": [CEO],
    ceo: [VP],
    vp: [LEAF],
    leaf: [LEAF_CHILD],
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

  describe("search (R9 -- highlight a match and auto-expand its ancestor path)", () => {
    it("reveals a node that starts collapsed below the default expand depth", async () => {
      render(<OrgDirectoryPage />);

      await waitFor(() => expect(screen.getByText("Acme Corp")).toBeTruthy());
      // LEAF_CHILD is depth 4, below the default depth-3 expand -- its
      // parent (LEAF) is rendered but not expanded, so LEAF_CHILD starts
      // genuinely absent from the DOM, not just visually collapsed.
      expect(screen.queryByText("Hidden Report")).toBeNull();

      fireEvent.change(
        screen.getByPlaceholderText("Search by name or email…"),
        { target: { value: "Hidden Report" } },
      );

      await waitFor(() =>
        expect(screen.getByText("Hidden Report")).toBeTruthy(),
      );
    });

    it("leaves the tree unchanged and highlights nothing when the search matches no one", async () => {
      render(<OrgDirectoryPage />);

      await waitFor(() => expect(screen.getByText("Acme Corp")).toBeTruthy());

      fireEvent.change(
        screen.getByPlaceholderText("Search by name or email…"),
        { target: { value: "nobody-with-this-name" } },
      );

      // No crash, no new node revealed, previously-visible nodes unaffected.
      expect(screen.getByText("CEO Person")).toBeTruthy();
      expect(screen.queryByText("Hidden Report")).toBeNull();
    });

    it("highlights the first match in tree order when multiple employees match (documents single-match behaviour)", async () => {
      render(<OrgDirectoryPage />);

      await waitFor(() => expect(screen.getByText("Acme Corp")).toBeTruthy());

      // "Person" matches both CEO Person and VP Person. allNodes is built
      // root-first, then by nodesByParentId's own key order -- CEO comes
      // before VP, so CEO is the documented first match.
      fireEvent.change(
        screen.getByPlaceholderText("Search by name or email…"),
        { target: { value: "Person" } },
      );

      // jsdom normalizes hsl() to rgb() in computed style strings, so assert
      // on the highlight's distinguishing border width/box-shadow rather than
      // its color literal.
      await waitFor(() => {
        const ceoCard = screen.getByText("CEO Person").parentElement;
        expect(ceoCard?.getAttribute("style")).toContain("2px solid");
      });
      const vpCard = screen.getByText("VP Person").parentElement;
      expect(vpCard?.getAttribute("style")).not.toContain("2px solid");
    });
  });
});
