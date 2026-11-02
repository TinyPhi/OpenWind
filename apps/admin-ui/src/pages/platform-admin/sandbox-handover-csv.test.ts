import { describe, it, expect } from "vitest";
import {
  buildHandoverCsv,
  formatHandoverClipboard,
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

describe("formatHandoverClipboard", () => {
  it("formats accounts as tab-separated values with a header row", () => {
    const text = formatHandoverClipboard([
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

    expect(text).toBe(
      "Username\tEmail\tRole\tPassword\n" +
        "abigail.smith\tabigail.smith@example.com\tadmin\tOw-abc123-9!\n" +
        "olivia.jones\tolivia.jones@example.com\tuser\tOw-def456-9!",
    );
  });

  it("handles empty accounts list by providing only the header row", () => {
    const text = formatHandoverClipboard([]);
    expect(text).toBe("Username\tEmail\tRole\tPassword");
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

describe("the login link column (R13)", () => {
  const accounts = [
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
  ];
  const link = "https://app.example.com/login?org=3f9a1c7e2b4d8a60";

  it("adds a Login link column to the CSV, on every row", () => {
    expect(buildHandoverCsv(accounts, link)).toBe(
      BOM +
        "Username,Email,Role,Password,Login link\r\n" +
        `abigail.smith,abigail.smith@example.com,admin,Ow-abc123-9!,${link}\r\n` +
        `olivia.jones,olivia.jones@example.com,user,Ow-def456-9!,${link}`,
    );
  });

  it("adds the same column to the clipboard text", () => {
    expect(formatHandoverClipboard(accounts, link)).toBe(
      "Username\tEmail\tRole\tPassword\tLogin link\n" +
        `abigail.smith\tabigail.smith@example.com\tadmin\tOw-abc123-9!\t${link}\n` +
        `olivia.jones\tolivia.jones@example.com\tuser\tOw-def456-9!\t${link}`,
    );
  });

  it.each([null, undefined, ""])(
    "leaves both outputs unchanged when the link is %j",
    (none) => {
      expect(buildHandoverCsv(accounts, none)).toBe(buildHandoverCsv(accounts));
      expect(formatHandoverClipboard(accounts, none)).toBe(
        formatHandoverClipboard(accounts),
      );
    },
  );

  it("keeps the CSV formula guard on the link cell", () => {
    expect(buildHandoverCsv(accounts, "=HYPERLINK(1)")).toContain(
      ",'=HYPERLINK(1)",
    );
  });
});
