// Moved to packages/workflow-engine/src/emit-access-event.ts (ADR-012 Phase C,
// PR #470 review fix) so apps/worker's mention-resolution processor can reach
// the same access-event emission without an apps-to-apps import (disallowed
// by the dependency rule). Re-exported here unchanged so every existing call
// site in this app keeps working without edits.
export {
  resolveWorkflowContext,
  emitAccessEvent,
  emitAccessRequestSubmitted,
  emitFileDownloaded,
  emitFileDeleted,
} from "@platform/workflow-engine";
