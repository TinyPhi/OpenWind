import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// A static 256-bit key for local development / testing
const LOCAL_SECRET_KEY = Buffer.from(
  "OW_LOCAL_DEV_SECRET_KEY_32_BYTES_!".slice(0, 32),
);

/**
 * Encrypt credentials locally using AES-256-GCM.
 * Achieves tenant isolation by setting the tenantId as Additional Authenticated Data (AAD).
 */
export function encryptCredentialLocal(
  tenantId: string,
  plaintext: string,
): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", LOCAL_SECRET_KEY, iv);
  cipher.setAAD(Buffer.from(tenantId));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Return as a formatted string containing IV, encrypted payload, and Auth Tag
  return Promise.resolve(
    `local:${iv.toString("base64")}:${encrypted.toString("base64")}:${authTag.toString("base64")}`,
  );
}

/**
 * Decrypt credentials encrypted locally.
 * Enforces tenant isolation by verifying the AAD matches the provided tenantId.
 */
export function decryptCredentialLocal(
  tenantId: string,
  ciphertext: string,
): Promise<string> {
  if (!ciphertext.startsWith("local:")) {
    throw new Error("Invalid local ciphertext format");
  }
  const parts = ciphertext.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid local ciphertext segments");
  }

  const part1 = parts[1];
  const part2 = parts[2];
  const part3 = parts[3];
  if (!part1 || !part2 || !part3) {
    throw new Error("Invalid local ciphertext segments");
  }

  const iv = Buffer.from(part1, "base64");
  const encrypted = Buffer.from(part2, "base64");
  const authTag = Buffer.from(part3, "base64");

  const decipher = createDecipheriv("aes-256-gcm", LOCAL_SECRET_KEY, iv);
  decipher.setAAD(Buffer.from(tenantId));
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return Promise.resolve(decrypted.toString("utf8"));
}
