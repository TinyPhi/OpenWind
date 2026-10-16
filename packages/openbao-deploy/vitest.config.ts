import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Each case starts a real loader process against a local HTTPS server.
    testTimeout: 30_000,
  },
});
