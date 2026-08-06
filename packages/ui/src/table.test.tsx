import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./table.js";
import { TOKENS } from "./tokens.js";

afterEach(() => {
  cleanup();
});

function renderTable(
  rowProps: Record<string, unknown> = {},
): ReturnType<typeof render> {
  return render(
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow {...rowProps}>
          <TableCell>Alice</TableCell>
          <TableCell>Active</TableCell>
        </TableRow>
      </TableBody>
    </Table>,
  );
}

describe("Table", () => {
  it("renders a real table with header and body rows", () => {
    renderTable();
    expect(screen.getByRole("table").tagName).toBe("TABLE");
    expect(screen.getByRole("columnheader", { name: "Name" }).tagName).toBe(
      "TH",
    );
    expect(screen.getByRole("cell", { name: "Alice" }).tagName).toBe("TD");
  });

  it("wraps the table in a horizontally-scrollable container by default", () => {
    const { container } = renderTable();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.style.overflowX).toBe("auto");
    expect(wrapper.querySelector("table")).not.toBeNull();
  });

  it("skips the scroll wrapper when scroll is false", () => {
    const { container } = render(
      <Table scroll={false}>
        <TableBody>
          <TableRow>
            <TableCell>Alice</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(container.firstElementChild?.tagName).toBe("TABLE");
  });

  it("applies header cell styling", () => {
    renderTable();
    const th = screen.getByRole("columnheader", { name: "Name" });
    expect(th.style.textTransform).toBe("uppercase");
    expect(th.style.fontWeight).toBe("600");
  });

  it("does not apply clickable styling by default", () => {
    renderTable();
    const row = screen.getByRole("cell", { name: "Alice" })
      .parentElement as HTMLTableRowElement;
    expect(row.style.cursor).not.toBe("pointer");
  });

  it("applies hover background on a clickable row and clears it on mouse leave", () => {
    renderTable({ clickable: true });
    const row = screen.getByRole("cell", { name: "Alice" })
      .parentElement as HTMLTableRowElement;
    expect(row.style.cursor).toBe("pointer");

    fireEvent.mouseEnter(row);
    expect(row.style.backgroundColor).toBe(TOKENS.bgTertiary);

    fireEvent.mouseLeave(row);
    expect(row.style.backgroundColor).toBe("");
  });

  it("forwards a ref to the underlying table element", () => {
    const ref = { current: null as HTMLTableElement | null };
    render(
      <Table ref={ref}>
        <TableBody>
          <TableRow>
            <TableCell>Alice</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(ref.current).toBeInstanceOf(HTMLTableElement);
  });

  it("spreads unknown DOM props like onClick through TableRow", () => {
    let clicked = false;
    render(
      <Table>
        <TableBody>
          <TableRow onClick={() => (clicked = true)}>
            <TableCell>Alice</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cell = screen.getByRole("cell", { name: "Alice" });
    if (!cell.parentElement) throw new Error("expected a parent <tr>");
    fireEvent.click(cell.parentElement);
    expect(clicked).toBe(true);
  });
});
