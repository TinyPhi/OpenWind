import { Queue } from "bullmq";
import { connection } from "./redis.js";

// ADR-012 Phase C, spec R5 — a separate Queue instance with the same name as
// apps/worker/src/mention-resolution-worker.ts's mentionResolutionQueue
// (apps/api cannot import from apps/worker — dependency rule). Mirrors
// packages/files/src/index.ts's own av-scan queue pattern: the job shape
// below is duplicated by convention, not shared by import, matching that
// existing precedent. Keep this in sync with
// apps/worker/src/mention-resolution-worker.ts's MentionResolutionJob type.
export type MentionResolutionJob = {
  tenantId: string;
  orgId: string;
  ticketId: string;
  workflowId: string;
  mentionIdentifier: string;
  actingPersonId: string;
  commentId: string;
};

export const mentionResolutionQueue = new Queue<MentionResolutionJob>(
  "mention-resolution",
  { connection },
);
