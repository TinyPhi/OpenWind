import { describe, it, expect } from "vitest";
import type { DbOrTx } from "@platform/db";
import { assertWorkflowMatchesType } from "./mandatory-refs.js";
import { ValidationError } from "./errors.js";

describe("assertWorkflowMatchesType", () => {
  it("rejects a malformed workflow id as such, without a query", async () => {
    // A malformed id must fail before any query; an empty object proves none runs.
    const db = {} as DbOrTx;
    let thrown: unknown;
    try {
      await assertWorkflowMatchesType(
        db,
        "t-1",
        "395069484982861826",
        "11111111-1111-4111-8111-111111111111",
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).fields).toEqual([
      {
        field: "workflowId",
        code: "invalid",
        message: "Not a valid workflow id",
      },
    ]);
  });
});
