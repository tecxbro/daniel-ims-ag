// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const pairingAuthorityProof = "b".repeat(64);

async function authorizedTest() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
    saltFingerprint: "a".repeat(32),
    pairingAuthorityProof,
  });
  return t;
}

function authorized<T extends Record<string, unknown>>(args: T) {
  return { ...args, pairingAuthorityProof };
}

function enqueueArgs(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job_001",
    kind: "conversation_turn" as const,
    ownerKey: "owner_001",
    containerTag: "daniel-user-owner001",
    customId: "daniel-conv-conversation001",
    conversationId: "sms:test-user",
    turnId: "turn_001",
    payload: JSON.stringify({
      schemaVersion: 1,
      kind: "conversation_turn",
      ingestionStrategy: "delta_turn_v1",
      providerInput: {
        content: "USER: hello\nDANIEL: hi",
        containerTag: "daniel-user-owner001",
        customId: "daniel-conv-conversation001",
      },
    }),
    payloadHash: "a".repeat(64),
    now: 1_000,
    ...overrides,
  };
}

describe("memorySyncJobs Convex transactions", () => {
  it("deduplicates a turn and rejects conflicting payloads", async () => {
    const t = await authorizedTest();
    const first = await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs());
    const duplicate = await t.mutation(
      internal.memorySyncJobs.enqueue,
      enqueueArgs({ jobId: "job_duplicate" }),
    );

    expect(first).toMatchObject({ created: true, duplicate: false });
    expect(duplicate).toMatchObject({ created: false, duplicate: true });
    await expect(
      t.mutation(
        internal.memorySyncJobs.enqueue,
        enqueueArgs({ jobId: "job_conflict", payloadHash: "b".repeat(64) }),
      ),
    ).rejects.toThrow(/different memory sync payload/);
    await expect(t.query(internal.memorySyncJobs.list, { limit: 10 })).resolves.toHaveLength(1);
  });

  it("canonicalizes uppercase SHA-256 hashes before deduplication", async () => {
    const t = await authorizedTest();
    const first = await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs({
      payloadHash: "A".repeat(64),
    }));
    const duplicate = await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs({
      jobId: "job_duplicate",
    }));

    expect(first.job.payloadHash).toBe("a".repeat(64));
    expect(duplicate).toMatchObject({ created: false, duplicate: true });
  });

  it("transactionally gives a due attempt to only one worker", async () => {
    const t = await authorizedTest();
    await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs());

    const [first, second] = await Promise.all([
      t.mutation(api.memorySyncJobs.claimDue, authorized({
        now: 1_000,
        leaseMs: 120_000,
        workerId: "worker_a",
      })),
      t.mutation(api.memorySyncJobs.claimDue, authorized({
        now: 1_000,
        leaseMs: 120_000,
        workerId: "worker_b",
      })),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(first ?? second).toMatchObject({
      resumeFrom: "dispatch",
      job: {
        jobId: "job_001",
        status: "processing",
        attempts: 1,
        nextAttemptAt: 121_000,
      },
    });
  });

  it("persists provider IDs and completes submitted work after restart", async () => {
    const t = await authorizedTest();
    await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs());
    const claimed = await t.mutation(api.memorySyncJobs.claimDue, authorized({
      now: 1_000,
      leaseMs: 120_000,
      workerId: "worker_a",
    }));
    await t.mutation(api.memorySyncJobs.recordSubmitted, authorized({
      jobId: "job_001",
      expectedAttempt: 1,
      expectedUpdatedAt: claimed!.job.updatedAt,
      providerDocumentId: "doc_001",
      now: 1_100,
    }));

    const resumed = await t.mutation(api.memorySyncJobs.claimDue, authorized({
      now: 121_001,
      leaseMs: 120_000,
      workerId: "worker_restart",
    }));
    expect(resumed).toMatchObject({
      resumeFrom: "complete",
      job: { status: "submitted", providerDocumentId: "doc_001", attempts: 1 },
    });
    await t.mutation(api.memorySyncJobs.complete, authorized({
      jobId: "job_001",
      expectedAttempt: resumed!.job.attempts,
      expectedUpdatedAt: resumed!.job.updatedAt,
      now: 121_002,
    }));
    const [job] = await t.query(internal.memorySyncJobs.list, {
      status: "completed",
      limit: 10,
    });
    expect(job).toMatchObject({
      jobId: "job_001",
      status: "completed",
      providerDocumentId: "doc_001",
      attempts: 1,
    });
  });

  it("enforces the fixed retry schedule and dead-letter transition", async () => {
    const t = await authorizedTest();
    await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs());
    let dueAt = 1_000;
    const delays = [10_000, 60_000, 300_000, 1_800_000];

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await t.mutation(api.memorySyncJobs.claimDue, authorized({
        now: dueAt,
        leaseMs: 120_000,
        workerId: "worker_retry",
      }));
      expect(claimed).toMatchObject({ job: { attempts: attempt } });
      const result = await t.mutation(api.memorySyncJobs.recordFailure, authorized({
        jobId: "job_001",
        expectedAttempt: attempt,
        expectedUpdatedAt: claimed!.job.updatedAt,
        error: "temporary provider outage",
        retryable: true,
        now: dueAt,
      }));
      if (attempt < 5) {
        dueAt += delays[attempt - 1];
        expect(result).toMatchObject({
          updated: true,
          deadLettered: false,
          nextAttemptAt: dueAt,
        });
      } else {
        expect(result).toMatchObject({ updated: true, deadLettered: true });
      }
    }

    const [job] = await t.query(internal.memorySyncJobs.list, { status: "dead_letter", limit: 10 });
    expect(job).toMatchObject({ status: "dead_letter", attempts: 5 });
  });

  it("reclaims an expired lease and rejects stale completion", async () => {
    const t = await authorizedTest();
    await t.mutation(internal.memorySyncJobs.enqueue, enqueueArgs());
    const first = await t.mutation(api.memorySyncJobs.claimDue, authorized({
      now: 1_000,
      leaseMs: 10_000,
      workerId: "worker_a",
    }));
    expect(await t.mutation(api.memorySyncJobs.claimDue, authorized({
      now: 10_999,
      leaseMs: 10_000,
      workerId: "worker_b",
    }))).toBeNull();
    const reclaimed = await t.mutation(api.memorySyncJobs.claimDue, authorized({
      now: 11_000,
      leaseMs: 10_000,
      workerId: "worker_b",
    }));

    expect(reclaimed).toMatchObject({ job: { attempts: 2 } });
    expect(await t.mutation(api.memorySyncJobs.complete, authorized({
      jobId: "job_001",
      expectedAttempt: first!.job.attempts,
      expectedUpdatedAt: first!.job.updatedAt,
      now: 11_001,
    }))).toMatchObject({ updated: false });
    expect(await t.mutation(api.memorySyncJobs.complete, authorized({
      jobId: "job_001",
      expectedAttempt: reclaimed!.job.attempts,
      expectedUpdatedAt: reclaimed!.job.updatedAt,
      now: 11_001,
    }))).toMatchObject({ updated: true });
  });

  it("rejects a foreign retry and requeues only the exact owned job", async () => {
    const t = await authorizedTest();
    await t.mutation(
      internal.memorySyncJobs.enqueue,
      enqueueArgs({ jobId: "job_owned" }),
    );
    const claimed = await t.mutation(api.memorySyncJobs.claimDue, authorized({
      now: 1_000,
      workerId: "worker_a",
      leaseMs: 1_000,
    }));
    await t.mutation(api.memorySyncJobs.recordFailure, authorized({
      jobId: "job_owned",
      expectedAttempt: claimed!.job.attempts,
      expectedUpdatedAt: claimed!.job.updatedAt,
      error: "retryable",
      retryable: true,
      now: 2_000,
      nextAttemptAt: 12_000,
    }));

    await expect(
      t.mutation(api.memorySyncJobs.retryOwned, authorized({
        jobId: "job_owned",
        ownerKey: "owner_b",
        containerTag: "daniel-user-owner_b",
        expectedStatus: "failed",
        now: 3_000,
      })),
    ).resolves.toMatchObject({ retried: false, reason: "not_found", job: null });
    await expect(
      t.mutation(api.memorySyncJobs.retryOwned, authorized({
        jobId: "job_owned",
        ownerKey: "owner_001",
        containerTag: "daniel-user-owner001",
        expectedStatus: "failed",
        now: 3_000,
      })),
    ).resolves.toMatchObject({
      retried: true,
      reason: "requeued",
      job: { status: "pending", attempts: 0, nextAttemptAt: 3_000 },
    });
  });
});
