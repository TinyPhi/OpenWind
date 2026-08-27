// Moved to packages/workflow-engine/src/entity-access.ts (ADR-012 Phase C) so
// apps/worker's mention-resolution processor can reach the same check
// without an apps-to-apps import (disallowed by the dependency rule).
// Re-exported here unchanged so every existing call site in this app keeps
// working without edits.
export {
  hasEntityReadAccess,
  explicitAccessListUserIds,
  hasEntityCommentAccess,
  hasEntityAccess,
  hasEntityCommentAccessFull,
} from "@platform/workflow-engine";
