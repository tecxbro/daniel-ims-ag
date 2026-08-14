// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

async function seedLegacyRows(
  t: ReturnType<typeof convexTest>,
  counts: { memoryRecords: number; memoryEvents: number; consolidationRuns: number },
) {
  await t.run(async (ctx) => {
    for (let index = 0; index < counts.memoryRecords; index += 1) {
      await ctx.db.insert("memoryRecords", {
        memoryId: `legacy-memory-${index}`,
        content: `private-memory-content-${index}`,
        tier: "long",
        segment: "knowledge",
        importance: 0.5,
        decayRate: 0.1,
        accessCount: 0,
        lastAccessedAt: 1,
        lifecycle: "active",
        createdAt: index + 1,
      });
    }
    for (let index = 0; index < counts.memoryEvents; index += 1) {
      await ctx.db.insert("memoryEvents", {
        eventType: "legacy.test",
        data: `private-event-content-${index}`,
        createdAt: index + 1,
      });
    }
    for (let index = 0; index < counts.consolidationRuns; index += 1) {
      await ctx.db.insert("consolidationRuns", {
        runId: `legacy-consolidation-${index}`,
        trigger: "test",
        status: "completed",
        proposalsCount: 0,
        mergedCount: 0,
        prunedCount: 0,
        notes: `private-consolidation-content-${index}`,
        startedAt: index + 1,
      });
    }
  });
}

