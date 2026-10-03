import { describe, it, expect, vi } from "vitest";

// wizard.tsx imports lib/api which accesses window.__CONFIG__ at module load time.
// Mock it so pure-function tests run in a node environment without a browser.
vi.mock("../../../lib/api.js", () => ({ fetchWithAuth: vi.fn(), API_URL: "" }));
vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(),
  useParams: vi.fn(() => ({})),
}));

import { canAdvance } from "./wizard.js";
import type { WizardData } from "./types.js";

const base: WizardData = {
  triggerType: "",
  triggerConfig: {},
  conditions: null,
  actions: [],
  name: "",
  priority: 0,
  isEnabled: true,
};

describe("canAdvance", () => {
  describe("trigger step", () => {
    it("blocks advance when triggerType is empty", () => {
      expect(canAdvance("trigger", { ...base, triggerType: "" })).toBe(false);
    });

    it("blocks a field-changed trigger until an entity type is chosen; the field is optional", () => {
      const fieldChanged = { ...base, triggerType: "field.changed" as const };
      expect(canAdvance("trigger", fieldChanged)).toBe(false);
      expect(
        canAdvance("trigger", {
          ...fieldChanged,
          triggerConfig: { entityTypeId: "et-1" },
        }),
      ).toBe(true);
    });

    it("allows advance when triggerType is set", () => {
      expect(
        canAdvance("trigger", { ...base, triggerType: "entity.created" }),
      ).toBe(true);
    });
  });

  describe("conditions step", () => {
    it("always allows advance (conditions are optional)", () => {
      expect(canAdvance("conditions", base)).toBe(true);
      expect(
        canAdvance("conditions", {
          ...base,
          conditions: { op: "and", children: [] },
        }),
      ).toBe(true);
    });
  });

  describe("actions step", () => {
    it("blocks advance when no actions are configured", () => {
      expect(canAdvance("actions", { ...base, actions: [] })).toBe(false);
    });

    it("allows advance when at least one action exists", () => {
      expect(
        canAdvance("actions", {
          ...base,
          actions: [{ id: "1", type: "notify", config: {} }],
        }),
      ).toBe(true);
    });
  });

  describe("save step", () => {
    it("blocks advance when name is blank", () => {
      expect(canAdvance("save", { ...base, name: "" })).toBe(false);
      expect(canAdvance("save", { ...base, name: "   " })).toBe(false);
    });

    it("allows advance when name has non-whitespace content", () => {
      expect(canAdvance("save", { ...base, name: "My rule" })).toBe(true);
    });
  });
});
