export type FileErrorCode =
  | "QUOTA_EXCEEDED"
  | "FILE_TOO_LARGE"
  | "FILE_PENDING_SCAN"
  | "FILE_QUARANTINED"
  | "FILE_SCAN_FAILED"
  | "FILE_NOT_FOUND"
  | "SCAN_FAILED"
  | "PROVIDER_ERROR"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_READ_FAILED";

export class FileError extends Error {
  constructor(
    public readonly code: FileErrorCode,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = "FileError";
  }
}
