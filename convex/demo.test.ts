// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import type { Id } from "./_generated/dataModel.js";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

describe("Implementation 9 dashboard demo state", () => {
  it("seeds only namespaced SuperMemory operational state and cleans it up", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);

    await expect(t.query(api.demo.status, {})).resolves.toMatchObject({
      enabled: false,
      seeded: false,
      total: 0,
      counts: {
        providerStates: 0,
        syncJobs: 0,
        migrationRows: 0,
        imageAnchors: 0,
      },
    });

    const enabled = await t.mutation(api.demo.setMode, { enabled: true });
    expect(enabled).toMatchObject({
      enabled: true,
      total: 17,
      seeded: {
        providerStates: 2,
        syncJobs: 10,
        migrationRows: 5,
        imageAnchors: 0,
      },
      counts: {
        agents: 0,
        agentLogs: 0,
        memories: 0,
        automationRuns: 0,
      },
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await expect(t.query(api.demo.status, {})).resolves.toMatchObject({
      enabled: true,
      seeded: true,
      total: 20,
    });
    const metrics = await t.query(api.dashboard.metrics, {});
    expect(metrics.memoryProvider).toMatchObject({
      configured: true,
      healthStatus: "healthy",
      readMode: "supermemory",
      writeMode: "supermemory",
      profileState: "unavailable",
    });
    expect(metrics.sync).toMatchObject({
      pending: 2,
      processing: 1,
      submitted: 1,
      completed: 4,
      failed: 1,
      deadLetter: 1,
      total: 10,
    });
    expect(metrics.migration).toMatchObject({
      pending: 1,
      migrated: 2,
      failed: 1,
      skipped: 1,
      reconciled: false,
    });
    expect(metrics.imageAnchors).toEqual({ pending: 1, active: 1, released: 1, total: 3 });

    const legacyRows = await t.run(async (ctx) => ({
      memories: await ctx.db.query("memoryRecords").take(1),
      events: await ctx.db.query("memoryEvents").take(1),
      consolidations: await ctx.db.query("consolidationRuns").take(1),
    }));
    expect(legacyRows).toEqual({ memories: [], events: [], consolidations: [] });

    const storageIds = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("memoryImageAnchors")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .take(10);
      return rows.map((row) => row.storageId);
    });
    expect(storageIds).toHaveLength(1);

    const reseeded = await t.mutation(api.demo.setMode, { enabled: true });
    expect(reseeded).toMatchObject({
      removed: { providerStates: 2, syncJobs: 10, migrationRows: 5, imageAnchors: 3 },
      seeded: { providerStates: 2, syncJobs: 10, migrationRows: 5, imageAnchors: 0 },
      total: 17,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const disabled = await t.mutation(api.demo.setMode, { enabled: false });
    expect(disabled).toMatchObject({
      enabled: false,
      removed: { providerStates: 2, syncJobs: 10, migrationRows: 5, imageAnchors: 3 },
      seeded: null,
      total: 0,
    });
    await expect(t.query(api.demo.status, {})).resolves.toMatchObject({
      enabled: false,
      seeded: false,
      total: 0,
    });

    await t.run(async (ctx) => {
      for (const storageId of storageIds) {
        expect(
          await ctx.db.system.get("_storage", storageId as Id<"_storage">),
        ).toBeNull();
      }
    });
    vi.useRealTimers();
  });
});
