import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IconButton } from "./icon-button.js";

afterEach(() => {
  cleanup();
});

/**
 * jsdom normalizes hsl()/hsla() color literals to rgb()/rgba() when read
 * back from a live style declaration — this computes the same normalized
 * form instead of hardcoding jsdom's conversion.
 */
function normalizedColor(
  prop: "color" | "backgroundColor",
  css: string,
): string {
  const el = document.createElement("div");
  el.style[prop] = css;
  return el.style[prop];
}

describe("IconButton", () => {
  it("renders a 30x30 circular button", () => {
    render(<IconButton aria-label="Icon action">✎</IconButton>);
    const button = screen.getByRole("button", { name: "Icon action" });
    expect(button.style.width).toBe("30px");
    expect(button.style.height).toBe("30px");
    expect(button.style.borderRadius).toBe("50%");
  });

  it("renders the edit variant's colors", () => {
    render(
      <IconButton variant="edit" aria-label="Edit">
        ✎
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Edit" });
    expect(button.style.color).toBe(
      normalizedColor("color", "hsl(210, 80%, 65%)"),
    );
  });

  it("renders the delete variant's colors", () => {
    render(
      <IconButton variant="delete" aria-label="Delete">
        🗑
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.style.color).toBe("var(--danger, hsl(350, 80%, 60%))");
  });

  it("renders the ghost variant's colors", () => {
    render(
      <IconButton variant="ghost" aria-label="More">
        ⋯
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "More" });
    expect(button.style.color).toBe("var(--text-muted, hsl(222, 8%, 56%))");
  });

  it("applies hover styling and clears it on mouse leave", () => {
    render(
      <IconButton variant="delete" aria-label="Delete">
        🗑
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Delete" });

    fireEvent.mouseEnter(button);
    expect(button.style.background).toBe(
      normalizedColor("backgroundColor", "hsla(350, 80%, 60%, 0.18)"),
    );

    fireEvent.mouseLeave(button);
    expect(button.style.background).toBe(
      normalizedColor("backgroundColor", "hsla(350, 80%, 60%, 0.08)"),
    );
  });

  it("applies a focus ring on focus and clears it on blur", () => {
    render(<IconButton aria-label="Icon action">✎</IconButton>);
    const button = screen.getByRole("button", { name: "Icon action" });

    fireEvent.focus(button);
    expect(button.style.boxShadow).toBe(
      "0 0 0 3px var(--border-focus, hsla(250, 84%, 66%, 0.35))",
    );

    fireEvent.blur(button);
    expect(button.style.boxShadow).toBe("");
  });

  it("applies an active scale-down on mouse down and clears it on mouse up", () => {
    render(<IconButton aria-label="Icon action">✎</IconButton>);
    const button = screen.getByRole("button", { name: "Icon action" });

    fireEvent.mouseDown(button);
    expect(button.style.transform).toBe("scale(0.88)");

    fireEvent.mouseUp(button);
    expect(button.style.transform).toBe("");
  });

  it("applies the disabled visual treatment, disables interaction styling, and disables the element", () => {
    render(
      <IconButton aria-label="Icon action" disabled>
        ✎
      </IconButton>,
    );
    const button = screen.getByRole("button", {
      name: "Icon action",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.style.opacity).toBe("0.4");
    expect(button.style.pointerEvents).toBe("none");

    fireEvent.mouseEnter(button);
    expect(button.style.background).toBe("transparent");
  });

  it("forwards a ref to the underlying button element", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <IconButton ref={ref} aria-label="Icon action">
        ✎
      </IconButton>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("spreads unknown DOM props like onClick", () => {
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Icon action" onClick={onClick}>
        ✎
      </IconButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Icon action" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
