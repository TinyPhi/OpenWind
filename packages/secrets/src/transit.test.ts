import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEnv: Record<string, string | undefined> = {};

vi.mock("@platform/config", () => ({ env: mockEnv }));
vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { decryptCredential } = await import("./transit.js");
const { encryptCredentialLocal } = await import("./local.js");

beforeEach(() => {
  for (const k of Object.keys(mockEnv)) delete mockEnv[k];
});

describe("decryptCredential — local: ciphertext", () => {
  it("decrypts local: ciphertext outside production", async () => {
    mockEnv["NODE_ENV"] = "development";
    const ciphertext = await encryptCredentialLocal("tenant-a", "s3cret");

    await expect(decryptCredential("tenant-a", ciphertext)).resolves.toBe(
      "s3cret",
    );
  });

  it("refuses local: ciphertext in production", async () => {
    mockEnv["NODE_ENV"] = "production";
    const ciphertext = await encryptCredentialLocal("tenant-a", "s3cret");

    await expect(decryptCredential("tenant-a", ciphertext)).rejects.toThrow(
      "Refusing to decrypt 'local:' ciphertext in production",
    );
  });
});
