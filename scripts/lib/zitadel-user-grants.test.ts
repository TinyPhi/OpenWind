import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureUserProjectRoles,
  type ZitadelCall,
} from "./zitadel-user-grants.js";

const USER_ID = "user-1";
const PROJECT_ID = "project-1";
const TOKEN = "pat";

type CallArgs = Parameters<ZitadelCall>;

describe("ensureUserProjectRoles", () => {
  it("creates a project grant when the user does not have one", async () => {
    const calls: CallArgs[] = [];
    const call: ZitadelCall = (...args) => {
      calls.push(args);
      return Promise.resolve({});
    };

    const result = await ensureUserProjectRoles(
      call,
      TOKEN,
      USER_ID,
      PROJECT_ID,
      ["agent", "legal"],
    );

    assert.deepEqual(result, {
      action: "created",
      roleKeys: ["agent", "legal"],
    });
    assert.deepEqual(calls, [
      [
        `/management/v1/users/${USER_ID}/grants`,
        TOKEN,
        {
          method: "POST",
          body: { projectId: PROJECT_ID, roleKeys: ["agent", "legal"] },
        },
      ],
    ]);
  });

  it("merges requested roles into an existing grant after a conflict", async () => {
    const calls: CallArgs[] = [];
    const responses: Array<unknown | Error> = [
      new Error("POST grant → 409: already exists"),
      {
        result: [
          {
            id: "grant-1",
            userId: USER_ID,
            projectId: PROJECT_ID,
            roleKeys: ["agent"],
          },
        ],
      },
      {},
    ];
    const call: ZitadelCall = (...args) => {
      calls.push(args);
      const response = responses.shift();
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    };

    const result = await ensureUserProjectRoles(
      call,
      TOKEN,
      USER_ID,
      PROJECT_ID,
      ["agent", "legal"],
    );

    assert.deepEqual(result, {
      action: "updated",
      roleKeys: ["agent", "legal"],
    });
    assert.deepEqual(calls[1], [
      "/management/v1/users/grants/_search",
      TOKEN,
      {
        method: "POST",
        body: {
          queries: [
            { userIdQuery: { userId: USER_ID } },
            { projectIdQuery: { projectId: PROJECT_ID } },
          ],
        },
      },
    ]);
    assert.deepEqual(calls[2], [
      `/management/v1/users/${USER_ID}/grants/grant-1`,
      TOKEN,
      { method: "PUT", body: { roleKeys: ["agent", "legal"] } },
    ]);
  });

  it("does not update an existing grant that already has every role", async () => {
    let callCount = 0;
    const call: ZitadelCall = () => {
      callCount += 1;
      if (callCount === 1) return Promise.reject(new Error("409"));
      return Promise.resolve({
        result: [
          {
            id: "grant-1",
            userId: USER_ID,
            projectId: PROJECT_ID,
            roleKeys: ["agent", "legal"],
          },
        ],
      });
    };

    const result = await ensureUserProjectRoles(
      call,
      TOKEN,
      USER_ID,
      PROJECT_ID,
      ["agent", "legal", "legal"],
    );

    assert.deepEqual(result, {
      action: "unchanged",
      roleKeys: ["agent", "legal"],
    });
    assert.equal(callCount, 2);
  });

  it("rethrows a grant creation failure that is not a conflict", async () => {
    const failure = new Error("POST grant → 503: unavailable");
    const call: ZitadelCall = () => Promise.reject(failure);

    await assert.rejects(
      ensureUserProjectRoles(call, TOKEN, USER_ID, PROJECT_ID, ["agent"]),
      (error: unknown) => error === failure,
    );
  });

  it("fails visibly when a conflict is returned but no matching grant exists", async () => {
    let callCount = 0;
    const call: ZitadelCall = () => {
      callCount += 1;
      return callCount === 1
        ? Promise.reject(new Error("409"))
        : Promise.resolve({ result: [] });
    };

    await assert.rejects(
      ensureUserProjectRoles(call, TOKEN, USER_ID, PROJECT_ID, ["agent"]),
      /existing grant could not be found/,
    );
  });
});
