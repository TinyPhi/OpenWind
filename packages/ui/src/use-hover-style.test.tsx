import type * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useHoverStyle } from "./use-hover-style.js";

afterEach(() => {
  cleanup();
});

function TestTarget(): React.ReactElement {
  const hoverProps = useHoverStyle({
    base: { color: "red" },
    hover: { color: "blue" },
  });
  return <span data-testid="target" {...hoverProps} />;
}

function AsymmetricTarget(): React.ReactElement {
  // Mirrors users.tsx's icon-link: background unsets to "" on leave, color
  // reverts to an explicit value instead — the two properties aren't both
  // "unset" on leave.
  const hoverProps = useHoverStyle({
    base: { background: "", color: "red" },
    hover: { background: "yellow" },
  });
  return <span data-testid="target" {...hoverProps} />;
}

describe("useHoverStyle", () => {
  it("starts at the base style", () => {
    render(<TestTarget />);
    expect(screen.getByTestId("target").style.color).toBe("red");
  });

  it("merges hover into style on mouse enter", () => {
    render(<TestTarget />);
    const target = screen.getByTestId("target");
    fireEvent.mouseEnter(target);
    expect(target.style.color).toBe("blue");
  });

  it("reverts to the base style on mouse leave", () => {
    render(<TestTarget />);
    const target = screen.getByTestId("target");
    fireEvent.mouseEnter(target);
    fireEvent.mouseLeave(target);
    expect(target.style.color).toBe("red");
  });

  it("only overrides the keys hover specifies, leaving other base keys untouched", () => {
    render(<AsymmetricTarget />);
    const target = screen.getByTestId("target");
    fireEvent.mouseEnter(target);
    expect(target.style.background).toBe("yellow");
    expect(target.style.color).toBe("red");
  });
});
