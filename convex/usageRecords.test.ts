// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const usage = {
  model: "historical-model",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.01,
  durationMs: 25,
};

describe("usage telemetry", () => {
  it("keeps active telemetry writable and retired sources historical-only", async () => {
    const t = convexTest(schema, modules);
    const retired = [
      "extract",
      "consolidation-proposer",
      "consolidation-adversary",
      "consolidation-judge",
    ] as const;

    for (const source of retired) {
      await expect(
        t.mutation(api.usageRecords.record, { source, ...usage }),
      ).rejects.toThrow(/LEGACY_MEMORY_USAGE_SOURCE_FROZEN/);
    }

    await expect(
      t.mutation(api.usageRecords.record, {
        source: "dispatcher",
        conversationId: "conversation_1",
        ...usage,
      }),
    ).resolves.toBeDefined();
    await expect(t.query(api.usageRecords.recent, {})).resolves.toMatchObject([
      { source: "dispatcher", conversationId: "conversation_1" },
    ]);
  });
});
