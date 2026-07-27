/**
 * av-scan.test.ts
 *
 * Unit tests for the AV scan worker processor.
 * ClamAV, disk I/O, and DB are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

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

const mockTx = {
  select: (...args: unknown[]) => mockDbSelect(...args),
  update: (...args: unknown[]) => mockDbUpdate(...args),
  insert: (...args: unknown[]) => mockDbInsert(...args),
};

vi.mock("@platform/db", () => ({
  db: mockTx,
  // withTenantContext just runs the callback against the same mocked tx —
  // the RLS/set_config side effects it performs against a real DB aren't
  // relevant to these unit tests, only that callers actually go through it.
  withTenantContext: (_tenantId: string, fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  files: { id: "id", tenantId: "tenantId", scanStatus: "scanStatus" },
  outboxEvents: {},
  tenants: {},
}));

vi.mock("@platform/files", () => ({
  resolveStoragePath: (storageKey: string) => `/data/files/${storageKey}`,
}));

vi.mock("@platform/notifications", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@platform/config", () => ({
  env: {
    CLAMAV_HOST: "localhost",
    CLAMAV_PORT: 3310,
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./queues.js", () => ({
  connection: {},
}));

// Fake readable file stream — a plain EventEmitter with no-op destroy()/
// pause()/resume(), driven manually per-test via emit("data"/"end"/"error").
class FakeFileStream extends EventEmitter {
  destroy = vi.fn();
  pause = vi.fn();
  resume = vi.fn();
}
let lastFileStream: FakeFileStream | undefined;

vi.mock("node:fs", () => ({
  default: {
    createReadStream: vi.fn().mockImplementation(() => {
      lastFileStream = new FakeFileStream();
      return lastFileStream;
    }),
  },
}));

// Mock node:net for ClamAV TCP simulation
const mockSocket = {
  connect: vi.fn(),
  write: vi.fn(),
  on: vi.fn(),
  setTimeout: vi.fn(),
  destroy: vi.fn(),
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

/** Wires the socket + fake file stream so scanWithClamav resolves "clean". */
function simulateCleanScan(): void {
  let endCallback: (() => void) | undefined;
  let dataCallback: ((chunk: Buffer) => void) | undefined;
  mockSocket.on.mockImplementation((event: string, cb: () => void) => {
    if (event === "end") endCallback = cb;
    if (event === "data") dataCallback = cb as (chunk: Buffer) => void;
    return mockSocket;
  });
  mockSocket.connect.mockImplementation(
    (_port: number, _host: string, cb: () => void) => {
      queueMicrotask(() => {
        cb(); // fires the connect callback (writes the INSTREAM header)
        // Drive the fake file stream through its data/end lifecycle.
        lastFileStream?.emit("data", Buffer.from("file bytes"));
        lastFileStream?.emit("end");
        if (dataCallback) dataCallback(Buffer.from("stream: OK\0"));
        if (endCallback) endCallback();
      });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  lastFileStream = undefined;
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

  it("streams the file from disk, simulates a ClamAV clean response, and marks the file clean", async () => {
    mockSelectReturning([{ id: "file-uuid-1", scanStatus: "pending" }]);
    simulateCleanScan();

    const setChain = { where: vi.fn().mockResolvedValue(undefined) };
    mockDbUpdate.mockReturnValue({ set: vi.fn().mockReturnValue(setChain) });

    await capturedProcessor!(makeJob());

    expect(mockDbUpdate).toHaveBeenCalled();
  });
});
