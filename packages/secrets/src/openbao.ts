import { env } from "@platform/config";
import { openbaoRequest } from "./client.js";

function toBase64(s: string): string {
  return Buffer.from(s).toString("base64");
}

interface EncryptResponse {
  data: { ciphertext: string };
}

interface DecryptResponse {
  data: { plaintext: string };
}

export async function encryptCredentialOpenBao(
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

export async function decryptCredentialOpenBao(
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
