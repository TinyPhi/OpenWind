/**
 * sandbox-module-data-seed.test.ts
 *
 * Unit tests for seedAllModulesData (docs/specs/multi-org-sandbox.md T9). DB,
 * entity-engine, and workflow-engine are all mocked at the service/package boundary
 * (testing-conventions.md) -- this is not an isolation test against a real Postgres
 * instance.
 *
 * The queries run on the transaction withTenantContext hands in, never plain `db`: on the
 * compose app_user connection RLS rejected the plain-db lookups, so every module's seed
 * failed and sandboxes arrived empty.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const entityTypesTable = { table: "entityTypes" };
const workflowsTable = { table: "workflows" };
const entityFieldsTable = { table: "entityFields" };
const workflowTransitionsTable = { table: "workflowTransitions" };
const outboxEventsTable = {
  table: "outboxEvents",
  tenantId: "outbox.tenantId",
  deliveredAt: "outbox.deliveredAt",
  createdAt: "outbox.createdAt",
};

// Filter helpers return plain descriptions, so a test can read the exact WHERE clause.
vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  isNull: (col: unknown) => ({ isNull: col }),
  gte: (col: unknown, val: unknown) => ({ gte: [col, val] }),
}));

// Query results by table -- set per test.
let entityTypeRows: unknown[] = [];
let workflowRows: unknown[] = [];
let entityFieldRows: unknown[] = [];
let transitionRows: unknown[] = [];

const ROWS = new Map<unknown, () => unknown[]>([
  [entityTypesTable, () => entityTypeRows],
  [workflowsTable, () => workflowRows],
  [entityFieldsTable, () => entityFieldRows],
  [workflowTransitionsTable, () => transitionRows],
]);

// select().from(table).where() resolves to the table's rows, awaited directly or via .limit().
function selectChain(): unknown {
  return {
    from: (table: unknown) => {
      const rows = ROWS.get(table) ?? ((): unknown[] => []);
      return {
        where: () => ({
          limit: () => Promise.resolve(rows()),
          then: (resolve: (v: unknown) => unknown) => resolve(rows()),
        }),
      };
    },
  };
}

const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const TENANT_TX = {
  kind: "tenant-tx",
  select: selectChain,
  update: (table: unknown) => ({
    set: (values: unknown) => {
      mockUpdateSet(table, values);
      return {
        where: (cond: unknown) => {
          mockUpdateWhere(cond);
          return Promise.resolve(undefined);
        },
      };
    },
  }),
};
const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn(TENANT_TX),
);

vi.mock("@platform/db", () => ({
  withTenantContext: (...args: Parameters<typeof mockWithTenantContext>) =>
    mockWithTenantContext(...args),
  entityTypes: entityTypesTable,
  workflows: workflowsTable,
  entityFields: entityFieldsTable,
  workflowTransitions: workflowTransitionsTable,
  outboxEvents: outboxEventsTable,
}));

const mockCreateEntity = vi.fn();
vi.mock("@platform/entity-engine", () => ({
  createEntity: (...args: unknown[]) => mockCreateEntity(...args) as unknown,
}));

const mockExecuteTransition = vi.fn().mockResolvedValue(undefined);
vi.mock("@platform/workflow-engine", () => ({
  executeTransition: (...args: unknown[]) =>
    mockExecuteTransition(...args) as unknown,
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { seedAllModulesData } = await import("./sandbox-module-data-seed.js");

const PROJECT_TRANSITIONS = [
  { id: "t-1", fromState: "backlog", toState: "todo" },
  { id: "t-2", fromState: "todo", toState: "in_progress" },
  { id: "t-3", fromState: "in_progress", toState: "in_review" },
  { id: "t-4", fromState: "in_review", toState: "done" },
];

type CreateInput = {
  fields: Record<string, unknown>;
  dueDate?: string;
  severity?: string;
  assignedTo?: string;
  remark?: string;
};

function createInputs(): CreateInput[] {
  return mockCreateEntity.mock.calls.map((call) => call[2] as CreateInput);
}

beforeEach(() => {
  vi.clearAllMocks();
  entityTypeRows = [{ id: "entity-type-1" }];
  workflowRows = [{ id: "workflow-1" }];
  entityFieldRows = [];
  transitionRows = PROJECT_TRANSITIONS;
  mockCreateEntity.mockImplementation(async () => ({
    id: "entity-x",
    currentState: "backlog",
    fields: {},
  }));
});

describe("seedAllModulesData", () => {
  it("runs every query and write inside the sandbox tenant's context, never plain db", async () => {
    await seedAllModulesData("tenant-1", ["projects"], ["u-1"]);

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "tenant-1",
      expect.any(Function),
    );
    for (const call of mockCreateEntity.mock.calls) {
      expect((call[0] as { kind?: string }).kind).toBe("tenant-tx");
    }
    for (const call of mockExecuteTransition.mock.calls) {
      expect((call[0] as { kind?: string }).kind).toBe("tenant-tx");
    }
  });

  it("gives every record a title, due date, severity, assignee and remark", async () => {
    await seedAllModulesData("tenant-1", ["projects"], ["u-admin", "u-2"]);

    const inputs = createInputs();
    // projects has 5 recordPaths (backlog, todo, in_progress, in_review, done).
    expect(inputs).toHaveLength(5);
    for (const input of inputs) {
      expect(typeof input.fields["title"]).toBe("string");
      expect(String(input.fields["title"])).not.toMatch(/seed/i);
      expect(Date.parse(input.dueDate ?? "")).toBeGreaterThan(Date.now());
      expect(["low", "medium", "high", "critical"]).toContain(input.severity);
      expect(input.remark).toBeTruthy();
    }
    expect(inputs.map((i) => i.assignedTo)).toEqual([
      "u-admin",
      "u-2",
      "u-admin",
      "u-2",
      "u-admin",
    ]);
    expect(new Set(inputs.map((i) => i.fields["title"])).size).toBe(5);
  });

  it("fills the other fields too, but never references or team_id", async () => {
    entityFieldRows = [
      { name: "title", fieldType: "text", config: {} },
      { name: "description", fieldType: "longtext", config: {} },
      {
        name: "priority",
        fieldType: "enum",
        config: { options: [{ value: "low" }, { value: "high" }] },
      },
      { name: "story_points", fieldType: "number", config: {} },
      { name: "parent", fieldType: "entity_ref", config: {} },
      { name: "owner", fieldType: "user_ref", config: {} },
      { name: "team_id", fieldType: "text", config: {} },
    ];

    await seedAllModulesData("tenant-1", ["projects"], ["u-1"]);

    const [first] = createInputs();
    expect(first?.fields).toMatchObject({
      title: "Draft the Q4 roadmap",
      description: expect.any(String),
      priority: "low",
      story_points: expect.any(Number),
    });
    expect(first?.fields).not.toHaveProperty("parent");
    expect(first?.fields).not.toHaveProperty("owner");
    expect(first?.fields).not.toHaveProperty("team_id");
  });

  it("leaves records unassigned when no seeded accounts are given", async () => {
    await seedAllModulesData("tenant-1", ["projects"]);

    for (const input of createInputs()) {
      expect(input).not.toHaveProperty("assignedTo");
    }
  });

  it("drives each record through the right number of real transitions for its target state", async () => {
    await seedAllModulesData("tenant-1", ["projects"], ["u-1"]);

    // projects' longest path (backlog -> todo -> in_progress -> in_review -> done) is 4 hops.
    const doneCall = mockExecuteTransition.mock.calls.find(
      (call) => (call[2] as { transitionId?: string }).transitionId === "t-4",
    );
    expect(doneCall).toBeDefined();
    expect(mockExecuteTransition).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-1",
      expect.objectContaining({
        instanceId: "entity-x",
        actorId: "system",
        actorRoles: expect.arrayContaining(["admin", "agent", "user"]),
        triggeredBy: "system",
      }),
    );
  });

  it("skips a module slug with no seed plan without throwing", async () => {
    await expect(
      seedAllModulesData("tenant-1", ["not-a-real-module"]),
    ).resolves.toBeUndefined();
    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("skips a module whose entity type isn't installed", async () => {
    entityTypeRows = [];

    await seedAllModulesData("tenant-1", ["projects"], ["u-1"]);

    expect(mockCreateEntity).not.toHaveBeenCalled();
  });

  it("continues with remaining modules when one module's seeding throws", async () => {
    mockCreateEntity.mockRejectedValueOnce(new Error("db exploded"));

    await expect(
      seedAllModulesData("tenant-1", ["helpdesk", "projects"], ["u-1"]),
    ).resolves.toBeUndefined();
    // helpdesk failed on its first record; projects still seeded all 5.
    expect(mockCreateEntity).toHaveBeenCalledTimes(6);
  });

  it("marks outbox rows produced during seeding as delivered, inside the tenant context", async () => {
    await seedAllModulesData("tenant-1", []);

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "tenant-1",
      expect.any(Function),
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      outboxEventsTable,
      expect.objectContaining({
        deliveredAt: expect.any(Date),
        notifiedDeliveredAt: expect.any(Date),
      }),
    );
  });

  it("only suppresses this tenant's undelivered rows created since seeding began", async () => {
    const before = Date.now();
    let firstRecordAt = 0;
    mockCreateEntity.mockImplementation(async () => {
      firstRecordAt ||= Date.now();
      return { id: "entity-x", currentState: "backlog", fields: {} };
    });
    await seedAllModulesData("tenant-1", ["projects"], ["u-1"]);

    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    const where = mockUpdateWhere.mock.calls[0]?.[0] as {
      and: [
        { eq: [string, string] },
        { isNull: string },
        { gte: [string, Date] },
      ];
    };
    expect(where.and[0]).toEqual({ eq: ["outbox.tenantId", "tenant-1"] });
    expect(where.and[1]).toEqual({ isNull: "outbox.deliveredAt" });
    expect(where.and[2].gte[0]).toBe("outbox.createdAt");
    // The cut-off is taken before the first record, so rows from before seeding are left alone
    // and every row seeding produced is covered.
    const cutOff = where.and[2].gte[1].getTime();
    expect(cutOff).toBeGreaterThanOrEqual(before);
    expect(cutOff).toBeLessThanOrEqual(firstRecordAt);
  });

  it("propagates a refused suppression instead of failing silently", async () => {
    mockWithTenantContext.mockImplementationOnce(() =>
      Promise.reject(new Error("permission denied for table outbox_events")),
    );

    await expect(seedAllModulesData("tenant-1", [])).rejects.toThrow(
      "permission denied",
    );
  });

  it("uses neutral, made-up company names in sample titles", async () => {
    entityTypeRows = [{ id: "entity-type-1" }];
    transitionRows = [];
    await seedAllModulesData("tenant-1", ["crm", "invoicing"], []);

    const titles = createInputs().map((i) => String(i.fields.title));
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t).not.toMatch(/Globex|Initech|Umbrella/);
    }
  });
});
