import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireMemoryServerAuthority } from "./memoryProviderState";

export const jobKindValidator = v.literal("conversation_turn");

const jobStatusValidator = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("submitted"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("dead_letter"),
);

type MemorySyncJob = Doc<"memorySyncJobs">;
type JobStatus = MemorySyncJob["status"];

export interface EnqueueMemorySyncJobArgs {
  jobId: string;
  kind: MemorySyncJob["kind"];
  ownerKey: string;
  containerTag: string;
  customId: string;
  conversationId: string;
  turnId: string;
  payload: string;
  payloadHash: string;
  now?: number;
}

const CLAIMABLE_STATUSES: readonly JobStatus[] = [
  "pending",
  "failed",
  "processing",
  "submitted",
];
const MAX_PROVIDER_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const MAX_LIST_LIMIT = 200;
const BACKLOG_COUNT_LIMIT = 1_000;
const MAX_ERROR_LENGTH = 2_000;

// Delay after attempts 1-4. A failure on attempt 5 moves directly to the
// dead-letter state (the policy's "attempt 6" outcome).
const RETRY_DELAYS_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000] as const;

function timestamp(value: number | undefined): number {
  return value ?? Date.now();
}

function transitionTimestamp(current: number, requested: number): number {
  return Math.max(requested, current + 1);
}

function normalizeError(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  return (normalized || "SuperMemory submission failed").slice(0, MAX_ERROR_LENGTH);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(value)));
}

async function getByJobId(
  ctx: MutationCtx,
  jobId: string,
): Promise<MemorySyncJob | null> {
  return await ctx.db
    .query("memorySyncJobs")
    .withIndex("by_job_id", (q) => q.eq("jobId", jobId))
    .unique();
}

/**
 * Adds one durable outbox row. The caller computes the SHA-256 payload hash
 * from the normalized provider payload; no Node crypto is available here.
 * Any existing row with the same hash is returned instead of creating a
 * second source job, including dead-letter rows (which must use retry()).
 */
