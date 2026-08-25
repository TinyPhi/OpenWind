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

// PR #470 review fix: without an explicit defaultJobOptions, BullMQ defaults
// to attempts: 1, so a single transient Zitadel/DB failure inside the
// processor would abort immediately and record tag.resolution_failed rather
// than retrying -- matching apps/worker/src/queues.ts's established
// attempts/backoff pattern for every other queue in this codebase.
export const mentionResolutionQueue = new Queue<MentionResolutionJob>(
  "mention-resolution",
  {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
    },
  },
);
