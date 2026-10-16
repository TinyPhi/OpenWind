import { z } from "zod";
import { env } from "@platform/config";
import { listMachineKeys } from "./zitadel-management.js";

/**
 * The live expiry of every Zitadel machine key OpenWind is configured with
 * (docs/deployment-hardening.md, "Zitadel machine-key rotation"). Nothing about a key's expiry
 * is stored: each check reads the key id and machine user from the current configuration and
 * asks Zitadel, so after a rotation the next check simply follows the new key.
 */

export const MACHINE_KEY_NAMES = [
  "management",
  "provisioning",
  "notification",
] as const;
export type MachineKeyName = (typeof MACHINE_KEY_NAMES)[number];

export type MachineKeyExpiry =
  | {
      name: MachineKeyName;
      /** Last 6 characters of the key id -- enough to tell keys apart, nothing more. */
      keyIdSuffix: string;
      state: "expires";
      expiresAt: Date;
    }
  | { name: MachineKeyName; keyIdSuffix: string; state: "never_expires" }
  /** Zitadel no longer lists this key: deleted, or the configuration is stale. */
  | { name: MachineKeyName; keyIdSuffix: string; state: "missing" }
  | {
      name: MachineKeyName;
      keyIdSuffix: string;
      state: "unknown";
      reason: string;
    };

// Keys created without an expiry may come back with no date at all or with a placeholder far
// in the future (9999-01-01); both mean "never expires".
const NEVER_EXPIRES_AFTER_YEARS = 50;

// Only the two identifiers are read; the private key in the same JSON is never touched here.
const KeyRefSchema = z.object({
  keyId: z.string().min(1),
  userId: z.string().min(1),
});

/**
 * Each key's JSON exactly as its real consumer reads it -- same variable precedence, same
 * encoding -- so a key the consumer can't load is reported as unreadable here, never as fine.
 * Raw JSON: ZITADEL_SERVICE_ACCOUNT_KEY, ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY and
 * NOTIFICATION_ZITADEL_KEY_JSON. Base64: ZITADEL_KEY_JSON and ZITADEL_PROVISIONING_KEY_JSON.
 */
function configuredKeys(): {
  name: MachineKeyName;
  json: string | undefined;
}[] {
  const b64 = (v: string | undefined): string | undefined =>
    v ? Buffer.from(v, "base64").toString("utf8") : undefined;
  return [
    {
      name: "management",
      json: env.ZITADEL_SERVICE_ACCOUNT_KEY ?? b64(env.ZITADEL_KEY_JSON),
    },
    {
      name: "provisioning",
      json:
        env.ZITADEL_PROVISIONING_SERVICE_ACCOUNT_KEY ??
        b64(env.ZITADEL_PROVISIONING_KEY_JSON),
    },
    { name: "notification", json: env.NOTIFICATION_ZITADEL_KEY_JSON },
  ];
}

/** keyId + userId from a key file's JSON text, or null if it isn't a service-account key. */
export function parseMachineKeyRef(
  json: string,
): { keyId: string; userId: string } | null {
  try {
    const parsed = KeyRefSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Checks every configured key. A key that isn't configured at all is left out. */
export async function checkMachineKeyExpiry(
  now: Date = new Date(),
): Promise<MachineKeyExpiry[]> {
  const neverAfter = new Date(now);
  neverAfter.setUTCFullYear(
    neverAfter.getUTCFullYear() + NEVER_EXPIRES_AFTER_YEARS,
  );

  const reports: MachineKeyExpiry[] = [];
  for (const { name, json } of configuredKeys()) {
    if (!json) continue;
    const ref = parseMachineKeyRef(json);
    if (!ref) {
      reports.push({
        name,
        keyIdSuffix: "?",
        state: "unknown",
        reason: "unreadable_key_config",
      });
      continue;
    }
    const keyIdSuffix = ref.keyId.slice(-6);
    const listed = await listMachineKeys(ref.userId);
    if (!listed.ok) {
      reports.push({
        name,
        keyIdSuffix,
        state: "unknown",
        reason: listed.reason,
      });
      continue;
    }
    const key = listed.keys.find((k) => k.id === ref.keyId);
    if (!key) {
      reports.push({ name, keyIdSuffix, state: "missing" });
    } else if (!key.expirationDate || key.expirationDate > neverAfter) {
      reports.push({ name, keyIdSuffix, state: "never_expires" });
    } else {
      reports.push({
        name,
        keyIdSuffix,
        state: "expires",
        expiresAt: key.expirationDate,
      });
    }
  }
  return reports;
}
