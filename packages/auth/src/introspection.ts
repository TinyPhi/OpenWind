import { request as nodeHttpRequest } from "node:http";
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

// node:http request so we can set a custom Host header.
// Node.js fetch treats Host as a forbidden header and ignores it — Zitadel
// routes by Host header so we must send Host matching EXTERNALDOMAIN even
// when connecting via the internal Docker service name (zitadel:8080).
function httpPostForm(
  url: string,
  hostOverride: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyBuf = Buffer.from(body);
    const req = nodeHttpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          ...headers,
          Host: hostOverride,
          "Content-Length": bodyBuf.length.toString(),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data }),
        );
      },
    );
    req.setTimeout(10_000, () => {
      req.destroy(new Error("Introspection request timed out"));
    });
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function callIntrospectionEndpoint(
  token: string,
): Promise<IntrospectionResult> {
  const url = env.ZITADEL_INTROSPECTION_URL;
  const clientId = env.ZITADEL_INTROSPECTION_CLIENT_ID;
  const clientSecret = env.ZITADEL_INTROSPECTION_CLIENT_SECRET;

  // Host header must match EXTERNALDOMAIN — extract from ZITADEL_ISSUER
  const issuerHost = new URL(env.ZITADEL_ISSUER).hostname;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  let result: { status: number; text: string };
  try {
    result = await httpPostForm(
      url,
      issuerHost,
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      new URLSearchParams({ token }).toString(),
    );
  } catch (err) {
    logger.error({ error: String(err) }, "Token introspection request failed");
    return { active: false };
  }

  if (result.status < 200 || result.status >= 300) {
    logger.warn(
      { status: result.status },
      "Token introspection returned non-2xx",
    );
    return { active: false };
  }

  return JSON.parse(result.text) as IntrospectionResult;
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