export async function enqueueMemorySyncJob(
  ctx: MutationCtx,
  args: EnqueueMemorySyncJobArgs,
) {
    const payloadHash = args.payloadHash.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
      throw new Error("payloadHash must be a 64-character SHA-256 hex digest");
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed = JSON.parse(args.payload) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("payload must be an object");
      }
      envelope = parsed as Record<string, unknown>;
    } catch {
      throw new Error("memory sync payload must be valid JSON");
    }
    if (envelope.schemaVersion !== 1 || envelope.kind !== args.kind) {
      throw new Error("memory sync payload must use the canonical v1 job contract");
    }
    const providerInput = envelope.providerInput;
    if (!providerInput || typeof providerInput !== "object" || Array.isArray(providerInput)) {
      throw new Error("memory sync payload requires providerInput");
    }
    if ((providerInput as Record<string, unknown>).containerTag !== args.containerTag) {
      throw new Error("memory sync payload containerTag does not match the durable job");
    }

    const existingByTurn = await ctx.db
      .query("memorySyncJobs")
      .withIndex("by_turn_id", (q) => q.eq("turnId", args.turnId))
      .take(1_000);
    const existingConversationTurn = existingByTurn[0];
    if (existingConversationTurn) {
      if (existingConversationTurn.payloadHash === payloadHash) {
        return { created: false, duplicate: true, job: existingConversationTurn };
      }
      throw new Error(
        `conversation turn already has a different memory sync payload: ${args.turnId}`,
      );
    }

    const existingByHash = await ctx.db
      .query("memorySyncJobs")
      .withIndex("by_payload_hash", (q) => q.eq("payloadHash", payloadHash))
      .first();
    if (existingByHash) {
      return { created: false, duplicate: true, job: existingByHash };
    }

    const existingById = await getByJobId(ctx, args.jobId);
    if (existingById) {
      if (existingById.payloadHash === payloadHash) {
        return { created: false, duplicate: true, job: existingById };
      }
      throw new Error(`memory sync job id already exists: ${args.jobId}`);
    }

    const now = timestamp(args.now);
    const jobId = await ctx.db.insert("memorySyncJobs", {
      jobId: args.jobId,
      kind: args.kind,
      ownerKey: args.ownerKey,
      containerTag: args.containerTag,
      customId: args.customId,
      conversationId: args.conversationId,
      turnId: args.turnId,
      payload: args.payload,
      payloadHash,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("memory sync job disappeared after enqueue");
    return { created: true, duplicate: false, job };
}

export const enqueue = internalMutation({
  args: {
    jobId: v.string(),
    kind: jobKindValidator,
    ownerKey: v.string(),
    containerTag: v.string(),
    customId: v.string(),
    conversationId: v.string(),
    turnId: v.string(),
    payload: v.string(),
    payloadHash: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => await enqueueMemorySyncJob(ctx, args),
});

/**
 * Atomically claims the oldest due row across pending/retry and expired-lease
 * states. Convex mutation serialization prevents two workers from claiming the
 * same current attempt. `attempts` is the fencing value for later mutations.
 */
export const claimDue = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    now: v.optional(v.number()),
    // Accepted for worker observability/call-site stability. The current
    // schema uses an expiring transactional lease rather than storing owner.
    workerId: v.optional(v.string()),
    leaseMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const now = timestamp(args.now);
    const requestedLease = args.leaseMs ?? DEFAULT_LEASE_MS;
    const leaseMs = Math.max(1_000, Math.floor(requestedLease));

    const candidates = await Promise.all(
      CLAIMABLE_STATUSES.map(async (status) => {
        return await ctx.db
          .query("memorySyncJobs")
          .withIndex("by_status_next_attempt", (q) =>
            q.eq("status", status).lte("nextAttemptAt", now),
          )
          .order("asc")
          .first();
      }),
    );
    const job = candidates
      .filter((candidate): candidate is MemorySyncJob => candidate !== null)
      .sort(
        (left, right) =>
          left.nextAttemptAt - right.nextAttemptAt || left.createdAt - right.createdAt,
      )[0];
    if (!job) return null;

    // A submitted row crossed the provider-success boundary. Lease and return
    // it without changing status or attempts; the worker recognizes submitted
    // as completion-only work and never calls the provider again.
    if (job.status === "submitted") {
      const updatedAt = transitionTimestamp(job.updatedAt, now);
      await ctx.db.patch(job._id, {
        nextAttemptAt: now + leaseMs,
        updatedAt,
      });
      const claimed = await ctx.db.get(job._id);
      if (!claimed) throw new Error("submitted memory sync job disappeared while claiming");
      return { job: claimed, resumeFrom: "complete" as const };
    }

    // Five expired processing leases consume the permitted provider attempts;
    // do not dispatch an unplanned sixth request after a worker crash.
    if (job.status === "processing" && job.attempts >= MAX_PROVIDER_ATTEMPTS) {
      const updatedAt = transitionTimestamp(job.updatedAt, now);
      await ctx.db.patch(job._id, {
        status: "dead_letter",
        nextAttemptAt: now,
        lastError: normalizeError("processing lease expired after final provider attempt"),
        updatedAt,
      });
      return null;
    }

    const attempts = job.attempts + 1;
    const updatedAt = transitionTimestamp(job.updatedAt, now);
    await ctx.db.patch(job._id, {
      status: "processing",
      attempts,
      nextAttemptAt: now + leaseMs,
      updatedAt,
    });
    const claimed = await ctx.db.get(job._id);
    if (!claimed) throw new Error("memory sync job disappeared while claiming");
    return { job: claimed, resumeFrom: "dispatch" as const };
  },
});

/** Records provider identifiers before completion so they survive a crash. */
export const recordSubmitted = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    jobId: v.string(),
    expectedAttempt: v.number(),
    expectedUpdatedAt: v.number(),
    providerDocumentId: v.optional(v.string()),
    providerMemoryIds: v.optional(v.array(v.string())),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const job = await getByJobId(ctx, args.jobId);
    if (
      !job ||
      job.attempts !== args.expectedAttempt ||
      job.updatedAt !== args.expectedUpdatedAt ||
      (job.status !== "processing" && job.status !== "submitted")
    ) {
      return { updated: false, job };
    }

    const providerMemoryIds = args.providerMemoryIds
      ? [...new Set(args.providerMemoryIds)].slice(0, 1_000)
      : undefined;
    const updatedAt = transitionTimestamp(job.updatedAt, timestamp(args.now));
    await ctx.db.patch(job._id, {
      status: "submitted",
      providerDocumentId: args.providerDocumentId ?? job.providerDocumentId,
      providerMemoryIds: providerMemoryIds ?? job.providerMemoryIds,
      updatedAt,
    });
    return { updated: true, job: await ctx.db.get(job._id) };
  },
});

export const complete = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    jobId: v.string(),
    expectedAttempt: v.number(),
    expectedUpdatedAt: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const job = await getByJobId(ctx, args.jobId);
    if (
      !job ||
      job.attempts !== args.expectedAttempt ||
      job.updatedAt !== args.expectedUpdatedAt ||
      (job.status !== "processing" && job.status !== "submitted")
    ) {
      return { updated: false, job };
    }

    const now = timestamp(args.now);
    const updatedAt = transitionTimestamp(job.updatedAt, now);
    await ctx.db.patch(job._id, {
      status: "completed",
      nextAttemptAt: now,
      lastError: undefined,
      updatedAt,
    });
    return { updated: true, job: await ctx.db.get(job._id) };
  },
});

