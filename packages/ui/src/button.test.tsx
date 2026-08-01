import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Button } from "./button.js";

afterEach(() => {
  cleanup();
});

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
});
