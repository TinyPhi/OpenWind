import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Same as packages/db: workspace packages are inlined, so a test that
    // imports one un-mocked gets the source, not a second copy.
    server: {
      deps: {
        inline: [/@platform\/.*/],
      },
    },
  },
});