/** Applies the fixed retry schedule or dead-letters the job. */
export const recordFailure = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    jobId: v.string(),
    expectedAttempt: v.number(),
    expectedUpdatedAt: v.number(),
    error: v.string(),
    retryable: v.optional(v.boolean()),
    nextAttemptAt: v.optional(v.number()),
    deadLetter: v.optional(v.boolean()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const job = await getByJobId(ctx, args.jobId);
    if (
      !job ||
      job.attempts !== args.expectedAttempt ||
      job.updatedAt !== args.expectedUpdatedAt ||
      (job.status !== "processing" && job.status !== "submitted")
    ) {
      return { updated: false, deadLettered: false, job };
    }

    const now = timestamp(args.now);
    const deadLettered =
      args.deadLetter === true ||
      args.retryable === false ||
      job.attempts >= MAX_PROVIDER_ATTEMPTS;
    const scheduledAt = deadLettered
      ? now
      : now + RETRY_DELAYS_MS[job.attempts - 1];
    if (
      !deadLettered &&
      args.nextAttemptAt !== undefined &&
      args.nextAttemptAt !== scheduledAt
    ) {
      throw new Error(
        `nextAttemptAt does not match the fixed retry schedule (expected ${scheduledAt})`,
      );
    }
    const nextAttemptAt = deadLettered ? now : (args.nextAttemptAt ?? scheduledAt);
    const updatedAt = transitionTimestamp(job.updatedAt, now);
    await ctx.db.patch(job._id, {
      status: deadLettered ? "dead_letter" : "failed",
      nextAttemptAt,
      lastError: normalizeError(args.error),
      updatedAt,
    });
    return {
      updated: true,
      deadLettered,
      nextAttemptAt,
      job: await ctx.db.get(job._id),
    };
  },
});

/** Atomically verifies owner/container and status before requeueing a job. */
export const retryOwned = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    jobId: v.string(),
    ownerKey: v.string(),
    containerTag: v.string(),
    expectedStatus: v.union(v.literal("failed"), v.literal("dead_letter")),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const job = await getByJobId(ctx, args.jobId);
    if (
      !job ||
      job.ownerKey !== args.ownerKey ||
      job.containerTag !== args.containerTag
    ) {
      return { retried: false, reason: "not_found", job: null };
    }
    if (job.status !== args.expectedStatus) {
      return { retried: false, reason: "not_retryable", job };
    }

    const now = timestamp(args.now);
    const updatedAt = transitionTimestamp(job.updatedAt, now);
    await ctx.db.patch(job._id, {
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastError: undefined,
      updatedAt,
    });
    return { retried: true, reason: "requeued", job: await ctx.db.get(job._id) };
  },
});

export const list = internalQuery({
  args: {
    status: v.optional(jobStatusValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = boundedLimit(args.limit);
    if (args.status) {
      return await ctx.db
        .query("memorySyncJobs")
        .withIndex("by_status_next_attempt", (q) => q.eq("status", args.status!))
        .order("desc")
        .take(limit);
    }
    return await ctx.db
      .query("memorySyncJobs")
      .withIndex("by_status_next_attempt")
      .order("desc")
      .take(limit);
  },
});

export const backlog = query({
  args: {},
  handler: async (ctx) => {
    const statuses: readonly JobStatus[] = [
      "pending",
      "processing",
      "submitted",
      "completed",
      "failed",
      "dead_letter",
    ];
    const entries = await Promise.all(
      statuses.map(async (status) => {
        const rows = await ctx.db
          .query("memorySyncJobs")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", status))
          .take(BACKLOG_COUNT_LIMIT + 1);
        return [
          status,
          {
            count: Math.min(rows.length, BACKLOG_COUNT_LIMIT),
            truncated: rows.length > BACKLOG_COUNT_LIMIT,
          },
        ] as const;
      }),
    );
    const counts = Object.fromEntries(entries) as Record<
      JobStatus,
      { count: number; truncated: boolean }
    >;
    return {
      counts,
      pending: counts.pending.count,
      processing: counts.processing.count,
      submitted: counts.submitted.count,
      completed: counts.completed.count,
      failed: counts.failed.count,
      deadLetter: counts.dead_letter.count,
      active:
        counts.pending.count +
        counts.processing.count +
        counts.submitted.count +
        counts.failed.count,
      total: entries.reduce((sum, [, value]) => sum + value.count, 0),
      truncated: entries.some(([, value]) => value.truncated),
      countLimitPerStatus: BACKLOG_COUNT_LIMIT,
    };
  },
});
