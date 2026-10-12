import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { TenantView } from "./format.js";

vi.mock("./sandbox-row-actions.js", () => ({
  SandboxRowActions: (props: { tenantName: string }) => (
    <button type="button">Actions for {props.tenantName}</button>
  ),
}));

const { TenantsTable } = await import("./tenants-table.js");

const TENANTS: TenantView[] = [
  {
    id: "aaaaaaaa-0000-4000-a000-000000000001",
    name: "Bravo Sandbox",
    isSandbox: true,
    createdAt: "2026-10-10T00:00:00Z",
    trialStatus: "active",
  },
  {
    id: "bbbbbbbb-0000-4000-b000-000000000002",
    name: "Alpha Customer",
    isSandbox: false,
    createdAt: "2026-01-01T00:00:00Z",
    trialStatus: "none",
  },
  {
    id: "cccccccc-0000-4000-c000-000000000003",
    name: "Charlie Sandbox",
    isSandbox: true,
    createdAt: "2026-09-01T00:00:00Z",
    trialStatus: "expired",
  },
];

function rowNames(): string[] {
  return Array.from(document.querySelectorAll("tbody .pa-name")).map(
    (el) => el.textContent,
  );
}

function setup(
  onSelect = vi.fn(),
  onActionDone = vi.fn(),
): {
  onSelect: ReturnType<typeof vi.fn>;
  onActionDone: ReturnType<typeof vi.fn>;
} {
  render(
    <TenantsTable
      tenants={TENANTS}
      onSelect={onSelect}
      onActionDone={onActionDone}
    />,
  );
  return { onSelect, onActionDone };
}

describe("TenantsTable", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists every tenant newest first by default", () => {
    setup();
    expect(rowNames()).toEqual([
      "Bravo Sandbox",
      "Charlie Sandbox",
      "Alpha Customer",
    ]);
  });

  it("labels each tenant's type and trial status", () => {
    setup();
    const badge = { selector: "span.badge" };
    expect(screen.getAllByText("Sandbox", badge)).toHaveLength(2);
    expect(screen.getByText("Customer", badge)).toBeTruthy();
    expect(screen.getByText("Trial active", badge)).toBeTruthy();
    expect(screen.getByText("Trial expired", badge)).toBeTruthy();
    expect(screen.getByText("No trial", badge)).toBeTruthy();
  });

  it("renders lifecycle actions only for sandboxes", () => {
    setup();
    expect(screen.getByText("Actions for Bravo Sandbox")).toBeTruthy();
    expect(screen.getByText("Actions for Charlie Sandbox")).toBeTruthy();
    expect(screen.queryByText("Actions for Alpha Customer")).toBeNull();
  });

  it("searches by name", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Search tenants"), {
      target: { value: "alpha" },
    });
    expect(rowNames()).toEqual(["Alpha Customer"]);
  });

  it("searches by id prefix", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Search tenants"), {
      target: { value: "cccccccc" },
    });
    expect(rowNames()).toEqual(["Charlie Sandbox"]);
  });

  it("filters by type", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Filter by type"), {
      target: { value: "customer" },
    });
    expect(rowNames()).toEqual(["Alpha Customer"]);
  });

  it("filters by trial status", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Filter by trial status"), {
      target: { value: "expired" },
    });
    expect(rowNames()).toEqual(["Charlie Sandbox"]);
  });

  it("shows a no-match message when filters exclude everything", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Search tenants"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No tenants match these filters.")).toBeTruthy();
  });

  it("sorts by name, toggling direction on a second click", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(rowNames()).toEqual([
      "Alpha Customer",
      "Bravo Sandbox",
      "Charlie Sandbox",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(rowNames()).toEqual([
      "Charlie Sandbox",
      "Bravo Sandbox",
      "Alpha Customer",
    ]);
  });

  it("selects a tenant on row click but not when its actions are clicked", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByText("Alpha Customer"));
    expect(onSelect).toHaveBeenCalledWith(TENANTS[1]);

    onSelect.mockClear();
    fireEvent.click(screen.getByText("Actions for Bravo Sandbox"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
