import { describe, it, expect, vi, afterEach } from "vitest";
import {
  humanizeWorkflowName,
  relativeTime,
  toWorkflowSlug,
  singularize,
  initials,
  formatFieldValue,
} from "./format.js";

describe("format utilities", () => {
  describe("humanizeWorkflowName", () => {
    it("preserves names without underscore or hyphen", () => {
      expect(humanizeWorkflowName("Customer Support")).toBe("Customer Support");
    });

    it("humanizes underscore and hyphenated workflow identifiers", () => {
      expect(humanizeWorkflowName("sales_pipeline_workflow")).toBe(
        "Sales Pipeline",
      );
      expect(humanizeWorkflowName("incident-response-workflow")).toBe(
        "Incident Response",
      );
    });
  });

  describe("relativeTime", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("formats relative timestamps correctly", () => {
      const now = new Date("2026-10-03T12:00:00Z").getTime();
      vi.spyOn(Date, "now").mockReturnValue(now);

      expect(relativeTime(new Date(now - 30_000).toISOString())).toBe(
        "just now",
      );
      expect(relativeTime(new Date(now - 5 * 60_000).toISOString())).toBe(
        "5m ago",
      );
      expect(relativeTime(new Date(now - 3 * 3600_000).toISOString())).toBe(
        "3h ago",
      );
      expect(relativeTime(new Date(now - 2 * 86400_000).toISOString())).toBe(
        "2d ago",
      );
    });
  });

  describe("toWorkflowSlug", () => {
    it("converts strings to url-friendly workflow slugs", () => {
      expect(toWorkflowSlug("Sales Pipeline")).toBe("sales-pipeline");
      expect(toWorkflowSlug("Customer Support Workflow #42")).toBe(
        "customer-support-workflow-42",
      );
      expect(toWorkflowSlug("")).toBe("");
    });

    it("keeps the exact algorithm the API's my-tickets route uses (whitespace -> '-', drop other symbols)", () => {
      expect(toWorkflowSlug("Leave & Approval")).toBe("leave--approval");
      expect(toWorkflowSlug("Sales  Pipeline")).toBe("sales-pipeline");
      expect(toWorkflowSlug("--Special & Characters--")).toBe(
        "--special--characters--",
      );
    });
  });

  describe("singularize", () => {
    it("transforms ies endings to y", () => {
      expect(singularize("categories")).toBe("category");
      expect(singularize("Companies")).toBe("Company");
    });

    it("removes trailing s for regular plurals", () => {
      expect(singularize("tickets")).toBe("ticket");
      expect(singularize("NSI Amendment Requests")).toBe(
        "NSI Amendment Request",
      );
    });

    it("returns unchanged word if not matching plural rules", () => {
      expect(singularize("staff")).toBe("staff");
      expect(singularize("data")).toBe("data");
    });
  });

  describe("initials", () => {
    it("extracts up to two uppercase initials", () => {
      expect(initials("John Doe")).toBe("JD");
      expect(initials("Alice")).toBe("A");
      expect(initials("Alice Bob Charlie")).toBe("AB");
      expect(initials("  alice   smith  ")).toBe("AS");
      expect(initials("")).toBe("");
    });
  });

  describe("formatFieldValue", () => {
    it("returns an em dash for null or undefined", () => {
      expect(formatFieldValue(null)).toBe("—");
      expect(formatFieldValue(undefined)).toBe("—");
    });

    it("formats currency object values", () => {
      expect(formatFieldValue({ amount: 1500, currency: "USD" })).toBe(
        "USD 1500",
      );
    });

    it("serializes generic objects as JSON", () => {
      expect(formatFieldValue({ foo: "bar" })).toBe('{"foo":"bar"}');
    });

    it("formats primitive values as strings", () => {
      expect(formatFieldValue("In Progress")).toBe("In Progress");
      expect(formatFieldValue(42)).toBe("42");
      expect(formatFieldValue(true)).toBe("true");
    });

    it("resolves single and multiple file attachment names", () => {
      const attachments = [
        { id: "file-1", originalName: "proposal.pdf" },
        { id: "file-2", originalName: "spec.png" },
      ];

      expect(formatFieldValue("file-1", "file", attachments)).toBe(
        "proposal.pdf",
      );
      expect(formatFieldValue(["file-1", "file-2"], "files", attachments)).toBe(
        "proposal.pdf, spec.png",
      );
      expect(formatFieldValue("unknown-file", "file", attachments)).toBe(
        "unknown-file",
      );
      expect(formatFieldValue([], "files", attachments)).toBe("—");
    });
  });
});
