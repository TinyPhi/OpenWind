import { db, modules } from "@platform/db";

export const MODULE_CATALOG_EMPTY_MESSAGE =
  "The module catalog (table `modules`) is empty. The API role is read-only on it (ADR-005 " +
  "Amendment 1), so the catalog is written by the migration step, not by the API. Run the " +
  "migrations as migration_user (`pnpm db:migrate`, or the compose `bootstrap` container: " +
  "`docker compose --profile bootstrap up`) and restart the API. See docs/local-setup.md, " +
  "section 'API exits: module catalog is empty'.";

export class ModuleCatalogEmptyError extends Error {
  constructor() {
    super(MODULE_CATALOG_EMPTY_MESSAGE);
    this.name = "ModuleCatalogEmptyError";
  }
}

type CatalogReader = {
  select: (fields: { id: typeof modules.id }) => {
    from: (table: typeof modules) => {
      limit: (n: number) => Promise<unknown[]>;
    };
  };
};

/**
 * Startup check (ADR-005 Amendment 1): reads the catalog as the API's own role and
 * throws ModuleCatalogEmptyError when it has no rows. Fails on empty only; a stale or
 * partial catalog is not detected here.
 */
export async function assertModuleCatalog(
  reader: CatalogReader = db,
): Promise<void> {
  const rows = await reader.select({ id: modules.id }).from(modules).limit(1);
  if (rows.length === 0) {
    throw new ModuleCatalogEmptyError();
  }
}
