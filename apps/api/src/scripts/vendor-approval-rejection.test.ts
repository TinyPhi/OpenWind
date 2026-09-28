import { describe, it, expect } from "vitest";
import { rejectionStageFor, REJECTORS } from "./vendor-approval-rejection.js";

describe("rejectionStageFor", () => {
  it("keeps advancing when the fixture isn't a rejection", () => {
    expect(
      rejectionStageFor("it_security_review", "approved", "it_security_review"),
    ).toBeNull();
  });

  it("keeps advancing from draft and before the rejectAt stage", () => {
    expect(rejectionStageFor("draft", "rejected", "legal_review")).toBeNull();
    expect(
      rejectionStageFor("it_security_review", "rejected", "legal_review"),
    ).toBeNull();
  });

  it("rejects at the rejectAt stage", () => {
    expect(rejectionStageFor("legal_review", "rejected", "legal_review")).toBe(
      "legal_review",
    );
  });

  it("rejects at the current stage when a resumed vendor is already past rejectAt", () => {
    expect(
      rejectionStageFor("legal_review", "rejected", "it_security_review"),
    ).toBe("legal_review");
    expect(
      rejectionStageFor(
        "pending_final_approval",
        "rejected",
        "it_security_review",
      ),
    ).toBe("pending_final_approval");
  });

  it("does nothing once the vendor is terminal", () => {
    expect(
      rejectionStageFor("approved", "rejected", "it_security_review"),
    ).toBeNull();
  });

  it("has a department rejector for every review stage", () => {
    expect(Object.keys(REJECTORS).sort()).toEqual([
      "it_security_review",
      "legal_review",
      "pending_final_approval",
    ]);
  });
});
