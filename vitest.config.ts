import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/**/*.test.ts",
      "debug/src/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    testTimeout: 10000,
    setupFiles: ["test/setup.ts"],
  },
});
