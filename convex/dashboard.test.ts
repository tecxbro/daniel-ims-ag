// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

describe("Implementation 9 dashboard operational truth", () => {
  it("reports an explicit unconfigured state without legacy memory metrics", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryRecords", {
        memoryId: "legacy-memory-that-must-not-drive-the-dashboard",
        content: "Historical Convex memory",
        tier: "permanent",
        segment: "knowledge",
        importance: 1,
        decayRate: 0,
        accessCount: 1,
        lastAccessedAt: 1,
        lifecycle: "active",
        createdAt: 1,
      });
    });

    const metrics = await t.query(api.dashboard.metrics, {});

    expect(metrics).not.toHaveProperty("memories");
    expect(metrics.memoryProvider).toEqual({
      configured: false,
      healthStatus: "unconfigured",
      readMode: "convex",
      writeMode: "convex",
      lastSuccessfulSubmissionAt: undefined,
      lastFailedSubmissionAt: undefined,
      lastWorkerActivityAt: undefined,
      lastError: undefined,
      profileState: "unavailable",
    });
    expect(metrics.sync).toMatchObject({
      pending: 0,
      processing: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      active: 0,
      total: 0,
      captureCompletionRate: null,
      recentJobs: [],
    });
    expect(metrics.migration).toEqual({
      pending: 0,
      migrated: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      reconciled: false,
    });
    expect(metrics.imageAnchors).toEqual({ pending: 0, active: 0, released: 0, total: 0 });
  });

  it("summarizes indexed provider, sync, migration, and image-anchor state", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryProviderState", {
        stateKey: "deployment",
        scope: "deployment",
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 900,
        lastFailedSubmissionAt: 1_000,
        lastError: "provider timeout",
        readMode: "supermemory",
        writeMode: "dual",
        lastWorkerActivityAt: 1_050,
        updatedAt: 1_050,
      });

      const jobs = [
        { id: "pending", status: "pending" as const, updatedAt: 100 },
        { id: "processing", status: "processing" as const, updatedAt: 200 },
        { id: "submitted", status: "submitted" as const, updatedAt: 300 },
        { id: "completed", status: "completed" as const, updatedAt: 600 },
        { id: "failed", status: "failed" as const, updatedAt: 500 },
        { id: "dead", status: "dead_letter" as const, updatedAt: 400 },
      ];
      for (const [index, job] of jobs.entries()) {
        await ctx.db.insert("memorySyncJobs", {
          jobId: `job:${job.id}`,
          kind: index === 5 ? "image" : "conversation_turn",
          ownerKey: "owner",
          containerTag: "container",
          payload: '{"safe":true}',
          payloadHash: String(index + 1).padStart(64, "0"),
          status: job.status,
          providerDocumentId: job.status === "completed" ? "provider-doc" : undefined,
          attempts: job.status === "pending" ? 0 : 1,
          nextAttemptAt: job.updatedAt,
          lastError: job.status === "failed" ? "retry me" : undefined,
          createdAt: job.updatedAt - 10,
          updatedAt: job.updatedAt,
        });
      }

      for (const [index, status] of (["migrated", "skipped"] as const).entries()) {
        await ctx.db.insert("memoryMigrationRows", {
          legacyMemoryId: `legacy:${index}`,
          ownerKey: "owner",
          containerTag: "container",
          status,
          providerDocumentId: status === "migrated" ? "provider-migration-doc" : undefined,
          contentHash: String(index + 10).padStart(64, "0"),
          createdAt: 100,
          updatedAt: 200,
        });
      }

      for (const [index, status] of (["pending", "active", "released"] as const).entries()) {
        const storageId = await ctx.storage.store(new Blob([`image-${index}`]));
        await ctx.db.insert("memoryImageAnchors", {
          storageId,
          ownerKey: "owner",
          customId: `anchor:${status}`,
          providerDocumentId: status === "pending" ? undefined : `provider-image-${index}`,
          status,
          reason: "dashboard test",
          createdAt: 100 + index,
          releasedAt: status === "released" ? 300 : undefined,
        });
      }
    });

    const metrics = await t.query(api.dashboard.metrics, {});

    expect(metrics.memoryProvider).toEqual({
      configured: true,
      healthStatus: "degraded",
      readMode: "supermemory",
      writeMode: "dual",
      lastSuccessfulSubmissionAt: 900,
      lastFailedSubmissionAt: 1_000,
      lastWorkerActivityAt: 1_050,
      lastError: "provider timeout",
      profileState: "unavailable",
    });
    expect(metrics.sync).toMatchObject({
      pending: 1,
      processing: 1,
      submitted: 1,
      completed: 1,
      failed: 1,
      deadLetter: 1,
      active: 4,
      total: 6,
      captureCompletionRate: 1 / 3,
    });
    expect(metrics.sync.recentJobs.map((job) => job.jobId)).toEqual([
      "job:completed",
      "job:failed",
      "job:dead",
      "job:submitted",
      "job:processing",
      "job:pending",
    ]);
    expect(metrics.sync.recentJobs[0]).not.toHaveProperty("payload");
    expect(metrics.sync.recentJobs[0]?.providerMemoryIds).toEqual([]);
    expect(metrics.migration).toEqual({
      pending: 0,
      migrated: 1,
      failed: 0,
      skipped: 1,
      total: 2,
      reconciled: true,
    });
    expect(metrics.imageAnchors).toEqual({ pending: 1, active: 1, released: 1, total: 3 });

    await expect(t.query(api.dashboard.imageStorageStats, {})).resolves.toEqual({
      count: 2,
      pending: 1,
      active: 1,
      released: 1,
      total: 3,
      truncated: false,
    });
  });
});
