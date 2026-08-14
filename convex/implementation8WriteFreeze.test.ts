// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const legacyMemoryArgs = {
  memoryId: "legacy_memory_1",
  content: "The user prefers aisle seats.",
  tier: "long" as const,
  segment: "preference" as const,
  importance: 0.9,
  decayRate: 0.1,
};

const usageArgs = {
  model: "historical-model",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.01,
  durationMs: 25,
};

describe("Implementation 8 legacy Convex write freeze", () => {
  it("keeps historical rows readable and migration reconciliation writable", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryRecords", {
        ...legacyMemoryArgs,
        accessCount: 2,
        lastAccessedAt: 1_000,
        lifecycle: "active",
        createdAt: 1_000,
      });
      await ctx.db.insert("memoryEvents", {
        eventType: "extract",
        conversationId: "conversation_1",
        memoryId: legacyMemoryArgs.memoryId,
        data: "{}",
        createdAt: 1_000,
      });
      await ctx.db.insert("consolidationRuns", {
        runId: "legacy_run_1",
        trigger: "scheduled",
        status: "completed",
        proposalsCount: 1,
        mergedCount: 1,
        prunedCount: 0,
        startedAt: 1_000,
        completedAt: 2_000,
      });
      await ctx.db.insert("usageRecords", {
        source: "extract",
        ...usageArgs,
        createdAt: 1_000,
      });
      await ctx.db.insert("usageRecords", {
        source: "consolidation-judge",
        runId: "legacy_run_1",
        ...usageArgs,
        createdAt: 2_000,
      });
    });

    await expect(t.query(api.memoryRecords.list, {})).resolves.toMatchObject([
      { memoryId: legacyMemoryArgs.memoryId, lifecycle: "active" },
    ]);
    await expect(t.query(api.memoryEvents.recent, {})).resolves.toMatchObject([
      { eventType: "extract", memoryId: legacyMemoryArgs.memoryId },
    ]);
    await expect(t.query(api.consolidation.listRuns, {})).resolves.toMatchObject([
      { runId: "legacy_run_1", status: "completed" },
    ]);
    const historicalUsage = await t.query(api.usageRecords.recent, {});
    expect(historicalUsage.map((row) => row.source)).toEqual([
      "consolidation-judge",
      "extract",
    ]);

    const exportedRecords = await t.query(internal.memoryRecords.exportMemoryRecordsPage, {
      cursor: null,
      pageSize: 10,
    });
    expect(exportedRecords.page).toMatchObject([
      { memoryId: legacyMemoryArgs.memoryId },
    ]);

    const reconciliation = {
      legacyMemoryId: legacyMemoryArgs.memoryId,
      ownerKey: "owner_1",
      containerTag: "daniel-user-owner_1",
      contentHash: "a".repeat(64),
    };
    await expect(
      t.mutation(internal.memoryMigration.prepare, reconciliation),
    ).resolves.toMatchObject({ action: "create", row: { status: "pending" } });
    await expect(
      t.mutation(internal.memoryMigration.markMigrated, {
        legacyMemoryId: reconciliation.legacyMemoryId,
        contentHash: reconciliation.contentHash,
        providerMemoryId: "provider_memory_1",
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });

  it("rejects every normal legacy memory, event, and consolidation write", async () => {
    const t = convexTest(schema, modules);
    const frozen = /LEGACY_MEMORY_WRITE_FROZEN/;

    await expect(t.mutation(api.memoryRecords.upsert, legacyMemoryArgs)).rejects.toThrow(frozen);
    await expect(
      t.mutation(api.memoryRecords.markAccessed, { memoryId: legacyMemoryArgs.memoryId }),
    ).rejects.toThrow(frozen);
    await expect(
      t.mutation(api.memoryRecords.setLifecycle, {
        memoryId: legacyMemoryArgs.memoryId,
        lifecycle: "archived",
      }),
    ).rejects.toThrow(frozen);
    await expect(
      t.mutation(api.memoryRecords.setEmbedding, {
        memoryId: legacyMemoryArgs.memoryId,
        embedding: [0.1, 0.2],
      }),
    ).rejects.toThrow(frozen);
    await expect(
      t.mutation(api.memoryEvents.emit, { eventType: "extract", data: "{}" }),
    ).rejects.toThrow(frozen);
    await expect(
      t.mutation(api.consolidation.createRun, {
        runId: "new_run",
        trigger: "scheduled",
      }),
    ).rejects.toThrow(frozen);
    await expect(
      t.mutation(api.consolidation.updateRun, {
        runId: "legacy_run_1",
        status: "failed",
      }),
    ).rejects.toThrow(frozen);

    await t.run(async (ctx) => {
      expect(await ctx.db.query("memoryRecords").take(1)).toEqual([]);
      expect(await ctx.db.query("memoryEvents").take(1)).toEqual([]);
      expect(await ctx.db.query("consolidationRuns").take(1)).toEqual([]);
    });
  });

  it("keeps active usage telemetry writable but makes retired sources historical-only", async () => {
    const t = convexTest(schema, modules);
    const frozen = /LEGACY_MEMORY_USAGE_SOURCE_FROZEN/;
    const retiredSources = [
      "extract",
      "consolidation-proposer",
      "consolidation-adversary",
      "consolidation-judge",
    ] as const;

    for (const source of retiredSources) {
      await expect(
        t.mutation(api.usageRecords.record, { source, ...usageArgs }),
      ).rejects.toThrow(frozen);
    }

    await expect(
      t.mutation(api.usageRecords.record, {
        source: "dispatcher",
        conversationId: "conversation_1",
        ...usageArgs,
      }),
    ).resolves.toBeDefined();
    await expect(t.query(api.usageRecords.recent, {})).resolves.toMatchObject([
      { source: "dispatcher", conversationId: "conversation_1" },
    ]);
  });
});
