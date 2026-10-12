import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const { sameMembers, auditWorkflowAdminsChange, auditTransitionRoleChanges } =
  await import("./audit-workflow-access.js");

const TX = { tag: "tx" } as unknown as Parameters<
  typeof auditWorkflowAdminsChange
>[0];

const ids = { tenantId: "t-1", actorId: "u-actor", workflowId: "wf-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteAuditEntry.mockResolvedValue(undefined);
});

describe("sameMembers", () => {
  it("ignores order", () => {
    expect(sameMembers(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("ignores duplicates", () => {
    expect(sameMembers(["a", "a", "b"], ["b", "a"])).toBe(true);
  });

  it("detects differing members and sizes", () => {
    expect(sameMembers(["a"], ["b"])).toBe(false);
    expect(sameMembers(["a"], ["a", "b"])).toBe(false);
  });

  it("treats null and undefined as empty", () => {
    expect(sameMembers(null, [])).toBe(true);
    expect(sameMembers(undefined, null)).toBe(true);
    expect(sameMembers(null, ["a"])).toBe(false);
  });
});

describe("auditWorkflowAdminsChange", () => {
  it("writes nothing when membership is unchanged", async () => {
    await auditWorkflowAdminsChange(TX, {
      ...ids,
      before: ["a", "b"],
      after: ["b", "a", "a"],
    });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("writes a workflow.admins_updated entry with snapshots", async () => {
    await auditWorkflowAdminsChange(TX, {
      ...ids,
      before: ["a"],
      after: ["a", "b"],
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const [tx, entry] = mockWriteAuditEntry.mock.calls[0];
    expect(tx).toBe(TX);
    expect(entry).toEqual({
      tenantId: "t-1",
      actorId: "u-actor",
      actorType: "user",
      resourceType: "workflow",
      resourceId: "wf-1",
      action: "workflow.admins_updated",
      beforeSnapshot: { assignedTo: ["a"] },
      afterSnapshot: { assignedTo: ["a", "b"] },
    });
  });
});

describe("auditTransitionRoleChanges", () => {
  it("writes nothing for an empty list or only unchanged transitions", async () => {
    await auditTransitionRoleChanges(TX, { ...ids, changes: [] });
    await auditTransitionRoleChanges(TX, {
      ...ids,
      changes: [
        {
          transitionId: "tr-1",
          fromState: "open",
          toState: "closed",
          before: ["admin", "agent"],
          after: ["agent", "admin"],
        },
      ],
    });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("always counts a created transition, even with an empty role set", async () => {
    await auditTransitionRoleChanges(TX, {
      ...ids,
      changes: [
        {
          transitionId: "tr-new",
          fromState: "open",
          toState: "closed",
          before: null,
          after: [],
        },
      ],
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("workflow.transition_roles_updated");
    expect(entry.beforeSnapshot).toEqual({ "tr-new": null });
    expect(entry.afterSnapshot).toEqual({ "tr-new": [] });
    expect(entry.metadata.transitions).toEqual([
      {
        transitionId: "tr-new",
        fromState: "open",
        toState: "closed",
        created: true,
        deleted: false,
      },
    ]);
  });

  it("always counts a deleted transition and records its removed role gate", async () => {
    await auditTransitionRoleChanges(TX, {
      ...ids,
      changes: [
        {
          transitionId: "tr-gone",
          fromState: "open",
          toState: "closed",
          before: ["manager"],
          after: null,
        },
      ],
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("workflow.transition_roles_updated");
    expect(entry.beforeSnapshot).toEqual({ "tr-gone": ["manager"] });
    expect(entry.afterSnapshot).toEqual({ "tr-gone": null });
    expect(entry.metadata.transitions).toEqual([
      {
        transitionId: "tr-gone",
        fromState: "open",
        toState: "closed",
        created: false,
        deleted: true,
      },
    ]);
  });

  it("collapses multiple changes into one entry and excludes unchanged ones", async () => {
    await auditTransitionRoleChanges(TX, {
      ...ids,
      changes: [
        {
          transitionId: "tr-1",
          fromState: "a",
          toState: "b",
          before: ["agent"],
          after: ["agent", "admin"],
        },
        {
          transitionId: "tr-2",
          fromState: "b",
          toState: "c",
          before: ["agent"],
          after: ["agent"],
        },
        {
          transitionId: "tr-3",
          fromState: "c",
          toState: "d",
          before: null,
          after: ["user"],
        },
      ],
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry).toMatchObject({
      tenantId: "t-1",
      actorId: "u-actor",
      actorType: "user",
      resourceType: "workflow",
      resourceId: "wf-1",
    });
    expect(entry.beforeSnapshot).toEqual({
      "tr-1": ["agent"],
      "tr-3": null,
    });
    expect(entry.afterSnapshot).toEqual({
      "tr-1": ["agent", "admin"],
      "tr-3": ["user"],
    });
    expect(entry.metadata.transitions).toEqual([
      {
        transitionId: "tr-1",
        fromState: "a",
        toState: "b",
        created: false,
        deleted: false,
      },
      {
        transitionId: "tr-3",
        fromState: "c",
        toState: "d",
        created: true,
        deleted: false,
      },
    ]);
  });
});
