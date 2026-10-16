import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MachineKeyExpiry } from "@platform/auth";

const queueAdds: unknown[][] = [];
vi.mock("@platform/telemetry", () => ({
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(function () {
    return {
      add: vi.fn((...args: unknown[]) => {
        queueAdds.push(args);
        return Promise.resolve(undefined);
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));
vi.mock("./queues.js", () => ({ connection: {} }));

const mockCheck = vi.fn<(now: Date) => Promise<MachineKeyExpiry[]>>();
vi.mock("@platform/auth", () => ({
  checkMachineKeyExpiry: (now: Date) => mockCheck(now),
}));

const mockSend = vi.fn();
vi.mock("@platform/notifications", () => ({
  sendDirectNotification: (...args: unknown[]) => mockSend(...args),
}));

const store = new Map<string, string>();
vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    set: (k: string, v: string, ...flags: unknown[]) => {
      if (flags.includes("NX") && store.has(k)) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve("OK");
    },
    // Mirrors the check-and-delete script: only the holder of the token deletes the key.
    eval: (_script: string, _numKeys: number, k: string, token: string) => {
      if (store.get(k) !== token) return Promise.resolve(0);
      store.delete(k);
      return Promise.resolve(1);
    },
  }),
}));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { OPS_ALERT_EMAIL: undefined as string | undefined },
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
vi.mock("@platform/logger", () => ({ logger: mockLogger }));

const {
  toRow,
  shouldSendDigest,
  buildDigest,
  keySentence,
  digestFingerprint,
  runZitadelKeyExpiryCheck,
  scheduleZitadelKeyExpiryCheck,
  parseLastDigest,
  opsRecipientId,
  KEY_EXPIRY_REPORT_KEY,
} = await import("./zitadel-key-expiry.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-15T06:00:00Z");
const inDays = (d: number): Date => new Date(NOW.getTime() + d * DAY);

function expiring(
  name: "management" | "provisioning" | "notification",
  days: number,
): MachineKeyExpiry {
  return {
    name,
    keyIdSuffix: `${name.slice(0, 3)}001`,
    state: "expires",
    expiresAt: inDays(days),
  };
}
const allThree = (days: number): MachineKeyExpiry[] => [
  expiring("management", days),
  expiring("provisioning", days),
  expiring("notification", days),
];

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  queueAdds.length = 0;
  mockEnv.OPS_ALERT_EMAIL = "ops@example.com";
  mockSend.mockResolvedValue(undefined);
});

describe("toRow", () => {
  it.each([
    [3000, "long_lived"],
    [365.5, "ok"],
    [366.5, "long_lived"],
    [90, "ok"],
    [30.5, "ok"],
    [29.5, "warn_30"],
    [13.5, "warn_14"],
    [6.5, "warn_7"],
    [2.5, "warn_3"],
    [0.5, "warn_1"],
    [-0.1, "expired"],
  ])("%s days left -> %s", (days, status) => {
    expect(toRow(expiring("management", days), NOW).status).toBe(status);
  });

  it("carries never-expires, missing and unknown through", () => {
    expect(
      toRow(
        { name: "management", keyIdSuffix: "a", state: "never_expires" },
        NOW,
      ).status,
    ).toBe("never_expires");
    expect(
      toRow({ name: "management", keyIdSuffix: "a", state: "missing" }, NOW)
        .status,
    ).toBe("missing");
    expect(
      toRow(
        {
          name: "management",
          keyIdSuffix: "a",
          state: "unknown",
          reason: "forbidden",
        },
        NOW,
      ),
    ).toMatchObject({ status: "unknown", reason: "forbidden" });
  });
});

describe("shouldSendDigest", () => {
  const rows = (days: number) => allThree(days).map((r) => toRow(r, NOW));

  it("stays quiet on a first run where everything is fine", () => {
    expect(shouldSendDigest(rows(90), null, NOW)).toBe(false);
  });

  it("sends when a key crosses a threshold, and not again until the next one", () => {
    const warn = rows(20);
    expect(shouldSendDigest(warn, null, NOW)).toBe(true);
    const last = {
      fingerprint: digestFingerprint(warn),
      sentAt: NOW.getTime(),
    };
    // Next day, 19 days left: same state, no repeat for warnings.
    expect(shouldSendDigest(rows(19), last, inDays(1))).toBe(false);
    // Crossing 14 days changes the state.
    expect(shouldSendDigest(rows(13), last, inDays(7))).toBe(true);
  });

  it("sends once more after a rotation, to confirm every key is fine again", () => {
    const warn = rows(5);
    const last = {
      fingerprint: digestFingerprint(warn),
      sentAt: NOW.getTime(),
    };
    expect(shouldSendDigest(rows(90), last, inDays(1))).toBe(true);
  });

  it("repeats expired, missing and unknown daily, and never-expires weekly", () => {
    const expired = rows(-1);
    const sent = {
      fingerprint: digestFingerprint(expired),
      sentAt: NOW.getTime(),
    };
    expect(
      shouldSendDigest(
        expired,
        sent,
        new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
      ),
    ).toBe(false);
    expect(
      shouldSendDigest(
        expired,
        sent,
        new Date(NOW.getTime() + DAY - 30 * 60 * 1000),
      ),
    ).toBe(true);

    const never = [
      toRow(
        { name: "management", keyIdSuffix: "a", state: "never_expires" },
        NOW,
      ),
    ];
    const sentNever = {
      fingerprint: digestFingerprint(never),
      sentAt: NOW.getTime(),
    };
    expect(shouldSendDigest(never, sentNever, inDays(3))).toBe(false);
    expect(shouldSendDigest(never, sentNever, inDays(7))).toBe(true);
  });
});

