import { request as nodeHttpRequest } from "node:http";
import { request as nodeHttpsRequest } from "node:https";
import { createHash } from "node:crypto";
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
  const key = hashToken(token);
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
    // ZITADEL_INTROSPECTION_URL is https:// for a real hosted Zitadel and
    // http:// for the local Docker service (zitadel:8080) — using node:http
    // unconditionally (as this previously did) sends a plain HTTP request to
    // an HTTPS-only host's default port 80, which gets redirected (301) by
    // the server instead of ever reaching /oauth/v2/introspect. Branch on
    // the actual scheme instead of assuming one.
    const isHttps = parsed.protocol === "https:";
    const request = isHttps ? nodeHttpsRequest : nodeHttpRequest;
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : isHttps ? 443 : 80,
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

  try {
    return JSON.parse(result.text) as IntrospectionResult;
  } catch {
    logger.warn(
      { status: result.status },
      "Token introspection returned unparseable body — treating as inactive",
    );
    return { active: false };
  }
}

// SHA-256 — a 32-bit djb2 hash previously used here has a large enough
// collision space (~4 billion buckets) that two distinct tokens could hash to
// the same cache key, returning the wrong token's introspection result
// (active/inactive) for up to CACHE_TTL_MS. Cryptographic hash removes that.
function hashToken(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
