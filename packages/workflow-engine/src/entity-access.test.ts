import { describe, it, expect } from "vitest";
import {
  hasEntityReadAccess,
  hasEntityCommentAccess,
} from "./entity-access.js";

function instance(fields: unknown = {}) {
  return { createdBy: "creator-1", assignedTo: "assignee-1", fields };
}

describe("hasEntityReadAccess", () => {
  it("grants access to admin/agent regardless of ownership", () => {
    expect(hasEntityReadAccess(instance(), "stranger", ["admin"])).toBe(true);
    expect(hasEntityReadAccess(instance(), "stranger", ["agent"])).toBe(true);
  });

  it("grants access to the creator and assignee", () => {
    expect(hasEntityReadAccess(instance(), "creator-1", [])).toBe(true);
    expect(hasEntityReadAccess(instance(), "assignee-1", [])).toBe(true);
  });

  it.each(["read_only", "read_comment", "read_write"] as const)(
    "grants access to a user with an __accessUsers level of %s",
    (level) => {
      const fields = { __accessUsers: { "user-1": { level } } };
      expect(hasEntityReadAccess(instance(fields), "user-1", [])).toBe(true);
    },
  );

  it("denies a user with no ownership or access-list entry", () => {
    expect(hasEntityReadAccess(instance(), "stranger", [])).toBe(false);
  });

  it("denies a user with an unrecognized access level", () => {
    const fields = { __accessUsers: { "user-1": { level: "bogus" } } };
    expect(hasEntityReadAccess(instance(fields), "user-1", [])).toBe(false);
  });
});

describe("hasEntityCommentAccess", () => {
  it("grants access to admin/agent regardless of ownership", () => {
    expect(hasEntityCommentAccess(instance(), "stranger", ["admin"])).toBe(
      true,
    );
    expect(hasEntityCommentAccess(instance(), "stranger", ["agent"])).toBe(
      true,
    );
  });

  it("grants access to the creator and assignee", () => {
    expect(hasEntityCommentAccess(instance(), "creator-1", [])).toBe(true);
    expect(hasEntityCommentAccess(instance(), "assignee-1", [])).toBe(true);
  });

  it.each(["read_comment", "read_write"] as const)(
    "grants access to a user with an __accessUsers level of %s",
    (level) => {
      const fields = { __accessUsers: { "user-1": { level } } };
      expect(hasEntityCommentAccess(instance(fields), "user-1", [])).toBe(true);
    },
  );

  it("denies a user whose only __accessUsers level is read_only — the stricter-than-read-access case this helper exists for", () => {
    const fields = { __accessUsers: { "user-1": { level: "read_only" } } };
    expect(hasEntityCommentAccess(instance(fields), "user-1", [])).toBe(false);
  });

  it("denies a user with no ownership or access-list entry", () => {
    expect(hasEntityCommentAccess(instance(), "stranger", [])).toBe(false);
  });
});
