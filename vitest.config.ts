import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // e2e replay tests share one Chromium; run serially for stability.
    fileParallelism: false,
  },
});
