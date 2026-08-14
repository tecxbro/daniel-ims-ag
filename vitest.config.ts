import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "convex/**/*.test.ts"],
    environment: "node",
    environmentMatchGlobs: [["convex/**/*.test.ts", "edge-runtime"]],
    testTimeout: 10000,
    setupFiles: ["test/setup.ts"],
  },
});
