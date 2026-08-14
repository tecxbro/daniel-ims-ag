// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

const prepared = {
  legacyMemoryId: "legacy_1",
  ownerKey: "owner_a",
  containerTag: "daniel-user-owner_a",
  contentHash: "a".repeat(64),
};

describe("memory migration control plane", () => {
  it("creates, resumes, and completes one idempotent ledger row", async () => {
    const t = convexTest(schema, modules);
    const created = await t.mutation(internal.memoryMigration.prepare, prepared);
    expect(created).toMatchObject({ action: "create", row: { status: "pending" } });

    const resumed = await t.mutation(internal.memoryMigration.prepare, prepared);
    expect(resumed).toMatchObject({ action: "resume", row: { status: "pending" } });

    await t.mutation(internal.memoryMigration.markMigrated, {
      legacyMemoryId: prepared.legacyMemoryId,
      contentHash: prepared.contentHash,
      providerMemoryId: "provider_1",
    });
    const skipped = await t.mutation(internal.memoryMigration.prepare, prepared);
    expect(skipped).toMatchObject({
      action: "skip",
      row: { status: "migrated", providerMemoryId: "provider_1" },
    });
  });

  it("rejects changed content and owner drift", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryMigration.prepare, prepared);
    await expect(
      t.mutation(internal.memoryMigration.prepare, {
        ...prepared,
        contentHash: "b".repeat(64),
      }),
    ).rejects.toThrow(/content hash changed/);
    await expect(
      t.mutation(internal.memoryMigration.prepare, {
        ...prepared,
        ownerKey: "owner_b",
      }),
    ).rejects.toThrow(/owner\/container changed/);
  });

  it("records failures and supports status reconciliation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryMigration.prepare, prepared);
    await t.mutation(internal.memoryMigration.markFailed, {
      legacyMemoryId: prepared.legacyMemoryId,
      contentHash: prepared.contentHash,
      error: "temporary provider failure",
    });
    const page = await t.query(internal.memoryMigration.listByStatus, {
      status: "failed",
      cursor: null,
      pageSize: 100,
    });
    expect(page.page).toHaveLength(1);
    expect(page.page[0]).toMatchObject({
      legacyMemoryId: "legacy_1",
      status: "failed",
      lastError: "temporary provider failure",
    });
  });

  it("exports all three legacy datasets through internal paginated queries", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryRecords", {
        memoryId: "legacy_1",
        content: "The user prefers aisle seats.",
        tier: "long",
        segment: "preference",
        importance: 0.9,
        decayRate: 0.1,
        accessCount: 1,
        lastAccessedAt: 1_000,
        lifecycle: "active",
        createdAt: 1_000,
      });
      await ctx.db.insert("memoryEvents", {
        eventType: "extract",
        data: "{}",
        createdAt: 1_000,
      });
      await ctx.db.insert("consolidationRuns", {
        runId: "run_1",
        trigger: "manual",
        status: "completed",
        proposalsCount: 1,
        mergedCount: 1,
        prunedCount: 0,
        startedAt: 1_000,
        completedAt: 2_000,
      });
    });

    const args = { cursor: null, pageSize: 1 };
    const records = await t.query(internal.memoryRecords.exportMemoryRecordsPage, args);
    const events = await t.query(internal.memoryRecords.exportMemoryEventsPage, args);
    const runs = await t.query(internal.memoryRecords.exportConsolidationRunsPage, args);
    expect(records.page[0].memoryId).toBe("legacy_1");
    expect(events.page[0].eventType).toBe("extract");
    expect(runs.page[0].runId).toBe("run_1");
  });
});
