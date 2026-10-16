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
    // The local provider's key is published in this repo, so `local:` values
    // offer no protection; production never decrypts them (ADR-023 Decision 7).
    // Run packages/db's check-local-ciphertext first: it must report zero rows.
    if (env.NODE_ENV === "production") {
      throw new Error(
        "Refusing to decrypt 'local:' ciphertext in production: the local provider's key is public. Re-enter this credential with the OpenBao provider.",
      );
    }
    return decryptCredentialLocal(tenantId, ciphertext);
  }
  return decryptCredentialOpenBao(tenantId, ciphertext);
}
