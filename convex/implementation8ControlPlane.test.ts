// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

describe("Implementation 8 owner-scoped control plane", () => {
  it("returns aggregate migration and image-anchor verification for one owner", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryMigrationRows", {
        legacyMemoryId: "legacy-a",
        ownerKey: "owner-a",
        containerTag: "daniel-user-owner-a",
        status: "migrated",
        providerMemoryId: "provider-a",
        contentHash: "a".repeat(64),
        createdAt: 1,
        updatedAt: 2,
      });
      await ctx.db.insert("memoryMigrationRows", {
        legacyMemoryId: "legacy-b",
        ownerKey: "owner-a",
        containerTag: "daniel-user-owner-a",
        status: "skipped",
        contentHash: "b".repeat(64),
        createdAt: 1,
        updatedAt: 2,
      });
      await ctx.db.insert("memoryMigrationRows", {
        legacyMemoryId: "legacy-foreign",
        ownerKey: "owner-b",
        containerTag: "daniel-user-owner-b",
        status: "failed",
        contentHash: "c".repeat(64),
        createdAt: 1,
        updatedAt: 2,
      });

      const activeStorageId = await ctx.storage.store(new Blob(["active"]));
      const pendingStorageId = await ctx.storage.store(new Blob(["pending"]));
      await ctx.db.insert("memoryImageAnchors", {
        storageId: activeStorageId,
        ownerKey: "owner-a",
        customId: "image-active",
        providerDocumentId: "document-a",
        status: "active",
        reason: "test",
        createdAt: 1,
      });
      await ctx.db.insert("memoryImageAnchors", {
        storageId: pendingStorageId,
        ownerKey: "owner-a",
        customId: "image-pending",
        status: "pending",
        reason: "test",
        createdAt: 1,
      });
    });

    await expect(
      t.query(api.memoryMigration.verifyOwnerCutover, {
        ownerKey: "owner-a",
        containerTag: "daniel-user-owner-a",
      }),
    ).resolves.toMatchObject({
      total: 2,
      pending: 0,
      migrated: 1,
      failed: 0,
      skipped: 1,
      migratedWithoutProviderId: 0,
      truncated: false,
      reconciled: true,
    });
    await expect(
      t.query(api.memoryImageAnchors.getOwnerSummary, { ownerKey: "owner-a" }),
    ).resolves.toMatchObject({
      pending: 1,
      active: 1,
      released: 0,
      activeWithoutProviderId: 0,
      truncated: false,
    });
  });

  it("atomically rejects a foreign retry and requeues the exact owned job", async () => {
    const t = convexTest(schema, modules);
    const enqueue = await t.mutation(api.memorySyncJobs.enqueue, {
      jobId: "job-a",
      kind: "conversation_turn",
      ownerKey: "owner-a",
      containerTag: "daniel-user-owner-a",
      turnId: "turn-a",
      payload: "{}",
      payloadHash: "d".repeat(64),
      now: 100,
    });
    const claimed = await t.mutation(api.memorySyncJobs.claimDue, {
      now: 100,
      workerId: "worker-a",
      leaseMs: 1_000,
    });
    expect(claimed?.job.jobId).toBe(enqueue.job.jobId);
    await t.mutation(api.memorySyncJobs.recordFailure, {
      jobId: "job-a",
      expectedAttempt: claimed!.job.attempts,
      expectedUpdatedAt: claimed!.job.updatedAt,
      error: "retryable",
      retryable: true,
      now: 200,
      nextAttemptAt: 10_200,
    });

    await expect(
      t.mutation(api.memorySyncJobs.retryOwned, {
        jobId: "job-a",
        ownerKey: "owner-b",
        containerTag: "daniel-user-owner-b",
        expectedStatus: "failed",
        now: 300,
      }),
    ).resolves.toMatchObject({ retried: false, reason: "not_found", job: null });
    await expect(
      t.mutation(api.memorySyncJobs.retryOwned, {
        jobId: "job-a",
        ownerKey: "owner-a",
        containerTag: "daniel-user-owner-a",
        expectedStatus: "failed",
        now: 300,
      }),
    ).resolves.toMatchObject({
      retried: true,
      reason: "requeued",
      job: { status: "pending", attempts: 0, nextAttemptAt: 300 },
    });
  });
});
