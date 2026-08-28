import { env } from "@platform/config";
import {
  encryptCredentialOpenBao,
  decryptCredentialOpenBao,
} from "./openbao.js";
import { encryptCredentialLocal, decryptCredentialLocal } from "./local.js";

/**
 * Encrypt credential using the configured secrets vault provider.
 */
export async function encryptCredential(
  tenantId: string,
  plaintext: string,
): Promise<string> {
  if (env.SECRETS_PROVIDER === "local") {
    return encryptCredentialLocal(tenantId, plaintext);
  }
  return encryptCredentialOpenBao(tenantId, plaintext);
}

/**
 * Decrypt credential using the configured secrets vault provider.
 */
export async function decryptCredential(
  tenantId: string,
  ciphertext: string,
): Promise<string> {
  if (ciphertext.startsWith("local:")) {
    return decryptCredentialLocal(tenantId, ciphertext);
  }
  return decryptCredentialOpenBao(tenantId, ciphertext);
}
