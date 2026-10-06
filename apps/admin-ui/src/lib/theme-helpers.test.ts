import { describe, it, expect } from "vitest";
import { withAlpha, avatarColor } from "./theme.js";

describe("theme color helpers", () => {
  it("applies alpha transparency to an hsl color string", () => {
    expect(withAlpha("hsl(210, 14%, 55%)", 0.14)).toBe(
      "hsla(210, 14%, 55%, 0.14)",
    );
    expect(withAlpha("hsl(0, 72%, 51%)", 0.5)).toBe("hsla(0, 72%, 51%, 0.5)");
  });

  it("generates deterministic avatar colors from input string", () => {
    const color1 = avatarColor("user_123");
    const color2 = avatarColor("user_123");
    expect(color1).toBe(color2);
    expect(color1).toMatch(/^hsl\(\d+, 60%, 45%\)$/);

    const color3 = avatarColor("admin_999");
    expect(color3).toMatch(/^hsl\(\d+, 60%, 45%\)$/);
  });
});
