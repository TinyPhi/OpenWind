import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";

// docs/specs/tenant-access-gate.md R2. requireAuth()'s own tenant refusals are covered in
// packages/auth's middleware tests; here it hands over a resolved login.
let currentAuth: AuthContext;

vi.mock("@platform/auth", async (importOriginal) => {
  const real = await importOriginal<typeof Auth>();
  return {
    ...real,
    requireAuth:
      () =>
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", currentAuth);
        await next();
      },
  };
});

const { accessRouter } = await import("./index.js");

function login(roles: string[]): AuthContext {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "395069484982861826",
    roles,
    email: "a@example.com",
  };
}

async function access(): Promise<Response> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/auth", accessRouter);
  return app.request("/auth/access");
}

describe("GET /auth/access", () => {
  it.each([["admin"], ["agent"], ["user"], ["superadmin"]])(
    "allows a login with the %s role",
    async (role) => {
      currentAuth = login([role]);
      const res = await access();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          allowed: true,
          tenantId: "11111111-1111-4111-8111-111111111111",
          roles: [role],
        },
      });
    },
  );

  it("refuses a login with no OpenWind role", async () => {
    currentAuth = login([]);
    const res = await access();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("NO_ROLE");
  });

  it("ignores roles that aren't OpenWind's", async () => {
    currentAuth = login(["platform_admin", "some_other_project_role"]);
    expect((await access()).status).toBe(403);
  });
});
