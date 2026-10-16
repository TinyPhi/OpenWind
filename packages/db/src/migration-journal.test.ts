import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Drizzle's migrator (checked in drizzle-orm 0.45.2, pg-core/dialect.js migrate()) reads the
// latest applied `created_at` once and runs a migration only if that value is strictly less than
// the migration's journal `when`. A `when` that is equal to or lower than its predecessor's is
// silently skipped by any database that stopped at the predecessor. idx is not consulted.

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  // Cast: reading the three fields of an object this guard has just confirmed is non-null.
  const v = value as Record<string, unknown>;
  return (
    typeof v["idx"] === "number" &&
    typeof v["when"] === "number" &&
    typeof v["tag"] === "string"
  );
}

function readEntries(): JournalEntry[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8"),
  );
  // Cast: the journal's top level is only known to be an object after this check.
  const list = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(list) || !list.every(isJournalEntry)) {
    throw new Error("meta/_journal.json: entries must be {idx, when, tag}[]");
  }
  return list;
}

const entries = readEntries();

describe("migration journal", () => {
  it("numbers entries 0..n-1 with unique tags that each have a .sql file", () => {
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
    expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
    const files = new Set(
      readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .map((f) => f.slice(0, -".sql".length)),
    );
    expect(entries.filter((e) => !files.has(e.tag)).map((e) => e.tag)).toEqual(
      [],
    );
  });

  it("gives every entry a `when` strictly greater than the one before it", () => {
    const violations = entries.flatMap((entry, i) => {
      const prev = entries[i - 1];
      if (!prev || entry.when > prev.when) return [];
      return [`${prev.tag} (${prev.when}) -> ${entry.tag} (${entry.when})`];
    });
    expect(violations).toEqual([]);
  });
});
