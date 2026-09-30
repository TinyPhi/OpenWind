import {
  listOrgUsers,
  getOrgMetadataForUser,
  lookupOrgIdByTenantId,
} from "@platform/auth";
import { logger } from "@platform/logger";
import type { OrgSourceImporter, OrgSourceRecord } from "./types.js";

// Caps how many getOrgMetadataForUser calls run concurrently -- an
// unbounded Promise.all over a large org would fire hundreds of simultaneous
// Zitadel requests in one burst.
const METADATA_FETCH_CONCURRENCY = 10;

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Today's OrgSourceImporter implementation. This is the ONLY module in this
 * package allowed to know Zitadel exists -- runOrgDirectorySync and
 * buildOrgTree take an OrgSourceImporter and never reference Zitadel
 * directly, so swapping identity providers (or a future external org-chart
 * service) means writing a new importer, not touching the sync/tree-build
 * logic (docs/specs/org-directory.md §I).
 */
export class ZitadelOrgSourceImporter implements OrgSourceImporter {
  async fetchAll(tenantId: string): Promise<OrgSourceRecord[]> {
    const orgId = await lookupOrgIdByTenantId(tenantId);
    if (!orgId) {
      logger.warn(
        { tenantId },
        "ZitadelOrgSourceImporter: tenant has no mapped Zitadel org — skipping sync",
      );
      return [];
    }

    const users = await listOrgUsers(orgId);
    return mapWithConcurrencyLimit(
      users,
      METADATA_FETCH_CONCURRENCY,
      async (user): Promise<OrgSourceRecord> => {
        const metadata = await getOrgMetadataForUser(user.userId);
        return {
          userId: user.userId,
          managerId: metadata.managerId,
          department: metadata.department,
          name: user.displayName,
          title: metadata.title ?? "",
          email: user.email,
        };
      },
    );
  }
}
