import type { ClientRequest, IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    ZITADEL_ISSUER: "http://localhost:8080",
    ZITADEL_INTROSPECTION_URL: "http://zitadel:8080/oauth/v2/introspect",
    ZITADEL_SERVICE_ACCOUNT_KEY: JSON.stringify({
      type: "serviceaccount",
      keyId: "mgmt-key",
      key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      userId: "mgmt-user",
    }) as string | undefined,
  },
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("jose", () => ({
  importPKCS8: vi.fn().mockResolvedValue({}),
  SignJWT: class {
    setProtectedHeader(): this {
      return this;
    }
    setIssuedAt(): this {
      return this;
    }
    setIssuer(): this {
      return this;
    }
    setSubject(): this {
      return this;
    }
    setAudience(): this {
      return this;
    }
    setExpirationTime(): this {
      return this;
    }
    sign(): Promise<string> {
      return Promise.resolve("signed-jwt");
    }
  },
}));

// A tiny fake Zitadel, answering by path: token exchange, discovery, and ListKeys.
let listKeysAnswer: { status: number; body: unknown } = {
  status: 200,
  body: { result: [] },
};
const listKeysBodies: unknown[] = [];

const mockHttpRequest = vi.fn(
  (
    options: { path: string },
    callback: (res: IncomingMessage) => void,
  ): Partial<ClientRequest> => {
    let written = "";
    const answer = (status: number, body: unknown): void => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = status;
      queueMicrotask(() => {
        callback(res as unknown as IncomingMessage);
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
    };
    return {
      setTimeout: vi.fn() as unknown as ClientRequest["setTimeout"],
      on: vi.fn() as unknown as ClientRequest["on"],
      write: ((chunk: Buffer) => {
        written += chunk.toString();
        return true;
      }) as unknown as ClientRequest["write"],
      end: (() => {
        if (options.path === "/oauth/v2/token") {
          answer(200, { access_token: "tok", expires_in: 3600 });
        } else if (options.path.endsWith("/ListKeys")) {
          listKeysBodies.push(JSON.parse(written));
          answer(listKeysAnswer.status, listKeysAnswer.body);
        } else {
          answer(404, {});
        }
      }) as unknown as ClientRequest["end"],
    };
  },
);
vi.mock("node:http", () => ({ request: mockHttpRequest }));

const { listMachineKeys } = await import("./zitadel-management.js");

beforeEach(() => {
  listKeysBodies.length = 0;
  listKeysAnswer = { status: 200, body: { result: [] } };
});

describe("listMachineKeys", () => {
  it("asks UserService.ListKeys for one user's keys and returns their expiry", async () => {
    listKeysAnswer = {
      status: 200,
      body: {
        result: [
          { id: "k1", userId: "svc", expirationDate: "2027-01-15T00:00:00Z" },
          { id: "k2", userId: "svc" },
        ],
      },
    };

    const result = await listMachineKeys("svc");

    expect(listKeysBodies[0]).toEqual({
      pagination: { limit: 100 },
      filters: [{ userIdFilter: { id: "svc" } }],
    });
    expect(result).toEqual({
      ok: true,
      keys: [
        { id: "k1", expirationDate: new Date("2027-01-15T00:00:00Z") },
        { id: "k2", expirationDate: null },
      ],
    });
  });

  it("treats an empty answer as no keys", async () => {
    listKeysAnswer = { status: 200, body: {} };

    expect(await listMachineKeys("svc")).toEqual({ ok: true, keys: [] });
  });

  it.each([
    [403, "forbidden"],
    [401, "forbidden"],
    [500, "http_error"],
  ])("maps a %i to %s", async (status, reason) => {
    listKeysAnswer = { status, body: {} };

    expect(await listMachineKeys("svc")).toEqual({ ok: false, reason });
  });

  it("treats an expiry date it can't read as a failed lookup, not as 'never expires'", async () => {
    listKeysAnswer = {
      status: 200,
      body: { result: [{ id: "k1", expirationDate: "not-a-date" }] },
    };

    expect(await listMachineKeys("svc")).toEqual({
      ok: false,
      reason: "bad_response",
    });
  });

  it("rejects a malformed answer", async () => {
    listKeysAnswer = { status: 200, body: { result: [{ nope: 1 }] } };

    expect(await listMachineKeys("svc")).toEqual({
      ok: false,
      reason: "bad_response",
    });
  });
});
