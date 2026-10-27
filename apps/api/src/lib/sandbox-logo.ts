import { z } from "zod";

/** 100 KB decoded (R12). */
export const MAX_SANDBOX_LOGO_BYTES = 100 * 1024;
// Base64 of MAX_SANDBOX_LOGO_BYTES is about 136,600 characters; the prefix adds under 30. Checked
// before decoding so an oversized body is never turned into a buffer. Matches tenants_logo_check.
const MAX_SANDBOX_LOGO_CHARS = 140_000;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

type LogoType = "png" | "jpeg" | "webp";

// The declared type must match the file's own leading bytes, so a renamed file or an SVG labelled
// as a PNG is refused rather than stored and later served as an image.
function bytesMatch(type: LogoType, bytes: Buffer): boolean {
  if (type === "png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (type === "jpeg") {
    return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  }
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

export const SandboxLogoSchema = z
  .string()
  .max(MAX_SANDBOX_LOGO_CHARS, "Logo is larger than 100 KB")
  .superRefine((value, ctx) => {
    const match = DATA_URL.exec(value);
    if (!match) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo must be a PNG, JPEG or WebP data URL",
      });
      return;
    }
    // Cast: the regex's first group is exactly one of the three LogoType literals.
    const type = match[1] as LogoType;
    const bytes = Buffer.from(match[2] ?? "", "base64");
    if (bytes.length > MAX_SANDBOX_LOGO_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo is larger than 100 KB",
      });
    } else if (!bytesMatch(type, bytes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Logo content does not match its declared image type",
      });
    }
  });
