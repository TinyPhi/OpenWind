import { describe, it, expect } from "vitest";
import pino from "pino";
import {
  MAX_SCRUB_LENGTH,
  REDACT_KEYS,
  loggerOptions,
  TEXT_RULES,
  scrubPIIInPlace,
  scrubString,
} from "./index.js";

describe("scrubString field patterns", () => {
  it("redacts the smoke-test strings from #1149", () => {
    expect(
      scrubString(
        "user bob@example.com token Bearer abc.def.ghi password=hunter2",
      ),
    ).toBe("user [REDACTED] token Bearer [REDACTED] password=[REDACTED]");
    expect(scrubString("contact dave@example.com")).toBe("contact [REDACTED]");
  });

  it("redacts JWTs, api keys and quoted secrets", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-1";
    expect(scrubString(`got ${jwt} here`)).toBe("got [REDACTED] here");
    expect(scrubString("api_key=sk_live_123&x=1")).toBe(
      "api_key=[REDACTED]&x=1",
    );
    expect(scrubString('{"client_secret": "s3cr3t value"}')).not.toContain(
      "s3cr3t",
    );
    expect(scrubString("x-api-key: abc123")).toBe("x-api-key: [REDACTED]");
    expect(scrubString("Authorization: Bearer abc")).not.toContain("abc");
  });

  it("leaves benign text alone", () => {
    const text = "Workflow transition failed for instance 3f2a at state open";
    expect(scrubString(text)).toBe(text);
  });
});

describe("single source of rules", () => {
  it("the real logger options redact every shared key, nested and top level", () => {
    const lines: string[] = [];
    const log = pino(loggerOptions, {
      write: (l: string) => void lines.push(l),
    });
    const obj = Object.fromEntries(REDACT_KEYS.map((k) => [k, "leak-" + k]));
    log.info(obj, "hi");
    log.info({ nested: obj }, "hi");
    expect(lines.join("")).not.toContain("leak-");
  });

  it("the real logger options scrub the message, printf args and string fields", () => {
    const lines: string[] = [];
    const log = pino(loggerOptions, {
      write: (l: string) => void lines.push(l),
    });
    log.info(
      { note: "contact dave@example.com", tenantId: "t1" },
      "user %s",
      "bob@example.com password=hunter2",
    );
    log.error({ err: new Error("no user bob@example.com") }, "boom");
    const out = lines.join("");
    expect(out).not.toMatch(/example\.com|hunter2/);
    expect(out).toContain('"tenantId":"t1"');
    expect(out).toContain("boom");
  });

  it("every text rule is exercised by the shared scrubber", () => {
    expect(TEXT_RULES.map((r) => r.name)).toEqual([
      "bearer",
      "basic",
      "jwt",
      "email",
      "key-value-secret",
    ]);
  });
});

describe("ReDoS resistance", () => {
  const hostile = [
    "a".repeat(200_000),
    "a@".repeat(100_000),
    "Bearer " + "a".repeat(200_000),
    "eyJ".repeat(60_000),
    "password" + " ".repeat(200_000),
    "token=" + '"'.repeat(100_000),
    "a.".repeat(100_000) + "@",
    "x@" + "a.".repeat(100_000),
  ];

  it.each(hostile.map((h, i) => [i, h] as const))(
    "input %i scrubs in well under a second",
    (_i, input) => {
      const start = performance.now();
      const out = scrubString(input);
      expect(performance.now() - start).toBeLessThan(1000);
      expect(out.length).toBeLessThanOrEqual(MAX_SCRUB_LENGTH + 64);
    },
  );
});

describe("review hardening", () => {
  it("redacts camelCase, dashed and plural sensitive keys", () => {
    const o: Record<string, unknown> = {
      accessToken: "a",
      "Set-Cookie": "b",
      cookies: { session: "c" },
      sessionId: "d",
      csrfToken: "e",
      tokens: 5,
    };
    scrubPIIInPlace(o);
    expect(o).toEqual({
      accessToken: "[REDACTED]",
      "Set-Cookie": "[REDACTED]",
      cookies: "[REDACTED]",
      sessionId: "[REDACTED]",
      csrfToken: "[REDACTED]",
      tokens: 5,
    });
  });

  it("redacts Basic credentials but not prose", () => {
    expect(scrubString("Authorization: Basic dXNlcjpwYXNz")).not.toContain(
      "dXNlcjpwYXNz",
    );
    expect(scrubString("Basic information about it")).toBe(
      "Basic information about it",
    );
  });

  it("redacts keyword prefixes such as x_api_key and client_secret", () => {
    expect(scrubString("x_api_key=abc client_secret: def")).toBe(
      "x_api_key=[REDACTED] client_secret: [REDACTED]",
    );
  });

  it("fails closed on deeply nested payloads", () => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      cur["n"] = next;
      cur = next;
    }
    cur["leak"] = "bob@example.com";
    expect(() => scrubPIIInPlace(root)).not.toThrow();
    expect(JSON.stringify(root)).not.toContain("bob@example.com");
  });
});

describe("review round 2", () => {
  it("redacts non-Bearer authorization schemes and escaped quotes", () => {
    expect(scrubString("Authorization: Token abc123")).not.toContain("abc123");
    expect(scrubString('password="abc\\"def ghi" tail')).toBe(
      "password=[REDACTED] tail",
    );
    expect(scrubString("Cookie: sid=abc")).not.toContain("abc");
  });

  it("leaves name@version strings alone but still redacts emails", () => {
    expect(scrubString("app@1.2.3")).toBe("app@1.2.3");
    expect(scrubString("/.pnpm/@sentry+node@10.0.0_x/index.js")).toBe(
      "/.pnpm/@sentry+node@10.0.0_x/index.js",
    );
    expect(scrubString("a.b+c@mail.example.co.uk")).toBe("[REDACTED]");
  });
});
