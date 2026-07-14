import { describe, it, expect } from "vitest";
import { isWorkflowAdmin, isWorkflowAdminListEditor } from "./authorization.js";

const CREATOR = "user-creator";
const ASSIGNEE = "user-assignee";
const OUTSIDER = "user-outsider";

describe("isWorkflowAdmin", () => {
  it("is true for the creator", () => {
    expect(
      isWorkflowAdmin(CREATOR, { createdBy: CREATOR, assignedTo: [CREATOR] }),
    ).toBe(true);
  });

  it("is true for a non-creator assignee", () => {
    expect(
      isWorkflowAdmin(ASSIGNEE, {
        createdBy: CREATOR,
        assignedTo: [CREATOR, ASSIGNEE],
      }),
    ).toBe(true);
  });

  it("is false for a user who is neither creator nor assignee", () => {
    expect(
      isWorkflowAdmin(OUTSIDER, {
        createdBy: CREATOR,
        assignedTo: [CREATOR, ASSIGNEE],
      }),
    ).toBe(false);
  });

  it("is true for the creator even if assignedTo somehow omits them", () => {
    expect(
      isWorkflowAdmin(CREATOR, { createdBy: CREATOR, assignedTo: [] }),
    ).toBe(true);
  });

  it("is false when createdBy is null and user is not assigned", () => {
    expect(isWorkflowAdmin(OUTSIDER, { createdBy: null, assignedTo: [] })).toBe(
      false,
    );
  });
});

describe("isWorkflowAdminListEditor", () => {
  it("is true only for the creator", () => {
    expect(isWorkflowAdminListEditor(CREATOR, { createdBy: CREATOR })).toBe(
      true,
    );
  });

  it("is false for a non-creator assignee", () => {
    expect(isWorkflowAdminListEditor(ASSIGNEE, { createdBy: CREATOR })).toBe(
      false,
    );
  });

  it("is false when createdBy is null", () => {
    expect(isWorkflowAdminListEditor(OUTSIDER, { createdBy: null })).toBe(
      false,
    );
  });
});
