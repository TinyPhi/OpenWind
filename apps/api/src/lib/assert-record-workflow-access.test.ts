import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as WorkflowEngine from "@platform/workflow-engine";

const mockGetWorkflow = vi.fn();

vi.mock("@platform/db", () => ({
  entityInstances: {
    id: "id",
    tenantId: "tenantId",
    workflowId: "workflowId",
    createdBy: "createdBy",
    assignedTo: "assignedTo",
  },
}));

vi.mock("@platform/workflow-engine", async (importOriginal) => {
  const real = await importOriginal<typeof WorkflowEngine>();
  return {
    ...real,
    getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  };
});

const { assertRecordWorkflowAccess } =
  await import("./assert-record-workflow-access.js");

const PARENT_ID = "parent-1";
const TENANT_ID = "tenant-aaa";

function fakeTx(row: Record<string, unknown> | undefined) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  } as never;
}

describe("assertRecordWorkflowAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows the record's creator even when not a workflow admin", async () => {
    const tx = fakeTx({
      id: PARENT_ID,
      workflowId: "wf-1",
      createdBy: "user-creator",
      assignedTo: null,
    });

    await expect(
      assertRecordWorkflowAccess(tx, TENANT_ID, PARENT_ID, {
        userId: "user-creator",
        isGlobalAdmin: false,
      }),
    ).resolves.toBeUndefined();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it("allows the record's assignee even when not a workflow admin", async () => {
    const tx = fakeTx({
      id: PARENT_ID,
      workflowId: "wf-1",
      createdBy: "someone-else",
      assignedTo: "user-assignee",
    });

    await expect(
      assertRecordWorkflowAccess(tx, TENANT_ID, PARENT_ID, {
        userId: "user-assignee",
        isGlobalAdmin: false,
      }),
    ).resolves.toBeUndefined();
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });

  it("allows a workflow admin who is neither creator nor assignee of the record", async () => {
    const tx = fakeTx({
      id: PARENT_ID,
      workflowId: "wf-1",
      createdBy: "someone-else",
      assignedTo: "another-person",
    });
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      createdBy: "user-wfadmin",
      assignedTo: [],
    });

    await expect(
      assertRecordWorkflowAccess(tx, TENANT_ID, PARENT_ID, {
        userId: "user-wfadmin",
        isGlobalAdmin: false,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a caller who is neither creator/assignee nor workflow admin", async () => {
    const tx = fakeTx({
      id: PARENT_ID,
      workflowId: "wf-1",
      createdBy: "someone-else",
      assignedTo: "another-person",
    });
    mockGetWorkflow.mockResolvedValue({
      id: "wf-1",
      createdBy: "yet-another-person",
      assignedTo: [],
    });

    await expect(
      assertRecordWorkflowAccess(tx, TENANT_ID, PARENT_ID, {
        userId: "plain-user",
        isGlobalAdmin: false,
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });

  it("rejects when the record doesn't exist (or belongs to another tenant)", async () => {
    const tx = fakeTx(undefined);

    await expect(
      assertRecordWorkflowAccess(tx, TENANT_ID, PARENT_ID, {
        userId: "plain-user",
        isGlobalAdmin: false,
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });

  it("rejects a non-owning caller when the record has no workflow to be admin of", async () => {
    const tx = fakeTx({
      id: PARENT_ID,
      workflowId: null,
      createdBy: "someone-else",
      assignedTo: null,
    });

    await expect(
      assertRecordWorkflowAccess(tx, TENANT_ID, PARENT_ID, {
        userId: "plain-user",
        isGlobalAdmin: false,
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});
