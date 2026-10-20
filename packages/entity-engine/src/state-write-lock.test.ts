import { describe, it, expect, vi } from "vitest";
import type { DbOrTx } from "@platform/db";
import {
  lockedWorkflowIds,
  childStateWriteReachesLockedStep,
} from "./state-write-lock.js";

function fakeDb(rows: Array<{ id: string }>): {
  db: DbOrTx;
  select: ReturnType<typeof vi.fn>;
} {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  // Only the select().from().where() chain is exercised; the rest of DbOrTx is not reached.
  return { db: { select } as unknown as DbOrTx, select };
}

describe("state-write-lock", () => {
  it("lockedWorkflowIds returns an empty set without querying for no ids", async () => {
    const { db, select } = fakeDb([]);
    expect((await lockedWorkflowIds(db, "t1", [])).size).toBe(0);
    expect(select).not.toHaveBeenCalled();
  });

  it("lockedWorkflowIds returns the ids the query matched", async () => {
    const { db } = fakeDb([{ id: "wf-1" }]);
    expect(await lockedWorkflowIds(db, "t1", ["wf-1", "wf-2"])).toEqual(
      new Set(["wf-1"]),
    );
  });

  it("childStateWriteReachesLockedStep answers from a single query", async () => {
    const hit = fakeDb([{ id: "wf-1" }]);
    expect(
      await childStateWriteReachesLockedStep(hit.db, "t1", "wf-1", "closed"),
    ).toBe(true);
    expect(hit.select).toHaveBeenCalledTimes(1);

    const miss = fakeDb([]);
    expect(
      await childStateWriteReachesLockedStep(miss.db, "t1", "wf-1", "open"),
    ).toBe(false);
    expect(miss.select).toHaveBeenCalledTimes(1);
  });
});
