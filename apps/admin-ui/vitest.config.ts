import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // #873: under the full parallel `pnpm test` (about 40 packages at once) individual admin-ui
    // tests intermittently hit vitest's 5000ms default and fail with "Test timed out", then pass
    // when the suite runs alone. The slowest test takes about 0.55s unloaded, so a failure at 5s
    // means a ~10x slowdown from machine contention, not a slow test. 15s keeps a real hang
    // failing while leaving ~30x headroom.
    testTimeout: 15_000,
  },
});
