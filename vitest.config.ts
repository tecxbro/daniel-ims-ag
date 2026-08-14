import { defineConfig } from "vitest/config";

const shared = {
  testTimeout: 10000,
  setupFiles: ["test/setup.ts"],
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: "server",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          ...shared,
          name: "convex",
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
        },
      },
      {
        test: {
          ...shared,
          name: "dashboard",
          include: ["debug/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
        },
      },
    ],
  },
});
