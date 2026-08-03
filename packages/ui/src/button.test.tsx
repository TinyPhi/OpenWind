import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button } from "./button.js";
import { TOKENS } from "./tokens.js";

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

describe("Button", () => {
  it("renders children and defaults to the secondary variant", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.style.background).toBe(
      "var(--bg-elevated, hsl(222, 15%, 22%))",
    );
  });

  it("renders the primary variant's gradient background", () => {
    render(<Button variant="primary">Create</Button>);
    const button = screen.getByRole("button", { name: "Create" });
    expect(button.style.color).toBe("white");
    expect(button.style.borderStyle).toBe("none");
  });

  it("renders the danger variant's colors", () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole("button", { name: "Delete" });
    expect(button.style.color).toBe("var(--danger, hsl(350, 80%, 60%))");
  });

  it("applies the sm size's smaller padding", () => {
    render(<Button size="sm">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.style.padding).toBe("5px 12px");
  });

  it("applies the default size's padding", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.style.padding).toBe("8px 16px");
  });

  it("uses the shared radius-sm token for its border radius (regression: this fallback drifted to 8px here while every other caller and index.css's actual token used 6px)", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.style.borderRadius).toBe(TOKENS.radiusSm);
  });

  it("applies the disabled visual treatment and disables the element", () => {
    render(<Button disabled>Save</Button>);
    const button = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.style.opacity).toBe("0.5");
    expect(button.style.cursor).toBe("not-allowed");
  });

  it("applies hover styling on mouse enter and clears it on mouse leave", () => {
    render(<Button variant="secondary">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });

    fireEvent.mouseEnter(button);
    expect(button.style.color).toBe(
      "var(--accent-primary, hsl(250, 84%, 66%))",
    );

    fireEvent.mouseLeave(button);
    expect(button.style.color).toBe(
      "var(--text-secondary, hsl(222, 10%, 75%))",
    );
  });

  it("applies hover styling for the primary variant", () => {
    render(<Button variant="primary">Create</Button>);
    const button = screen.getByRole("button", { name: "Create" });

    fireEvent.mouseEnter(button);
    expect(button.style.transform).toBe("translateY(-1px)");

    fireEvent.mouseLeave(button);
    expect(button.style.transform).toBe("");
  });

  it("applies hover styling for the danger variant", () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole("button", { name: "Delete" });

    fireEvent.mouseEnter(button);
    expect(button.style.background).toBe(
      normalizedColor("backgroundColor", "hsla(350, 80%, 60%, 0.2)"),
    );

    fireEvent.mouseLeave(button);
    expect(button.style.background).toBe(
      normalizedColor("backgroundColor", "hsla(350, 80%, 60%, 0.1)"),
    );
  });

  it("applies a focus ring on focus and clears it on blur", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });

    fireEvent.focus(button);
    expect(button.style.boxShadow).toBe(
      "0 0 0 3px var(--border-focus, hsla(250, 84%, 66%, 0.35))",
    );

    fireEvent.blur(button);
    expect(button.style.boxShadow).toBe("");
  });

  it("does not apply hover styling while disabled", () => {
    render(
      <Button variant="secondary" disabled>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });

    fireEvent.mouseEnter(button);
    expect(button.style.color).not.toBe(
      "var(--accent-primary, hsl(250, 84%, 66%))",
    );
  });

  it("forwards a ref to the underlying button element", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("spreads unknown DOM props like onClick and type", () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(button.type).toBe("submit");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the child's own tag instead of a <button> when asChild is set", () => {
    render(
      <Button asChild>
        <a href="/workflows">Back</a>
      </Button>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    const link = screen.getByRole("link", {
      name: "Back",
    }) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/workflows");
  });

  it("merges Button's variant styling onto the asChild element", () => {
    render(
      <Button asChild variant="primary">
        <a href="/workflows">Back</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Back" });
    expect(link.style.color).toBe("white");
  });

  it("forwards the child's own props (e.g. onClick) when asChild is set", () => {
    const onClick = vi.fn();
    render(
      <Button asChild>
        <a href="/workflows" onClick={onClick}>
          Back
        </a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Back" });
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("blocks pointer interaction on a disabled asChild element, since the disabled attribute does nothing on a non-button tag", () => {
    render(
      <Button asChild disabled>
        <a href="/workflows">Back</a>
      </Button>,
    );
    const link = screen.getByRole("link", {
      name: "Back",
    }) as HTMLAnchorElement;
    expect(link.style.opacity).toBe("0.5");
    // The actual click-blocker: Radix Slot always runs a child's own click
    // handler (e.g. a router <Link>'s internal navigate) before Button's, so
    // pointer-events is what stops a disabled asChild link from being
    // clickable in a real browser — a JS onClick guard alone cannot.
    expect(link.style.pointerEvents).toBe("none");
    expect(link.getAttribute("aria-disabled")).toBe("true");
  });

  it("never invokes Button's own onClick when disabled, asChild or not", () => {
    const onClick = vi.fn();
    render(
      <Button asChild disabled onClick={onClick}>
        <a href="/workflows">Back</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Back" });
    fireEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });
});
