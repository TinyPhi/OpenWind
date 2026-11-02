import "../../i18n.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { SandboxView } from "./format.js";

vi.mock("./sandbox-row-actions.js", () => ({
  SandboxRowActions: (props: { tenantName: string }) => (
    <button type="button">Actions for {props.tenantName}</button>
  ),
}));

const { SandboxesTable } = await import("./sandboxes-table.js");

const DAY = 86_400_000;
const SANDBOXES: SandboxView[] = [
  {
    id: "aaaaaaaa-0000-4000-a000-000000000001",
    name: "Bravo Sandbox",
    isSandbox: true,
    createdAt: "2026-10-10T00:00:00Z",
    trialStatus: "active",
    trialEndsAt: new Date(Date.now() + 5 * DAY + 3_600_000).toISOString(),
    logo: null,
  },
  {
    id: "bbbbbbbb-0000-4000-b000-000000000002",
    name: "Alpha Sandbox",
    isSandbox: true,
    createdAt: "2026-01-01T00:00:00Z",
    trialStatus: "none",
    trialEndsAt: null,
    logo: null,
  },
  {
    id: "cccccccc-0000-4000-c000-000000000003",
    name: "Charlie Sandbox",
    isSandbox: true,
    createdAt: "2026-09-01T00:00:00Z",
    trialStatus: "expired",
    trialEndsAt: new Date(Date.now() - 2 * DAY - 3_600_000).toISOString(),
    logo: null,
  },
];

function rowNames(): (string | null)[] {
  return Array.from(document.querySelectorAll("tbody .pa-name")).map(
    (el) => el.textContent,
  );
}

function setup(onSelect = vi.fn()): {
  onSelect: ReturnType<typeof vi.fn>;
} {
  render(
    <SandboxesTable
      sandboxes={SANDBOXES}
      onSelect={onSelect}
      onActionDone={vi.fn()}
    />,
  );
  return { onSelect };
}

describe("SandboxesTable", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists every sandbox newest first by default", () => {
    setup();
    expect(rowNames()).toEqual([
      "Bravo Sandbox",
      "Charlie Sandbox",
      "Alpha Sandbox",
    ]);
  });

  it("shows each trial's status badge and countdown", () => {
    setup();
    const badge = { selector: "span.badge" };
    expect(screen.getByText("Trial active", badge)).toBeTruthy();
    expect(screen.getByText("Trial expired", badge)).toBeTruthy();
    expect(screen.getByText("No trial", badge)).toBeTruthy();
    expect(screen.getByText("5 days left")).toBeTruthy();
    expect(screen.getByText("Expired 2 days ago")).toBeTruthy();
  });

  it("gives every row an actions menu", () => {
    setup();
    expect(screen.getByText("Actions for Bravo Sandbox")).toBeTruthy();
    expect(screen.getByText("Actions for Alpha Sandbox")).toBeTruthy();
    expect(screen.getByText("Actions for Charlie Sandbox")).toBeTruthy();
  });

  it("searches by name and by id prefix", () => {
    setup();
    const search = screen.getByLabelText("Search sandboxes");
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(rowNames()).toEqual(["Alpha Sandbox"]);
    fireEvent.change(search, { target: { value: "cccccccc" } });
    expect(rowNames()).toEqual(["Charlie Sandbox"]);
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
    fireEvent.change(screen.getByLabelText("Search sandboxes"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No sandboxes match these filters.")).toBeTruthy();
  });

  it("sorts by name, toggling direction on a second click", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(rowNames()).toEqual([
      "Alpha Sandbox",
      "Bravo Sandbox",
      "Charlie Sandbox",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(rowNames()).toEqual([
      "Charlie Sandbox",
      "Bravo Sandbox",
      "Alpha Sandbox",
    ]);
  });

  it("sorts by trial end, soonest first, with no-trial sandboxes last", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Trial/ }));
    expect(rowNames()).toEqual([
      "Charlie Sandbox",
      "Bravo Sandbox",
      "Alpha Sandbox",
    ]);
  });

  it("selects a sandbox on row click but not when its actions are clicked", () => {
    const { onSelect } = setup();
    fireEvent.click(screen.getByText("Alpha Sandbox"));
    expect(onSelect).toHaveBeenCalledWith(SANDBOXES[1]);

    onSelect.mockClear();
    fireEvent.click(screen.getByText("Actions for Bravo Sandbox"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
