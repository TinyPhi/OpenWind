/**
 * connectorDefinitionExists (issue #960): the credential CLI checks that a connector id is a
 * real catalog entry with one indexed lookup instead of reading the whole table.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  connectorDefinitions,
  connectorDefinitionExists,
} from "@platform/db";

const slug = `exists-test-${randomUUID()}`;
let definitionId = "";

beforeAll(async () => {
  const [row] = await db
    .insert(connectorDefinitions)
    .values({
      slug,
      name: "Exists test",
      version: "1.0.0",
      category: "other",
      allowedHosts: [],
    })
    .returning({ id: connectorDefinitions.id });
  definitionId = row!.id;
});

afterAll(async () => {
  await db
    .delete(connectorDefinitions)
    .where(eq(connectorDefinitions.slug, slug));
});

describe("connectorDefinitionExists", () => {
  it("is true for a connector definition in the catalog", async () => {
    expect(await connectorDefinitionExists(definitionId)).toBe(true);
  });

  it("is false for a well-formed id that is not in the catalog", async () => {
    expect(await connectorDefinitionExists(randomUUID())).toBe(false);
  });

  it("is false once the definition has been deleted", async () => {
    await db
      .delete(connectorDefinitions)
      .where(eq(connectorDefinitions.id, definitionId));
    expect(await connectorDefinitionExists(definitionId)).toBe(false);
  });
});
