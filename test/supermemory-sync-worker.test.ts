import { describe, expect, it, vi } from "vitest";
import {
  ConvexMemorySyncPersistence,
  MEMORY_SYNC_RETRY_DELAYS_MS,
  MemorySyncWorker,
  retryDelayAfterAttempt,
  startConfiguredMemorySyncWorker,
  type ClaimedMemorySyncJob,
  type CompleteMemorySyncJobInput,
  type MemoryProviderStateWriter,
  type MemorySyncJob,
  type MemorySyncJobsStore,
  type RecordMemorySyncFailureInput,
  type RecordSubmittedInput,
} from "../server/memory/supermemory/sync-worker.js";
import { SupermemoryProviderError } from "../server/memory/supermemory/client.js";

function conversationJob(overrides: Partial<MemorySyncJob> = {}): MemorySyncJob {
  return {
    jobId: "job_001",
    kind: "conversation_turn",
    ownerKey: "owner_001",
    containerTag: "daniel-user-owner001",
    customId: "daniel-conv-conversation001",
    conversationId: "sms:test-user",
    turnId: "turn_001",
    payload: JSON.stringify({
      schemaVersion: 1,
      ingestionStrategy: "delta_turn_v1",
      providerInput: {
        content: "Conversation between the user and Daniel.\nTurn: turn_001\n\nUSER: hi\n\nDANIEL: hello",
        containerTag: "daniel-user-owner001",
        customId: "daniel-conv-conversation001",
        taskType: "memory",
        metadata: { source: "daniel", kind: "conversation_turn" },
      },
    }),
    payloadHash: "a".repeat(64),
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

class InMemoryJobs implements MemorySyncJobsStore {
  readonly jobs: MemorySyncJob[];
  readonly failures: RecordMemorySyncFailureInput[] = [];

  constructor(jobs: MemorySyncJob[]) {
    this.jobs = jobs;
  }

  async claimDue(input: { now: number; leaseMs: number }): Promise<ClaimedMemorySyncJob | null> {
    const submitted = this.jobs.find(
      (job) => job.status === "submitted" && job.nextAttemptAt <= input.now,
    );
    if (submitted) return { job: { ...submitted }, resumeFrom: "complete" };

    const job = this.jobs.find(
      (candidate) =>
        ["pending", "failed", "processing"].includes(candidate.status) &&
        candidate.nextAttemptAt <= input.now,
    );
    if (!job) return null;
    job.status = "processing";
    job.attempts += 1;
    job.nextAttemptAt = input.now + input.leaseMs;
    job.updatedAt = Math.max(input.now, job.updatedAt + 1);
    return { job: { ...job }, resumeFrom: "dispatch" };
  }

  async recordSubmitted(input: RecordSubmittedInput) {
    const job = this.jobs.find((candidate) => candidate.jobId === input.jobId);
    if (
      !job ||
      job.attempts !== input.expectedAttempt ||
      job.updatedAt !== input.expectedUpdatedAt ||
      job.status !== "processing"
    ) {
      return { updated: false };
    }
    job.status = "submitted";
    job.providerDocumentId = input.providerDocumentId;
    job.providerMemoryIds = input.providerMemoryIds;
    job.updatedAt = Math.max(input.now, job.updatedAt + 1);
    return { updated: true, job: { ...job } };
  }

  async complete(input: CompleteMemorySyncJobInput) {
    const job = this.jobs.find((candidate) => candidate.jobId === input.jobId);
    if (
      !job ||
      job.attempts !== input.expectedAttempt ||
      job.updatedAt !== input.expectedUpdatedAt
    ) return { updated: false };
    job.status = "completed";
    job.nextAttemptAt = input.now;
    job.updatedAt = Math.max(input.now, job.updatedAt + 1);
    return { updated: true, job: { ...job } };
  }

  async recordFailure(input: RecordMemorySyncFailureInput) {
    const job = this.jobs.find((candidate) => candidate.jobId === input.jobId);
    if (
      !job ||
      job.attempts !== input.expectedAttempt ||
      job.updatedAt !== input.expectedUpdatedAt ||
      job.status !== "processing"
    ) {
      return { updated: false };
    }
    this.failures.push(input);
    job.status = input.deadLetter ? "dead_letter" : "failed";
    job.nextAttemptAt = input.nextAttemptAt ?? input.now;
    job.lastError = input.error;
    job.updatedAt = Math.max(input.now, job.updatedAt + 1);
    return { updated: true, job: { ...job } };
  }
}

function providerState(): MemoryProviderStateWriter & {
  successes: unknown[];
  failures: unknown[];
  heartbeats: unknown[];
} {
  const successes: unknown[] = [];
  const failures: unknown[] = [];
  const heartbeats: unknown[] = [];
  return {
    successes,
    failures,
    heartbeats,
    recordSuccess: async (input) => void successes.push(input),
    recordFailure: async (input) => void failures.push(input),
    heartbeat: async (input) => void heartbeats.push(input),
  };
}

function provider(captureTurn = vi.fn(async () => ({ id: "doc_001", status: "queued" }))) {
  return {
    captureTurn,
    createExact: vi.fn(async () => []),
    update: vi.fn(async () => ({ id: "memory_001", content: "updated" })),
    forget: vi.fn(async () => undefined),
    uploadImageJob: vi.fn(async () => ({ id: "image_doc_001", status: "queued" })),
    forgetMany: vi.fn(async () => undefined),
  };
}

describe("durable Supermemory synchronization worker", () => {
  it("uses the exact retry schedule and dead-letters after attempt five", async () => {
    expect(MEMORY_SYNC_RETRY_DELAYS_MS).toEqual([10_000, 60_000, 300_000, 1_800_000]);
    expect([1, 2, 3, 4, 5].map(retryDelayAfterAttempt)).toEqual([
      10_000,
      60_000,
      300_000,
      1_800_000,
      null,
    ]);

    let now = 1_000;
    const jobs = new InMemoryJobs([conversationJob({ nextAttemptAt: now })]);
    const captureTurn = vi.fn(async () => {
      throw Object.assign(new Error("provider unavailable"), { retryable: true });
    });
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(captureTurn),
      ensureContainerSettings: async () => undefined,
      now: () => now,
      workerId: "worker_retry",
    });

    for (const expectedDelay of MEMORY_SYNC_RETRY_DELAYS_MS) {
      await worker.runOnce();
      expect(jobs.jobs[0].status).toBe("failed");
      expect(jobs.jobs[0].nextAttemptAt).toBe(now + expectedDelay);
      now += expectedDelay;
    }
    await worker.runOnce();

    expect(captureTurn).toHaveBeenCalledTimes(5);
    expect(jobs.jobs[0]).toMatchObject({ status: "dead_letter", attempts: 5 });
    expect(jobs.failures.at(-1)).toMatchObject({ deadLetter: true, retryable: true });
  });

  it("records provider IDs before completing the durable job", async () => {
    let now = 50;
    const jobs = new InMemoryJobs([conversationJob({ nextAttemptAt: now })]);
    const state = providerState();
    const worker = new MemorySyncWorker({
      jobs,
      providerState: state,
      provider: provider(),
      ensureContainerSettings: async () => undefined,
      now: () => now++,
    });

    await worker.runOnce();

    expect(jobs.jobs[0]).toMatchObject({
      status: "completed",
      providerDocumentId: "doc_001",
      attempts: 1,
    });
    expect(state.successes).toEqual([
      expect.objectContaining({ jobId: "job_001", providerDocumentId: "doc_001" }),
    ]);
  });

  it("retries the identical delta against the same provider source document", async () => {
    let now = 0;
    const jobs = new InMemoryJobs([conversationJob()]);
    const calls: unknown[] = [];
    const captureTurn = vi.fn(async (input) => {
      calls.push(input);
      if (calls.length === 1) {
        throw Object.assign(new Error("temporary outage"), { retryable: true });
      }
      return { id: "doc_stable", status: "queued" };
    });
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(captureTurn),
      ensureContainerSettings: async () => undefined,
      now: () => now,
    });

    await worker.runOnce();
    now = 10_000;
    await worker.runOnce();

    expect(captureTurn).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({ customId: "daniel-conv-conversation001" });
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0]).toMatchObject({ status: "completed", providerDocumentId: "doc_stable" });
  });

  it("survives a worker restart because the outbox owns retry state", async () => {
    let now = 0;
    const jobs = new InMemoryJobs([conversationJob()]);
    const failingWorker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(
        vi.fn(async () => {
          throw Object.assign(new Error("offline"), { retryable: true });
        }),
      ),
      ensureContainerSettings: async () => undefined,
      now: () => now,
    });
    await failingWorker.runOnce();

    now = 10_000;
    const restartedProvider = provider();
    const restartedWorker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: restartedProvider,
      ensureContainerSettings: async () => undefined,
      now: () => now,
    });
    await restartedWorker.runOnce();

    expect(restartedProvider.captureTurn).toHaveBeenCalledOnce();
    expect(jobs.jobs[0]).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("lets only one concurrent worker claim a due job", async () => {
    const jobs = new InMemoryJobs([conversationJob()]);
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const captureTurn = vi.fn(async () => {
      await providerGate;
      return { id: "doc_once", status: "queued" };
    });
    const dependencies = {
      jobs,
      providerState: providerState(),
      provider: provider(captureTurn),
      ensureContainerSettings: async () => undefined,
      now: () => 0,
    };
    const first = new MemorySyncWorker({ ...dependencies, workerId: "worker_a" });
    const second = new MemorySyncWorker({ ...dependencies, workerId: "worker_b" });

    const runs = Promise.all([first.runOnce(), second.runOnce()]);
    await vi.waitFor(() => expect(captureTurn).toHaveBeenCalledOnce());
    release();
    await expect(runs).resolves.toEqual([true, false]);
    expect(jobs.jobs[0].attempts).toBe(1);
  });

  it("completes a submitted restart boundary without resubmitting", async () => {
    const jobs = new InMemoryJobs([
      conversationJob({
        status: "submitted",
        attempts: 1,
        nextAttemptAt: 0,
        providerDocumentId: "doc_already_submitted",
      }),
    ]);
    const currentProvider = provider();
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: currentProvider,
      ensureContainerSettings: async () => undefined,
      now: () => 100,
    });

    await worker.runOnce();

    expect(currentProvider.captureTurn).not.toHaveBeenCalled();
    expect(jobs.jobs[0]).toMatchObject({
      status: "completed",
      providerDocumentId: "doc_already_submitted",
    });
  });

  it("ensures container settings before the first provider write", async () => {
    const jobs = new InMemoryJobs([conversationJob()]);
    const events: string[] = [];
    const captureTurn = vi.fn(async () => {
      events.push("provider");
      return { id: "doc_001", status: "queued" };
    });
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(captureTurn),
      ensureContainerSettings: async () => void events.push("container"),
      now: () => 0,
    });

    await worker.runOnce();

    expect(events).toEqual(["container", "provider"]);
  });

  it("provider failure stays in the worker and does not erase the captured job", async () => {
    const jobs = new InMemoryJobs([conversationJob()]);
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(
        vi.fn(async () => {
          throw Object.assign(new Error("rate limited"), { status: 429 });
        }),
      ),
      ensureContainerSettings: async () => undefined,
      now: () => 0,
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(jobs.jobs[0]).toMatchObject({ status: "failed", nextAttemptAt: 10_000 });
  });

  it("dead-letters permanent provider failures immediately", async () => {
    const jobs = new InMemoryJobs([conversationJob()]);
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(
        vi.fn(async () => {
          throw new SupermemoryProviderError("authentication failed", {
            operation: "add",
            status: 401,
            retryable: false,
            code: "authentication",
          });
        }),
      ),
      ensureContainerSettings: async () => undefined,
      now: () => 0,
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(jobs.jobs[0]).toMatchObject({ status: "dead_letter", attempts: 1 });
    expect(jobs.failures[0]).toMatchObject({ retryable: false, deadLetter: true });
  });

  it("rejects a payload whose container does not match the durable job", async () => {
    const captureTurn = vi.fn(async () => ({ id: "should_not_write", status: "queued" }));
    const job = conversationJob();
    const payload = JSON.parse(job.payload);
    payload.providerInput.containerTag = "daniel-user-another-owner";
    job.payload = JSON.stringify(payload);
    const jobs = new InMemoryJobs([job]);
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: provider(captureTurn),
      ensureContainerSettings: async () => undefined,
      now: () => 0,
    });

    await worker.runOnce();
    expect(captureTurn).not.toHaveBeenCalled();
    expect(jobs.jobs[0]).toMatchObject({ status: "dead_letter" });
    expect(jobs.jobs[0].lastError).toMatch(/containerTag does not match/);
  });

  it("maps worker persistence calls to the exact Convex mutation contract", async () => {
    const claimed = conversationJob({
      status: "processing",
      attempts: 1,
      updatedAt: 101,
      nextAttemptAt: 10_100,
    });
    const mutation = vi
      .fn()
      .mockResolvedValueOnce({ job: claimed, resumeFrom: "dispatch" })
      .mockResolvedValue({ updated: true, job: claimed });
    const persistence = new ConvexMemorySyncPersistence({
      query: vi.fn(),
      mutation,
    } as never);

    await persistence.claimDue({ now: 100, leaseMs: 10_000, workerId: "worker_a" });
    await persistence.recordSubmitted({
      jobId: "job_001",
      expectedAttempt: 1,
      expectedUpdatedAt: 101,
      providerDocumentId: "doc_001",
      now: 102,
    });
    await persistence.complete({
      jobId: "job_001",
      expectedAttempt: 1,
      expectedUpdatedAt: 102,
      now: 103,
    });

    expect(mutation.mock.calls[0][1]).toEqual({
      now: 100,
      leaseMs: 10_000,
      workerId: "worker_a",
    });
    expect(mutation.mock.calls[1][1]).toMatchObject({
      expectedAttempt: 1,
      expectedUpdatedAt: 101,
      providerDocumentId: "doc_001",
    });
    expect(mutation.mock.calls[2][1]).toMatchObject({
      expectedAttempt: 1,
      expectedUpdatedAt: 102,
    });
  });

  it("dispatches every planned job kind through the typed provider boundary", async () => {
    const currentProvider = provider();
    const jobs = new InMemoryJobs([
      conversationJob(),
      conversationJob({
        jobId: "job_explicit",
        kind: "explicit_memory",
        customId: undefined,
        turnId: undefined,
        payload: JSON.stringify({
          memories: [{ content: "The user prefers concise answers" }],
        }),
      }),
      conversationJob({
        jobId: "job_image",
        kind: "image",
        payload: JSON.stringify({
          storageId: "storage_001",
          customId: "daniel-conv-conversation001",
          reason: "migration",
        }),
      }),
      conversationJob({
        jobId: "job_update",
        kind: "memory_update",
        customId: undefined,
        payload: JSON.stringify({ id: "memory_001", newContent: "Updated fact" }),
      }),
      conversationJob({
        jobId: "job_forget",
        kind: "memory_forget",
        customId: undefined,
        payload: JSON.stringify({ id: "memory_001", reason: "user requested" }),
      }),
    ]);
    const worker = new MemorySyncWorker({
      jobs,
      providerState: providerState(),
      provider: currentProvider,
      ensureContainerSettings: async () => undefined,
      now: () => 0,
    });

    for (let index = 0; index < 5; index += 1) await worker.runOnce();

    expect(jobs.jobs.every((job) => job.status === "completed")).toBe(true);
    expect(currentProvider.captureTurn).toHaveBeenCalledOnce();
    expect(currentProvider.createExact).toHaveBeenCalledOnce();
    expect(currentProvider.uploadImageJob).toHaveBeenCalledOnce();
    expect(currentProvider.update).toHaveBeenCalledOnce();
    expect(currentProvider.forgetMany).toHaveBeenCalledOnce();
  });

  it("does not start when capture is disabled and the durable backlog is empty", async () => {
    const client = {
      query: vi.fn(async () => ({
        counts: {
          pending: { count: 0 },
          processing: { count: 0 },
          submitted: { count: 0 },
          failed: { count: 0 },
          dead_letter: { count: 0 },
        },
        active: 0,
      })),
      mutation: vi.fn(),
    };

    const result = await startConfiguredMemorySyncWorker({
      client: client as never,
      env: {
        DANIEL_MEMORY_READ_MODE: "convex",
        DANIEL_MEMORY_WRITE_MODE: "convex",
      },
    });

    expect(result).toMatchObject({ worker: null, reason: "no_backlog" });
    expect(client.mutation).not.toHaveBeenCalled();
  });

  it("leaves pending work durable when backlog draining lacks provider credentials", async () => {
    const client = {
      query: vi.fn(async () => ({
        counts: {
          pending: { count: 1 },
          processing: { count: 0 },
          submitted: { count: 0 },
          failed: { count: 0 },
          dead_letter: { count: 0 },
        },
        active: 1,
      })),
      mutation: vi.fn(async () => ({})),
    };

    const result = await startConfiguredMemorySyncWorker({
      client: client as never,
      env: {
        DANIEL_MEMORY_READ_MODE: "convex",
        DANIEL_MEMORY_WRITE_MODE: "convex",
      },
    });

    expect(result).toMatchObject({ worker: null, reason: "provider_unconfigured" });
    expect(client.mutation).toHaveBeenCalledOnce();
    expect(client.mutation.mock.calls[0][1]).toMatchObject({ healthStatus: "unconfigured" });
  });
});
