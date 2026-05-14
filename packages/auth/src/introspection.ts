import { env } from "@platform/config";
import { logger } from "@platform/logger";
import type { IntrospectionResult } from "./types.js";

// 60-second cache: token hash → { result, expiresAt }
const cache = new Map<
  string,
  { result: IntrospectionResult; expiresAt: number }
>();

const CACHE_TTL_MS = 60_000;

export async function introspectToken(
  token: string,
): Promise<IntrospectionResult> {
  const key = simpleHash(token);
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = await callIntrospectionEndpoint(token);
  cache.set(key, { result, expiresAt: now + CACHE_TTL_MS });

  // Prune entries older than 2x TTL to prevent unbounded growth
  if (cache.size > 1000) {
    for (const [k, v] of cache.entries()) {
      if (v.expiresAt < now) cache.delete(k);
    }
  }

  return result;
}

async function callIntrospectionEndpoint(
  token: string,
): Promise<IntrospectionResult> {
  const url = env.ZITADEL_INTROSPECTION_URL;
  const clientId = env.ZITADEL_INTROSPECTION_CLIENT_ID;
  const clientSecret = env.ZITADEL_INTROSPECTION_CLIENT_SECRET;

  const body = new URLSearchParams({ token });
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: body.toString(),
    });
  } catch (err) {
    logger.error({ error: String(err) }, "Token introspection request failed");
    return { active: false };
  }

  if (!resp.ok) {
    logger.warn(
      { status: resp.status },
      "Token introspection returned non-2xx",
    );
    return { active: false };
  }

  return (await resp.json()) as IntrospectionResult;
}

// djb2 hash — good enough for an in-process cache key
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // djb2: h * 33 ^ c
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // force unsigned 32-bit
  }
  return h.toString(16);
}
