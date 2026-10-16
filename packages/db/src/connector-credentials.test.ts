import { describe, it, expect } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { connectorDefinitionExists } from "./connector-credentials.js";
import type { DbOrTx } from "./middleware.js";

// A stand-in for the query builder that records the WHERE clause and LIMIT,
// so the test can prove the lookup is scoped (#960) without a database.
function fakeExecutor(rows: { id: string }[]) {
  const seen: { where?: SQL; limit?: number } = {};
  const chain = {
    from: () => chain,
    where: (clause: SQL) => {
      seen.where = clause;
      return chain;
    },
    limit: (n: number) => {
      seen.limit = n;
      return Promise.resolve(rows);
    },
  };
  const executor = { select: () => chain } as unknown as DbOrTx;
  return { executor, seen };
}

const ID = "00000000-0000-0000-0000-000000000001";

describe("connectorDefinitionExists", () => {
  it("looks up one id with WHERE id = $1 LIMIT 1, not a full read", async () => {
    const { executor, seen } = fakeExecutor([{ id: ID }]);

    await expect(connectorDefinitionExists(executor, ID)).resolves.toBe(true);

    expect(seen.limit).toBe(1);
    const rendered = new PgDialect().sqlToQuery(seen.where!);
    expect(rendered.sql).toMatch(/"connector_definitions"\."id" = \$1/);
    expect(rendered.params).toEqual([ID]);
  });

  it("returns false when the id doesn't exist", async () => {
    const { executor } = fakeExecutor([]);
    await expect(connectorDefinitionExists(executor, ID)).resolves.toBe(false);
  });
});