describe("buildDigest", () => {
  const row = (r: MachineKeyExpiry) => toRow(r, NOW);

  it("writes one paragraph of plain sentences, most urgent first, ending with where the steps are", () => {
    const rows = [
      row(expiring("management", 3000.5)),
      row({
        name: "provisioning",
        keyIdSuffix: "pro001",
        state: "never_expires",
      }),
      row(expiring("notification", 12.5)),
    ];

    const { title, body } = buildDigest(rows);

    expect(title).toBe("OpenWind: 3 of 3 Zitadel machine keys need attention");
    expect(body).toBe(
      "The provisioning key (...pro001) never expires. Please swap it for a key with an expiry date. " +
        "The notification key (...not001) expires in 12 days, on 27 October 2026. Please swap it before then. " +
        "The management key (...man001) expires in 3,000 days, on 1 January 2035. That is more than a year away, so please swap it for a key with a shorter expiry. " +
        'The steps to swap keys are in docs/deployment-hardening.md, under "Zitadel machine-key rotation".',
    );
    // A paragraph: no line breaks or list markers that the service would mangle.
    expect(body).not.toContain("\n");
    expect(body).not.toMatch(/^- /);
  });

  it.each([
    [
      row(expiring("management", -0.5)),
      "The management key (...man001) expired on 14 October 2026. Please swap it now.",
    ],
    [
      row(expiring("management", 1.5)),
      "The management key (...man001) expires in 1 day, on 16 October 2026. Please swap it before then.",
    ],
    [
      row({ name: "management", keyIdSuffix: "abc", state: "missing" }),
      "The management key (...abc) was not found in Zitadel. Please check that the configured key still exists.",
    ],
    [
      row({
        name: "management",
        keyIdSuffix: "abc",
        state: "unknown",
        reason: "forbidden",
      }),
      "The management key (...abc) could not be checked (forbidden).",
    ],
  ])("phrases each case plainly (%#)", (r, sentence) => {
    expect(keySentence(r)).toBe(sentence);
  });

  it("confirms every key is fine after a rotation, with nothing to do", () => {
    const { title, body } = buildDigest(allThree(90.5).map(row));

    expect(title).toBe("OpenWind: all Zitadel machine keys are OK");
    expect(body).toContain(
      "The management key (...man001) is fine: it expires in 90 days, on 13 January 2027.",
    );
    expect(body).not.toContain("steps to swap");
  });
});

