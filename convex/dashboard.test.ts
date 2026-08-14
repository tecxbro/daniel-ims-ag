// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function conversationPayload(index: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "conversation_turn",
    ingestionStrategy: "delta_turn_v1",
    providerInput: {
      content: `Conversation turn ${index}`,
      containerTag: "container",
      customId: `turn:${index}`,
      taskType: "memory",
    },
  });
}

describe("Implementation 10 dashboard operational truth", () => {
  it("treats a partial provider row and empty operational tables as valid", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryProviderState", {
        stateKey: "deployment",
        scope: "deployment",
        updatedAt: 1,
      });
    });

    const metrics = await t.query(api.dashboard.metrics, {});

    expect(metrics).not.toHaveProperty("memories");
    expect(metrics.memoryProvider).toMatchObject({
      configured: false,
      healthStatus: "unconfigured",
      hasError: false,
    });
    expect(metrics.memoryProvider).not.toHaveProperty("profileState");
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
    expect(metrics.hydration).toEqual({
      requests: 0,
      failures: 0,
      averageLatencyMs: null,
      p95UpperBoundMs: null,
      observedBuckets: 0,
    });
    expect(metrics.providerEvents).toEqual([]);
    expect(metrics.imageAnchors).toEqual({
      pending: 0,
      active: 0,
      released: 0,
      total: 0,
    });
  });

  it("summarizes provider, conversation capture, metrics, events, and image anchors", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryProviderState", {
        stateKey: "deployment",
        scope: "deployment",
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 900,
        lastFailedSubmissionAt: 1_000,
        lastError: "provider timeout",
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
          kind: "conversation_turn",
          ownerKey: "owner",
          containerTag: "container",
          customId: `turn:${index}`,
          conversationId: "demo:conversation",
          turnId: `turn:${index}`,
          payload: conversationPayload(index),
          payloadHash: String(index + 1).padStart(64, "0"),
          status: job.status,
          providerDocumentId:
            job.status === "completed" ? "provider-doc" : undefined,
          attempts: job.status === "pending" ? 0 : 1,
          nextAttemptAt: job.updatedAt,
          lastError: job.status === "failed" ? "retry me" : undefined,
          createdAt: job.updatedAt - 10,
          updatedAt: job.updatedAt,
        });
      }

      await ctx.db.insert("memoryProviderMetrics", {
        bucketStart: 500,
        requestCount: 4,
        failureCount: 1,
        totalLatencyMs: 1_000,
        latencyBuckets: [1, 1, 1, 1, 0, 0],
        updatedAt: 600,
      });
      for (const [index, operation] of (
        ["profile", "search", "documents", "entries"] as const
      ).entries()) {
        await ctx.db.insert("memoryProviderEvents", {
          eventId: `event:${operation}`,
          operation,
          outcome: index === 1 ? "failure" : "success",
          latencyMs: 100 + index,
          errorCode: index === 1 ? "timeout" : undefined,
          createdAt: 700 + index,
        });
      }

      for (const [index, status] of (
        ["pending", "active", "released"] as const
      ).entries()) {
        const storageId = await ctx.storage.store(new Blob([`image-${index}`]));
        await ctx.db.insert("memoryImageAnchors", {
          storageId,
          ownerKey: "owner",
          customId: `anchor:${status}`,
          providerDocumentId:
            status === "pending" ? undefined : `provider-image-${index}`,
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
      lastSuccessfulSubmissionAt: 900,
      lastFailedSubmissionAt: 1_000,
      lastWorkerActivityAt: 1_050,
      hasError: true,
    });
    expect(metrics.memoryProvider).not.toHaveProperty("profileState");
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
    expect(
      metrics.sync.recentJobs.every((job) => job.kind === "conversation_turn"),
    ).toBe(true);
    expect(metrics.sync.recentJobs[0]).not.toHaveProperty("payload");
    expect(metrics.sync.recentJobs[0]?.providerMemoryIds).toEqual([]);
    expect(metrics.hydration).toEqual({
      requests: 4,
      failures: 1,
      averageLatencyMs: 250,
      p95UpperBoundMs: 1_000,
      observedBuckets: 1,
    });
    expect(metrics.providerEvents.map((event) => event.operation)).toEqual([
      "entries",
      "documents",
      "search",
      "profile",
    ]);
    expect(metrics.imageAnchors).toEqual({
      pending: 1,
      active: 1,
      released: 1,
      total: 3,
    });

    await expect(t.query(api.dashboard.imageStorageStats, {})).resolves.toEqual(
      {
        count: 2,
        pending: 1,
        active: 1,
        released: 1,
        total: 3,
        truncated: false,
      },
    );
  });

  it("reports identity recovery as unconfigured without exposing identity fields", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("memoryProviderState", {
        stateKey: "deployment",
        scope: "deployment",
        healthStatus: "recovery_required",
        saltFingerprint: "server-only-fingerprint",
        pairingAuthorityProof: "server-only-proof",
        primaryOwnerKey: "opaque-owner",
        primaryContainerTag: "opaque-container",
        primaryConversationId: "sms:opaque-test-conversation",
        primaryRegisteredAt: 10,
        updatedAt: 20,
      });
    });

    const provider = (await t.query(api.dashboard.metrics, {})).memoryProvider;
    expect(provider).toMatchObject({
      configured: false,
      healthStatus: "recovery_required",
      hasError: false,
    });
    expect(provider).not.toHaveProperty("saltFingerprint");
    expect(provider).not.toHaveProperty("pairingAuthorityProof");
    expect(provider).not.toHaveProperty("primaryOwnerKey");
    expect(provider).not.toHaveProperty("primaryContainerTag");
    expect(provider).not.toHaveProperty("primaryConversationId");
  });
});
