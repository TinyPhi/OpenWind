import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetEntity = vi.fn();
const mockGetParentId = vi.fn().mockResolvedValue(null);
const mockCountActiveChildren = vi.fn().mockResolvedValue(0);

let mockAuth: AuthContext = {
  tenantId: "t-aaa",
  userId: "u-bbb",
  roles: ["agent"],
  email: "test@example.com",
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

// getAncestorDepth (unconditionally called by the handler) walks
// entity_relations via a raw select chain -- stub it to resolve no parent,
// matching the flat (non-nested) fixtures these tests use.
const teamsTable = { __name: "teams" };
let mockTeamRow: { name: string } | undefined;

const mockAncestorSelect = vi.fn(() => ({
  from: vi.fn((t: { __table?: unknown }) => {
    const isTeams = t?.__table === teamsTable;
    return {
      where: vi.fn(() => ({
        limit: vi
          .fn()
          .mockResolvedValue(isTeams ? (mockTeamRow ? [mockTeamRow] : []) : []),
      })),
    };
  }),
}));

vi.mock("@platform/db", () => ({
  db: {},
  entityRelations: {
    toInstanceId: "entity_relations.to_instance_id",
    tenantId: "entity_relations.tenant_id",
    fromInstanceId: "entity_relations.from_instance_id",
    relationType: "entity_relations.relation_type",
    deletedAt: "entity_relations.deleted_at",
  },
  workflows: {
    id: "workflows.id",
    maxChildDepth: "workflows.max_child_depth",
  },
  teams: {
    id: "teams.id",
    name: "teams.name",
    tenantId: "teams.tenant_id",
    deletedAt: "teams.deleted_at",
    __table: teamsTable,
  },
  withTenantContext: (tenantId, fn) => fn({ select: mockAncestorSelect }),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntity: (...args: unknown[]) => mockGetEntity(...args),
    getParentId: (...args: unknown[]) => mockGetParentId(...args),
    countActiveChildren: (...args: unknown[]) =>
      mockCountActiveChildren(...args),
  };
});

const { getEntityHandler } = await import("./get.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/:id", ...getEntityHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INST_ID = "00000000-0000-0000-0000-000000000002";

const fakeInstance = {
  id: INST_ID,
  entityTypeId: "00000000-0000-0000-0000-000000000001",
  tenantId: "t-aaa",
  workflowId: null,
  currentState: "open",
  fields: { subject: "hello" },
  createdBy: null,
  assignedTo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /entities/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-bbb",
      roles: ["agent"],
      email: "test@example.com",
    };
    mockTeamRow = undefined;
  });

  it("returns 200 with the entity instance when found", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(INST_ID);
    expect(mockGetEntity).toHaveBeenCalledWith(
      { select: mockAncestorSelect },
      "t-aaa",
      INST_ID,
    );
  });

  it("returns 404 when the entity does not exist", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntity.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await makeApp().request("/missing-id");

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("ENTITY_NOT_FOUND");
  });

  it("returns 404 for a soft-deleted entity", async () => {
    const { EntityError } = await import("@platform/entity-engine");
    mockGetEntity.mockRejectedValue(new EntityError("ENTITY_NOT_FOUND"));

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(404);
  });

  it("includes deletedAt as null on active instances", async () => {
    mockGetEntity.mockResolvedValue(fakeInstance);

    const res = await makeApp().request(`/${INST_ID}`);
    const json = await res.json();

    expect(json.data.deletedAt).toBeNull();
  });

  // ── record-level read access (__accessUsers ACL) ───────────────────────────

  it("returns 404 for a non-privileged user with no relation to a restricted record", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-outsider",
      roles: ["user"],
      email: "outsider@example.com",
    };
    mockGetEntity.mockResolvedValue({
      ...fakeInstance,
      createdBy: "u-owner",
      assignedTo: "u-other",
      fields: { subject: "hello" },
    });

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(404);
  });

  it("returns 200 for a non-privileged user who created the record", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-owner",
      roles: ["user"],
      email: "owner@example.com",
    };
    mockGetEntity.mockResolvedValue({
      ...fakeInstance,
      createdBy: "u-owner",
      assignedTo: null,
      fields: { subject: "hello" },
    });

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(200);
  });

  it("returns 200 for a non-privileged user granted read_comment access via __accessUsers", async () => {
    mockAuth = {
      tenantId: "t-aaa",
      userId: "u-granted",
      roles: ["user"],
      email: "granted@example.com",
    };
    mockGetEntity.mockResolvedValue({
      ...fakeInstance,
      createdBy: "u-owner",
      assignedTo: null,
      fields: {
        subject: "hello",
        __accessUsers: { "u-granted": { level: "read_comment" } },
      },
    });

    const res = await makeApp().request(`/${INST_ID}`);

    expect(res.status).toBe(200);
  });

  // 2026-09-22: team_id is a plain generic field on every entity type (no
  // dedicated "team reference" field type) -- the UI showed the raw UUID
  // for any non-ticket entity type until this resolution was added.
  describe("teamName resolution", () => {
    it("resolves fields.team_id to the team's live display name", async () => {
      mockTeamRow = { name: "Dev Team" };
      mockGetEntity.mockResolvedValue({
        ...fakeInstance,
        fields: { subject: "hello", team_id: "team-1" },
      });

      const res = await makeApp().request(`/${INST_ID}`);
      const json = await res.json();

      expect(json.data.teamName).toBe("Dev Team");
    });

    it("falls back to the raw id when the team no longer exists", async () => {
      mockTeamRow = undefined;
      mockGetEntity.mockResolvedValue({
        ...fakeInstance,
        fields: { subject: "hello", team_id: "deleted-team-1" },
      });

      const res = await makeApp().request(`/${INST_ID}`);
      const json = await res.json();

      expect(json.data.teamName).toBe("deleted-team-1");
    });

    it("is null when the entity has no team_id set", async () => {
      mockGetEntity.mockResolvedValue(fakeInstance);

      const res = await makeApp().request(`/${INST_ID}`);
      const json = await res.json();

      expect(json.data.teamName).toBeNull();
    });
  });
});