describe("runZitadelKeyExpiryCheck", () => {
  it("sends one digest for all keys to every OPS_ALERT_EMAIL address", async () => {
    mockEnv.OPS_ALERT_EMAIL = "ops@example.com, oncall@example.com";
    mockCheck.mockResolvedValue(allThree(20));

    await runZitadelKeyExpiryCheck(NOW);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]?.[0] as {
      title: string;
      body: string;
      recipients: { email: string }[];
    };
    expect(payload.recipients.map((r) => r.email)).toEqual([
      "ops@example.com",
      "oncall@example.com",
    ]);
    expect(payload.body.match(/The \w+ key/g)).toHaveLength(3);
  });

  it("does not send the same digest twice", async () => {
    mockCheck.mockResolvedValue(allThree(20));

    await runZitadelKeyExpiryCheck(NOW);
    await runZitadelKeyExpiryCheck(inDays(1));

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("retries on the next run when sending failed", async () => {
    mockCheck.mockResolvedValue(allThree(20));
    mockSend.mockRejectedValueOnce(new Error("503"));

    await expect(runZitadelKeyExpiryCheck(NOW)).rejects.toThrow("503");
    await runZitadelKeyExpiryCheck(inDays(1));

    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("only logs, and still records the result, when OPS_ALERT_EMAIL is not set", async () => {
    mockEnv.OPS_ALERT_EMAIL = undefined;
    mockCheck.mockResolvedValue(allThree(-1));

    await runZitadelKeyExpiryCheck(NOW);

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {},
      expect.stringContaining("OPS_ALERT_EMAIL"),
    );
    const report = JSON.parse(store.get(KEY_EXPIRY_REPORT_KEY) ?? "{}") as {
      rows: { status: string }[];
    };
    expect(report.rows.map((r) => r.status)).toEqual([
      "expired",
      "expired",
      "expired",
    ]);
  });

  it("does nothing when no key is configured", async () => {
    mockCheck.mockResolvedValue([]);

    await runZitadelKeyExpiryCheck(NOW);

    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("overlapping runs", () => {
  it("lets only one of two concurrent runs send, and frees the lock afterwards", async () => {
    mockCheck.mockResolvedValue(allThree(-1));

    await Promise.all([
      runZitadelKeyExpiryCheck(NOW),
      runZitadelKeyExpiryCheck(NOW),
    ]);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(store.has("ops:zitadel-key-expiry:lock")).toBe(false);
  });

  it("holds the lock under a random token while sending, not a fixed value", async () => {
    mockCheck.mockResolvedValue(allThree(-1));
    let held: string | undefined;
    mockSend.mockImplementationOnce(() => {
      held = store.get("ops:zitadel-key-expiry:lock");
      return Promise.resolve(undefined);
    });

    await runZitadelKeyExpiryCheck(NOW);

    expect(held).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.has("ops:zitadel-key-expiry:lock")).toBe(false);
  });

  it("does not release a lock that a later run took over after the TTL", async () => {
    mockCheck.mockResolvedValue(allThree(-1));
    mockSend.mockImplementationOnce(() => {
      store.set("ops:zitadel-key-expiry:lock", "later-run-token");
      return Promise.resolve(undefined);
    });

    await runZitadelKeyExpiryCheck(NOW);

    expect(store.get("ops:zitadel-key-expiry:lock")).toBe("later-run-token");
  });

  it("frees the lock when the send fails, so the retry can send", async () => {
    mockCheck.mockResolvedValue(allThree(-1));
    mockSend.mockRejectedValueOnce(new Error("novu down"));

    await expect(runZitadelKeyExpiryCheck(NOW)).rejects.toThrow("novu down");
    expect(store.has("ops:zitadel-key-expiry:lock")).toBe(false);

    await runZitadelKeyExpiryCheck(NOW);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe("stored state", () => {
  it("reads the previous digest, and treats unreadable or future-dated state as none", () => {
    const ok = JSON.stringify({
      fingerprint: "abc",
      sentAt: NOW.getTime() - DAY,
    });
    expect(parseLastDigest(ok, NOW)).toEqual({
      fingerprint: "abc",
      sentAt: NOW.getTime() - DAY,
    });
    expect(parseLastDigest(null, NOW)).toBeNull();
    expect(parseLastDigest("not json", NOW)).toBeNull();
    expect(parseLastDigest(JSON.stringify({ fingerprint: 1 }), NOW)).toBeNull();
    // A send "in the future" would otherwise suppress every repeat indefinitely.
    expect(
      parseLastDigest(
        JSON.stringify({ fingerprint: "abc", sentAt: NOW.getTime() + DAY }),
        NOW,
      ),
    ).toBeNull();
  });

  it("still sends when the stored state is corrupt", async () => {
    mockCheck.mockResolvedValue(allThree(-1));
    store.set("ops:zitadel-key-expiry:last-digest", "{corrupt");

    await runZitadelKeyExpiryCheck(NOW);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe("recipients", () => {
  it("gives every address its own stable id", async () => {
    mockEnv.OPS_ALERT_EMAIL = "ops@example.com, oncall@example.com";
    mockCheck.mockResolvedValue(allThree(20));

    await runZitadelKeyExpiryCheck(NOW);

    const recipients = (
      mockSend.mock.calls[0]?.[0] as {
        recipients: { userId: string; email: string }[];
      }
    ).recipients;
    expect(new Set(recipients.map((r) => r.userId)).size).toBe(2);
    expect(recipients[0]?.userId).toBe(opsRecipientId("ops@example.com"));
    expect(opsRecipientId("OPS@example.com")).toBe(
      opsRecipientId("ops@example.com"),
    );
  });
});

describe("scheduleZitadelKeyExpiryCheck", () => {
  it("runs daily at 06:00 and once at start", async () => {
    await scheduleZitadelKeyExpiryCheck();

    expect(queueAdds[0]?.[2]).toMatchObject({
      repeat: { pattern: "0 6 * * *" },
    });
    expect(queueAdds[1]?.[0]).toBe("check-on-start");
    for (const add of queueAdds) {
      expect(add[2]).toMatchObject({
        attempts: 3,
        backoff: { type: "exponential" },
      });
    }
  });
});
