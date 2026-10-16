import { describe, it, expect } from "vitest";
import {
  buildHandoverCsv,
  handoverCsvFileName,
} from "./sandbox-handover-csv.js";

const BOM = "﻿";

describe("buildHandoverCsv", () => {
  it("writes a BOM, a header and one CRLF row per account", () => {
    const csv = buildHandoverCsv([
      {
        username: "abigail.smith",
        email: "abigail.smith@example.com",
        role: "admin",
        password: "Ow-abc123-9!",
      },
      {
        username: "olivia.jones",
        email: "olivia.jones@example.com",
        role: "user",
        password: "Ow-def456-9!",
      },
    ]);

    expect(csv).toBe(
      BOM +
        "Username,Email,Role,Password\r\n" +
        "abigail.smith,abigail.smith@example.com,admin,Ow-abc123-9!\r\n" +
        "olivia.jones,olivia.jones@example.com,user,Ow-def456-9!",
    );
  });

  it("quotes commas, quotes and newlines", () => {
    const csv = buildHandoverCsv([
      { username: 'a"b', email: "x,y", role: "user", password: "p\nq" },
    ]);

    expect(csv.split("\r\n")[1]).toBe('"a""b","x,y",user,"p\nq"');
  });

  it.each(["=SUM(A1)", "+1", "-1", "@cmd", "\tx", "\rx"])(
    "neutralises a formula-looking cell (%j) with a leading apostrophe",
    (value) => {
      const csv = buildHandoverCsv([
        { username: value, email: "e", role: "user", password: "Ow-x-9!" },
      ]);
      const cell = csv.split("\r\n")[1]?.split(",")[0] ?? "";

      expect(cell.replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  it("leaves generated passwords (Ow-...-9!) untouched", () => {
    const csv = buildHandoverCsv([
      { username: "u", email: "e", role: "user", password: "Ow-Zx_9-9!" },
    ]);

    expect(csv.endsWith(",Ow-Zx_9-9!")).toBe(true);
  });
});

describe("handoverCsvFileName", () => {
  it("slugs the sandbox name", () => {
    expect(handoverCsvFileName("Acme Sandbox!")).toBe(
      "acme-sandbox-accounts.csv",
    );
  });

  it("falls back when the name has no usable characters", () => {
    expect(handoverCsvFileName("***")).toBe("sandbox-accounts.csv");
  });
});
