import { Queue } from "@platform/telemetry";
import {
  type ExportJobPayload,
  type ExportJobResult,
  type ExportQueuePayload,
  type ExportQueueResult,
  type UserDataExportJobPayload,
  type UserDataExportJobResult,
  isUserDataExportPayload,
  PII_EXPORT_ROLES,
} from "@platform/entity-engine";
import { connection } from "./redis.js";

export {
  type ExportJobPayload,
  type ExportJobResult,
  type UserDataExportJobPayload,
  type UserDataExportJobResult,
  isUserDataExportPayload,
  PII_EXPORT_ROLES,
};

export const exportQueue = new Queue<ExportQueuePayload, ExportQueueResult>(
  "export",
  { connection },
);
