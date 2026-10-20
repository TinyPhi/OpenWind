/**
 * Resolves effective retention policy for a tenant.
 * Re-exports the canonical implementation from @platform/config (Issue #637)
 * to ensure worker sweeps and API policy updates use identical resolution logic.
 */
export { resolveRetentionPolicy } from "@platform/config";
export type { RetentionPolicy } from "@platform/config";
