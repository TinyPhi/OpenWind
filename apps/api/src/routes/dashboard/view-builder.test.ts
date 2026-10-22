import { describe, it, expect, vi } from "vitest";

vi.mock("@platform/db", () => ({
  withTenantContext: vi.fn(),
  entityInstances: {},
  entityTypes: {},
  workflows: {},
  workflowStates: {},
}));
vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  inArray: vi.fn(),
  and: vi.fn(),
}));

const { buildTeamMembersSection, buildTicketsSection, deriveTitle } =
  await import("./view-builder.js");

const NOW = new Date("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;

function row(
  id: string,
  assignedTo: string | null,
  dueDate: Date | null,
): Parameters<typeof buildTeamMembersSection>[0][number] {
  return {
    id,
    workflowId: null,
    entityTypeId: "et-1",
    currentState: "open",
    fields: { title: `Ticket ${id}` },
    dueDate,
    updatedAt: NOW,
    assignedTo,
  };
}

describe("buildTeamMembersSection", () => {
  it("counts tickets assigned to each member and how many of those are overdue", () => {
    const rows = [
      row("a", "u1", new Date(NOW.getTime() - HOUR)), // overdue
      row("b", "u1", new Date(NOW.getTime() + HOUR)), // not overdue
      row("c", "u1", null), // no due date is never overdue
      row("d", "u2", new Date(NOW.getTime() - HOUR)),
      row("e", "outside", new Date(NOW.getTime() - HOUR)),
      row("f", null, null),
    ];

    expect(buildTeamMembersSection(rows, ["u1", "u2", "u3"], NOW)).toEqual([
      { userId: "u1", ticketCount: 3, overdueCount: 1 },
      { userId: "u2", ticketCount: 1, overdueCount: 1 },
      { userId: "u3", ticketCount: 0, overdueCount: 0 },
    ]);
  });

  it("returns no rows for no members", () => {
    expect(buildTeamMembersSection([row("a", "u1", null)], [], NOW)).toEqual(
      [],
    );
  });
});

describe("buildTicketsSection assignee", () => {
  const rows = [row("a", "u1", null)];

  it("leaves assignedTo off by default so My View's response is unchanged", () => {
    const section = buildTicketsSection(
      rows,
      new Map(),
      new Map(),
      new Map(),
      NOW,
    );
    expect(section.items[0]).not.toHaveProperty("assignedTo");
  });

  it("includes assignedTo when the org views ask for it", () => {
    const section = buildTicketsSection(
      rows,
      new Map(),
      new Map(),
      new Map(),
      NOW,
      { includeAssignee: true },
    );
    expect(section.items[0]).toMatchObject({ assignedTo: "u1" });
  });
});

describe("deriveTitle", () => {
  it("falls back to a short id when no title-like field is set", () => {
    expect(deriveTitle({}, "12345678-aaaa")).toBe("Ticket 12345678");
  });
});
