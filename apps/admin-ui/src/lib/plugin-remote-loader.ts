/**
 * Loads a plugin's Module Federation remote at runtime (3B Phase 3, R6/R12).
 *
 * A plugin's remoteEntry URL is only known at runtime (per tenant, from the
 * installed plugin's manifest) — never declared statically in admin-ui's
 * build config. admin-ui is purely a *consumer* here (it never builds its own
 * remoteEntry.js), so this uses @module-federation/runtime's dynamic
 * registerRemotes/loadRemote API directly rather than the @module-federation/vite
 * build plugin, which exists for the *producer* side of a federation pair.
 * Sourced from https://module-federation.io/guide/runtime/runtime-api
 * (registerRemotes/loadRemote signatures) and
 * https://github.com/module-federation/vite (the Vite-team/VoidZero-recommended
 * successor to @originjs/vite-plugin-federation — not used here since this app
 * has no build-time federation config, but the choice of runtime package
 * follows the same officially-recommended lineage).
 *
 * R12 (SRI): registerRemotes/loadRemote would otherwise re-fetch the entry URL
 * whenever the remote is actually loaded — verifying a hash on a fetch we then
 * discard, and letting the *real* load happen against the network again, is a
 * TOCTOU gap (the second fetch is never re-verified). This closes it the same
 * way this codebase's connector-sdk DNS-rebinding fix does: verify once, pin
 * the exact verified bytes (here, via a same-origin blob URL), and never
 * re-resolve/re-fetch the original remote URL again.
 */

import { init, registerRemotes, loadRemote } from "@module-federation/runtime";

const HOST_NAME = "admin-ui-host";

let initialized = false;

// Tracks the currently-registered blob URL per plugin slug so a reload
// (tenant switch, reinstall) revokes the previous one instead of leaking it —
// URL.createObjectURL blobs are never garbage-collected on their own.
const activeBlobUrls = new Map<string, string>();

function ensureFederationRuntimeInitialized(): void {
  if (initialized) return;
  // `remotes` is required by the type even though every plugin remote is
  // added dynamically afterward via registerRemotes — none are known yet
  // when the host initializes.
  init({ name: HOST_NAME, remotes: [] });
  initialized = true;
}

export type SriAlgorithm = "sha256" | "sha384" | "sha512";

const DIGEST_ALGORITHM: Record<SriAlgorithm, string> = {
  sha256: "SHA-256",
  sha384: "SHA-384",
  sha512: "SHA-512",
};

export interface ParsedIntegrity {
  algorithm: SriAlgorithm;
  hash: string;
}

/** Parses a standard SRI integrity string, e.g. "sha384-<base64>". */
export function parseSriIntegrity(integrity: string): ParsedIntegrity | null {
  const match = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity.trim());
  if (!match?.[1] || !match[2]) return null;
  return { algorithm: match[1] as SriAlgorithm, hash: match[2] };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Verifies `bytes` against a standard SRI integrity string. */
export async function verifyIntegrity(
  bytes: ArrayBuffer,
  integrity: string,
): Promise<boolean> {
  const parsed = parseSriIntegrity(integrity);
  if (!parsed) return false;
  const digest = await crypto.subtle.digest(
    DIGEST_ALGORITHM[parsed.algorithm],
    bytes,
  );
  return arrayBufferToBase64(digest) === parsed.hash;
}

export type LoadPluginRemoteResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Fetches a plugin's remoteEntry, verifies it against the registered SRI hash,
 * and — only if it matches — registers a same-origin blob URL of those exact
 * verified bytes as the plugin's federation remote (never the original URL,
 * closing the TOCTOU gap described above).
 */
export async function loadPluginRemote(opts: {
  pluginSlug: string;
  remoteEntryUrl: string;
  integrity: string;
}): Promise<LoadPluginRemoteResult> {
  let res: Response;
  try {
    res = await fetch(opts.remoteEntryUrl);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: `fetch failed: HTTP ${res.status}` };
  }

  const bytes = await res.arrayBuffer();
  const valid = await verifyIntegrity(bytes, opts.integrity);
  if (!valid) {
    return { ok: false, reason: "integrity mismatch" };
  }

  const pinnedUrl = URL.createObjectURL(
    new Blob([bytes], { type: "application/javascript" }),
  );

  const previousUrl = activeBlobUrls.get(opts.pluginSlug);
  if (previousUrl) {
    URL.revokeObjectURL(previousUrl);
  }
  activeBlobUrls.set(opts.pluginSlug, pinnedUrl);

  ensureFederationRuntimeInitialized();
  registerRemotes([{ name: opts.pluginSlug, entry: pinnedUrl }]);

  return { ok: true };
}

/** Loads one exposed module from an already-registered plugin remote. */
export async function loadPluginModule<T>(
  pluginSlug: string,
  exposePath: string,
): Promise<T | null> {
  return loadRemote<T>(`${pluginSlug}/${exposePath}`);
}
