import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";

vi.mock("@platform/config", () => ({
  env: { API_BODY_LIMIT_BYTES: 1024 },
}));

const { requestBodyLimit, UPLOAD_BODY_LIMIT_BYTES } =
  await import("./body-limit.js");

function makeApp(): Hono {
  const app = new Hono();
  app.use("*", requestBodyLimit());
  const echo = async (c: Context): Promise<Response> =>
    c.json({ length: (await c.req.text()).length });
  app.post("/echo", echo);
  app.post("/files", echo);
  app.put("/api/v1/attachments/:id/upload", echo);
  return app;
}

function post(
  body: string,
  contentType: string,
  withLength = true,
  path = "/echo",
  method = "POST",
): Promise<Response> {
  return Promise.resolve(
    makeApp().request(path, {
      method,
      headers: {
        "Content-Type": contentType,
        ...(withLength
          ? { "Content-Length": String(Buffer.byteLength(body)) }
          : {}),
      },
      body,
    }),
  );
}

describe("requestBodyLimit", () => {
  it("accepts a JSON body at the limit", async () => {
    const res = await post("x".repeat(1024), "application/json");
    expect(res.status).toBe(200);
  });

  it("rejects a JSON body over the limit with 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await post("x".repeat(1025), "application/json");
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  it("rejects an over-limit body that declares no Content-Length", async () => {
    const res = await post("x".repeat(4096), "application/json", false);
    expect(res.status).toBe(413);
  });

  it("gives multipart and octet-stream bodies the larger cap on the two upload routes", async () => {
    expect(UPLOAD_BODY_LIMIT_BYTES).toBeGreaterThan(1024);
    for (const [type, path, method] of [
      ["multipart/form-data; boundary=x", "/files", "POST"],
      ["application/octet-stream", "/api/v1/attachments/abc/upload", "PUT"],
    ] as const) {
      const res = await post("x".repeat(5000), type, true, path, method);
      expect(res.status).toBe(200);
    }
  });

  it("does not let an upload content type buy the larger cap on any other route", async () => {
    for (const type of [
      "multipart/form-data; boundary=x",
      "application/octet-stream",
    ]) {
      const res = await post("x".repeat(5000), type);
      expect(res.status).toBe(413);
    }
  });

  it("does not let a JSON content type borrow the upload cap", async () => {
    const res = await post("x".repeat(5000), "application/json; charset=utf-8");
    expect(res.status).toBe(413);
  });
});
