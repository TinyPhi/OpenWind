import { describe, it, expect } from "vitest";
import { PluginManifestSchema } from "./manifest-schema.js";

const validManifest = {
  id: "test-plugin",
  name: "Test Plugin",
  version: "0.1.0",
  platformVersion: ">=1.0.0",
  permissions: ["db:read", "ai:inference"],
};

describe("PluginManifestSchema", () => {
  it("accepts a minimal valid manifest", () => {
    expect(() => PluginManifestSchema.parse(validManifest)).not.toThrow();
  });

  it("accepts a manifest with a full ui block", () => {
    const manifest = {
      ...validManifest,
      ui: {
        remote: "https://example.com/remoteEntry.js",
        slots: [{ name: "ticket-detail-header", component: "Header" }],
        pages: [
          { path: "/plugin/test", component: "Page", title: "Test Page" },
        ],
      },
    };
    expect(() => PluginManifestSchema.parse(manifest)).not.toThrow();
  });

  it("rejects a manifest missing a required field", () => {
    const withoutPlatformVersion: Record<string, unknown> = {
      ...validManifest,
    };
    delete withoutPlatformVersion.platformVersion;
    expect(() => PluginManifestSchema.parse(withoutPlatformVersion)).toThrow();
  });

  it("rejects a manifest with an invalid permission string", () => {
    const manifest = {
      ...validManifest,
      permissions: ["not-a-real-permission"],
    };
    expect(() => PluginManifestSchema.parse(manifest)).toThrow();
  });

  it("accepts every documented permission prefix", () => {
    const manifest = {
      ...validManifest,
      permissions: [
        "db:read",
        "events:workflow.transitioned",
        "slots:ticket-detail",
        "api:read",
        "ai:inference",
        "files:read",
        "files:write",
      ],
    };
    expect(() => PluginManifestSchema.parse(manifest)).not.toThrow();
  });
});
