import { createHash } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fixed namespace for ids that are not uuids; never change it, or existing entries stop matching.
const NAMESPACE = "3f2f6c1e-5b0a-4d7e-9a53-0c1d8e6b7a42";

/**
 * `admin_audit_log.resource_id` is a uuid column. Resources identified by an external id (a Zitadel
 * user id is a numeric string) need a stable uuid in its place: the same input always gives the
 * same uuid, so `queryAuditLog({ resourceId })` finds every entry for that resource. A value that
 * is already a uuid is returned unchanged. Put the real id in `metadata` so it stays readable.
 */
export function auditResourceId(externalId: string): string {
  if (UUID_PATTERN.test(externalId)) return externalId.toLowerCase();
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(ns)
    .update(externalId, "utf8")
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // UUID version 5 and the RFC 4122 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
