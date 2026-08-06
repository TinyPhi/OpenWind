import { describe, it, expect } from "vitest";
import { TOKENS } from "./tokens.js";

describe("TOKENS", () => {
  it("gives every entry a var(--name, fallback) shape", () => {
    for (const [key, value] of Object.entries(TOKENS)) {
      expect(value, `TOKENS.${key}`).toMatch(/^var\(--[a-z-]+, .+\)$/);
    }
  });

  it("pins the radius-sm fallback to 6px, matching index.css's actual token (not the 8px that had drifted into button.tsx)", () => {
    expect(TOKENS.radiusSm).toBe("var(--radius-sm, 6px)");
  });
});
