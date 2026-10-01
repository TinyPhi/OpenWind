/**
 * @platform/org-directory
 *
 * docs/specs/org-directory.md — tenant org-chart tree seeded from an external
 * identity provider's user metadata (manager_id/department), then stored and
 * queried entirely from this package's own tables. The provider is only ever
 * touched through the OrgSourceImporter boundary (see ./types.ts) — this is
 * what keeps the module swappable across auth providers and, later, a
 * different org-chart backing implementation.
 */

export type {
  OrgNode,
  OrgTree,
  OrgSourceRecord,
  OrgSourceImporter,
  SyncResult,
  SyncStatus,
} from "./types.js";
export {
  buildOrgTree,
  type PriorEmployee,
  type ResolvedEmployee,
  type OrgTreeBuildResult,
} from "./tree-builder.js";
export { ZitadelOrgSourceImporter } from "./zitadel-importer.js";
export { runOrgDirectorySync } from "./sync.js";
export {
  getOrgTree,
  getChainToRoot,
  getReportsByLevel,
  getSyncStatus,
} from "./query.js";
