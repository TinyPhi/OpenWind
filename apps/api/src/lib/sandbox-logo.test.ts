import { describe, it, expect } from "vitest";
import { SandboxLogoSchema, MAX_SANDBOX_LOGO_BYTES } from "./sandbox-logo.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBPVP8 ", "latin1"),
]);

function url(type: string, bytes: Buffer): string {
  return `data:image/${type};base64,${bytes.toString("base64")}`;
}

describe("SandboxLogoSchema", () => {
  it.each([
    ["png", PNG],
    ["jpeg", JPEG],
    ["webp", WEBP],
  ])("accepts a %s whose bytes match", (type, bytes) => {
    expect(SandboxLogoSchema.safeParse(url(type, bytes)).success).toBe(true);
  });

  it.each([
    ["an SVG", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["a gif", url("gif", Buffer.from("GIF89a"))],
    ["a remote URL", "https://example.com/logo.png"],
    ["markup after the prefix", 'data:image/png;base64,AAAA"><script>'],
    ["an empty payload", "data:image/png;base64,"],
  ])("rejects %s", (_label, value) => {
    expect(SandboxLogoSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a declared type that the bytes contradict", () => {
    expect(SandboxLogoSchema.safeParse(url("png", JPEG)).success).toBe(false);
    expect(SandboxLogoSchema.safeParse(url("webp", PNG)).success).toBe(false);
    expect(
      SandboxLogoSchema.safeParse(url("png", Buffer.from("<svg></svg>")))
        .success,
    ).toBe(false);
  });

  it("accepts a file at the size limit and rejects one byte over", () => {
    const atLimit = Buffer.concat([
      PNG,
      Buffer.alloc(MAX_SANDBOX_LOGO_BYTES - PNG.length),
    ]);
    const over = Buffer.concat([atLimit, Buffer.alloc(1)]);

    expect(SandboxLogoSchema.safeParse(url("png", atLimit)).success).toBe(true);
    expect(SandboxLogoSchema.safeParse(url("png", over)).success).toBe(false);
  });
});
