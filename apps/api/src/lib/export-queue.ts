import { Queue } from "bullmq";
import {
  type ExportJobPayload,
  type ExportJobResult,
  PII_EXPORT_ROLES,
} from "@platform/entity-engine";
import { connection } from "./redis.js";

export { type ExportJobPayload, type ExportJobResult, PII_EXPORT_ROLES };

export const exportQueue = new Queue<ExportJobPayload, ExportJobResult>(
  "export",
  { connection },
);
