/**
 * av-scan.test.ts
 *
 * Unit tests for the AV scan worker processor.
 * ClamAV, S3, and DB are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Capture the processor function passed to Worker
let capturedProcessor:
  | ((job: {
      data: unknown;
      id: string;
      attemptsMade: number;
      opts: { attempts?: number };
    }) => Promise<void>)
  | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor as typeof capturedProcessor;
    return {
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
});
const mockDbInsert = vi
  .fn()
  .mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
const mockDbSelect = vi.fn();

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
  files: { id: "id", tenantId: "tenantId", scanStatus: "scanStatus" },
  outboxEvents: {},
  tenants: {},
  isTenantActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  // Must use 'function' (not arrow) — vitest 4.x requires a constructable
  // implementation when the mock is used with 'new'.
  S3Client: vi.fn().mockImplementation(function () {
    return {
      send: vi.fn().mockResolvedValue({
        Body: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from("test file content");
          },
        },
      }),
    };
  }),
  GetObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
}));

vi.mock("@platform/notifications", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@platform/config", () => ({
  env: {
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: 3310,
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "test",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
    REDIS_URL: "redis://localhost:6379",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./queues.js", () => ({
  connection: {},
}));

// Mock node:net for ClamAV TCP simulation
const mockSocket = {
  connect: vi.fn(),
  write: vi.fn(),
  on: vi.fn(),
  setTimeout: vi.fn(),
};

vi.mock("node:net", () => ({
  default: {
    // Must use 'function' — vitest 4.x requires constructable implementations.
    Socket: vi.fn().mockImplementation(function () {
      return mockSocket;
    }),
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

type SelectChain = {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function mockSelectReturning(rows: unknown[]) {
  const chain: Partial<SelectChain> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(rows);
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

function makeJob(
  overrides: Partial<{ scanStatus: string; attemptsMade: number }> = {},
) {
  return {
    id: "job-1",
    data: {
      fileId: "file-uuid-1",
      tenantId: "tenant-1",
      storageKey: "tenants/t/files/file-uuid-1.pdf",
    },
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: { attempts: 5 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Note: capturedProcessor is NOT reset here — Worker() fires once at import
  // time. Clearing it would destroy the only reference we have.
});

// ── Import worker (captures processor) ────────────────────────────────────────

await import("./av-scan.js");

describe("av-scan worker", () => {
  it("skips file that is no longer pending (idempotent)", async () => {
    mockSelectReturning([{ id: "file-uuid-1", scanStatus: "clean" }]);

    expect(capturedProcessor).toBeDefined();
    await capturedProcessor!(makeJob({ scanStatus: "clean" }));

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("skips when file row is not found", async () => {
    mockSelectReturning([]);

    await capturedProcessor!(makeJob());

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("simulates ClamAV clean response and marks file as clean", async () => {
    mockSelectReturning([{ id: "file-uuid-1", scanStatus: "pending" }]);

    // Simulate ClamAV "clean" TCP response
    let endCallback: (() => void) | undefined;
    let dataCallback: ((chunk: Buffer) => void) | undefined;
    mockSocket.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "end") endCallback = cb;
      if (event === "data") dataCallback = cb as (chunk: Buffer) => void;
      return mockSocket;
    });
    mockSocket.connect.mockImplementation(
      (_port: number, _host: string, cb: () => void) => {
        // Defer via queueMicrotask so that scanWithClamav registers its
        // socket.on("data"/"end") handlers (synchronous, after socket.connect)
        // before we fire the simulated ClamAV response.
        queueMicrotask(() => {
          cb(); // fire the connect callback (writes INSTREAM bytes)
          if (dataCallback) dataCallback(Buffer.from("stream: OK\0"));
          if (endCallback) endCallback();
        });
      },
    );

    const setChain = { where: vi.fn().mockResolvedValue(undefined) };
    mockDbUpdate.mockReturnValue({ set: vi.fn().mockReturnValue(setChain) });

    await capturedProcessor!(makeJob());

    expect(mockDbUpdate).toHaveBeenCalled();
  });
});