describe("temporary legacy memory cleanup control plane", () => {
  it("returns bounded aggregate counts without returning row content", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyRows(t, { memoryRecords: 3, memoryEvents: 0, consolidationRuns: 0 });

    const first = await t.query(anyApi.legacyMemoryCleanup.countMemoryRecordsPage, {
      cursor: null,
      pageSize: 2,
    });
    expect(first).toMatchObject({ count: 2, isDone: false });
    expect(Object.keys(first).sort()).toEqual(["continueCursor", "count", "isDone"]);
    expect(JSON.stringify(first)).not.toContain("private-memory-content");

    const second = await t.query(anyApi.legacyMemoryCleanup.countMemoryRecordsPage, {
      cursor: first.continueCursor,
      pageSize: 2,
    });
    expect(second).toMatchObject({ count: 1, isDone: true });
  });

  it("deletes only the three permitted tables in resumable bounded batches", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyRows(t, { memoryRecords: 3, memoryEvents: 4, consolidationRuns: 2 });
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        conversationId: "sms:sentinel",
        role: "user",
        content: "ordinary application data",
        createdAt: 1,
      });
      await ctx.db.insert("memoryMigrationRows", {
        legacyMemoryId: "migration-sentinel",
        ownerKey: "owner-sentinel",
        containerTag: "container-sentinel",
        status: "pending",
        contentHash: "a".repeat(64),
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const expected = {
      runId: "cleanup-resume",
      expectedMemoryRecords: 3,
      expectedMemoryEvents: 4,
      expectedConsolidationRuns: 2,
      now: 10,
    };
    await t.mutation(anyApi.legacyMemoryCleanup.startOrResumeRun, expected);
    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.deleteMemoryRecordsBatch, {
        runId: expected.runId,
        batchSize: 2,
        now: 20,
      }),
    ).resolves.toMatchObject({ table: "memoryRecords", deleted: 2, deletedTotal: 2 });

    const resumed = await t.mutation(anyApi.legacyMemoryCleanup.startOrResumeRun, {
      ...expected,
      now: 30,
    });
    expect(resumed).toMatchObject({
      action: "resumed",
      run: { deletedMemoryRecords: 2, status: "running" },
    });

    await t.mutation(anyApi.legacyMemoryCleanup.deleteMemoryRecordsBatch, {
      runId: expected.runId,
      batchSize: 2,
    });
    await t.mutation(anyApi.legacyMemoryCleanup.deleteMemoryEventsBatch, {
      runId: expected.runId,
      batchSize: 2,
    });
    await t.mutation(anyApi.legacyMemoryCleanup.deleteMemoryEventsBatch, {
      runId: expected.runId,
      batchSize: 2,
    });
    await t.mutation(anyApi.legacyMemoryCleanup.deleteConsolidationRunsBatch, {
      runId: expected.runId,
      batchSize: 2,
    });

    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.markZeroVerified, {
        runId: expected.runId,
        now: 40,
      }),
    ).resolves.toMatchObject({
      status: "zero_verified",
      deletedMemoryRecords: 3,
      deletedMemoryEvents: 4,
      deletedConsolidationRuns: 2,
    });

    const sentinels = await t.run(async (ctx) => ({
      messages: await ctx.db.query("messages").take(10),
      migrationRows: await ctx.db.query("memoryMigrationRows").take(10),
      memoryRecords: await ctx.db.query("memoryRecords").take(1),
      memoryEvents: await ctx.db.query("memoryEvents").take(1),
      consolidationRuns: await ctx.db.query("consolidationRuns").take(1),
    }));
    expect(sentinels.messages).toHaveLength(1);
    expect(sentinels.migrationRows).toHaveLength(1);
    expect(sentinels.memoryRecords).toEqual([]);
    expect(sentinels.memoryEvents).toEqual([]);
    expect(sentinels.consolidationRuns).toEqual([]);

    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.removeVerifiedRun, { runId: expected.runId }),
    ).resolves.toEqual({ runId: expected.runId, removed: true });
    await expect(
      t.query(anyApi.legacyMemoryCleanup.getRun, { runId: expected.runId }),
    ).resolves.toBeNull();
  });

  it("rejects count drift before an oversized batch can delete anything", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyRows(t, { memoryRecords: 2, memoryEvents: 0, consolidationRuns: 0 });
    await t.mutation(anyApi.legacyMemoryCleanup.startOrResumeRun, {
      runId: "cleanup-overrun",
      expectedMemoryRecords: 1,
      expectedMemoryEvents: 0,
      expectedConsolidationRuns: 0,
    });

    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.deleteMemoryRecordsBatch, {
        runId: "cleanup-overrun",
        batchSize: 2,
      }),
    ).rejects.toThrow("would exceed expected memoryRecords count");
    const state = await t.run(async (ctx) => ({
      rows: await ctx.db.query("memoryRecords").take(10),
      run: await ctx.db
        .query("legacyMemoryCleanupRuns")
        .withIndex("by_run_id", (q) => q.eq("runId", "cleanup-overrun"))
        .take(1),
    }));
    expect(state.rows).toHaveLength(2);
    expect(state.run[0]?.deletedMemoryRecords).toBe(0);
  });

  it("requires zero verification before the checkpoint can be removed", async () => {
    const t = convexTest(schema, modules);
    await seedLegacyRows(t, { memoryRecords: 1, memoryEvents: 0, consolidationRuns: 0 });
    await t.mutation(anyApi.legacyMemoryCleanup.startOrResumeRun, {
      runId: "cleanup-unverified",
      expectedMemoryRecords: 1,
      expectedMemoryEvents: 0,
      expectedConsolidationRuns: 0,
    });

    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.markZeroVerified, {
        runId: "cleanup-unverified",
      }),
    ).rejects.toThrow("deleted counts do not match expected counts");
    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.removeVerifiedRun, {
        runId: "cleanup-unverified",
      }),
    ).rejects.toThrow("is not zero_verified");
  });

  it("cannot resume a run ID with different expected counts", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(anyApi.legacyMemoryCleanup.startOrResumeRun, {
      runId: "cleanup-fixed-counts",
      expectedMemoryRecords: 12,
      expectedMemoryEvents: 44,
      expectedConsolidationRuns: 1,
    });
    await expect(
      t.mutation(anyApi.legacyMemoryCleanup.startOrResumeRun, {
        runId: "cleanup-fixed-counts",
        expectedMemoryRecords: 13,
        expectedMemoryEvents: 44,
        expectedConsolidationRuns: 1,
      }),
    ).rejects.toThrow("expected counts do not match checkpoint");
  });
});
