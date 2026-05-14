import { env } from "@platform/config";
import { openbaoRequest } from "./client.js";

// Transit key is created with derived=true so each tenantId produces a
// different derived key — ciphertexts are cryptographically tenant-scoped.
// The context must be stable (we use tenantId as a base64 context value).

function toBase64(s: string): string {
  return Buffer.from(s).toString("base64");
}

interface EncryptResponse {
  data: { ciphertext: string };
}

interface DecryptResponse {
  data: { plaintext: string };
}

export async function encryptCredential(
  tenantId: string,
  plaintext: string,
): Promise<string> {
  const res = await openbaoRequest<EncryptResponse>(
    "POST",
    `transit/encrypt/${env.OPENBAO_TRANSIT_KEY}`,
    {
      plaintext: toBase64(plaintext),
      context: toBase64(tenantId),
    },
  );
  return res.data.ciphertext;
}

export async function decryptCredential(
  tenantId: string,
  ciphertext: string,
): Promise<string> {
  const res = await openbaoRequest<DecryptResponse>(
    "POST",
    `transit/decrypt/${env.OPENBAO_TRANSIT_KEY}`,
    {
      ciphertext,
      context: toBase64(tenantId),
    },
  );
  return Buffer.from(res.data.plaintext, "base64").toString("utf8");
}
