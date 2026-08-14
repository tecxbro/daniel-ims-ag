import type { Doc } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";

// Dashboard reads are deliberately bounded. A `truncated` result means the UI
// is showing an operational snapshot, not pretending to be an exact all-time
// analytics warehouse.
// Keep the worst-case aggregate below Convex's per-transaction document-read
// ceiling even when every source reaches its cap. These remain snapshots;
// exact lifetime analytics belong in denormalized counters, not this query.
const METRICS_SCAN_LIMIT = 1_000;
const OPERATIONAL_COUNT_LIMIT = 500;
const RECENT_JOBS_PER_STATUS = 6;
const RECENT_JOBS_LIMIT = 12;
const DEMO_SETTING_KEY = "debug_demo_mode";
const DEPLOYMENT_STATE_KEY = "deployment";
const DEMO_DEPLOYMENT_STATE_KEY = "demo:deployment";

const syncStatuses = [
  "pending",
  "processing",
  "submitted",
  "completed",
  "failed",
  "dead_letter",
] as const;

const migrationStatuses = ["pending", "migrated", "failed", "skipped"] as const;
const imageAnchorStatuses = ["pending", "active", "released"] as const;

type SyncStatus = (typeof syncStatuses)[number];
type MigrationStatus = (typeof migrationStatuses)[number];
type ImageAnchorStatus = (typeof imageAnchorStatuses)[number];

type BoundedCount = {
  count: number;
  truncated: boolean;
};

function boundedCount(rows: unknown[]): BoundedCount {
  return {
    count: Math.min(rows.length, OPERATIONAL_COUNT_LIMIT),
    truncated: rows.length > OPERATIONAL_COUNT_LIMIT,
  };
}

async function readSyncSnapshot(ctx: QueryCtx) {
  const entries = await Promise.all(
    syncStatuses.map(async (status) => {
      const [countRows, recentRows] = await Promise.all([
        ctx.db
          .query("memorySyncJobs")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", status))
          .take(OPERATIONAL_COUNT_LIMIT + 1),
        ctx.db
          .query("memorySyncJobs")
          .withIndex("by_status_next_attempt", (q) => q.eq("status", status))
          .order("desc")
          .take(RECENT_JOBS_PER_STATUS),
      ]);
      return [status, boundedCount(countRows), recentRows] as const;
    }),
  );

  const counts = Object.fromEntries(
    entries.map(([status, count]) => [status, count]),
  ) as Record<SyncStatus, BoundedCount>;
  const recentJobs = entries
    .flatMap(([, , rows]) => rows)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_JOBS_LIMIT)
    .map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      nextAttemptAt: job.nextAttemptAt,
      lastError: job.lastError,
      providerDocumentId: job.providerDocumentId,
      providerMemoryIds: job.providerMemoryIds ?? [],
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));

  const pending = counts.pending.count;
  const processing = counts.processing.count;
  const submitted = counts.submitted.count;
  const completed = counts.completed.count;
  const failed = counts.failed.count;
  const deadLetter = counts.dead_letter.count;
  const terminalOrFailed = completed + failed + deadLetter;

  return {
    value: {
      pending,
      processing,
      submitted,
      completed,
      failed,
      deadLetter,
      active: pending + processing + submitted + failed,
      total: pending + processing + submitted + completed + failed + deadLetter,
      captureCompletionRate:
        terminalOrFailed === 0 ? null : completed / terminalOrFailed,
      recentJobs,
    },
    truncated: Object.values(counts).some((count) => count.truncated),
  };
}

async function readMigrationSnapshot(ctx: QueryCtx) {
  const entries = await Promise.all(
    migrationStatuses.map(async (status) => {
      const rows = await ctx.db
        .query("memoryMigrationRows")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(OPERATIONAL_COUNT_LIMIT + 1);
      return [status, boundedCount(rows)] as const;
    }),
  );
  const counts = Object.fromEntries(entries) as Record<MigrationStatus, BoundedCount>;
  const pending = counts.pending.count;
  const migrated = counts.migrated.count;
  const failed = counts.failed.count;
  const skipped = counts.skipped.count;
  const total = pending + migrated + failed + skipped;

  return {
    value: {
      pending,
      migrated,
      failed,
      skipped,
      total,
      reconciled: total > 0 && pending === 0 && failed === 0,
    },
    truncated: Object.values(counts).some((count) => count.truncated),
  };
}

async function readImageAnchorSnapshot(ctx: QueryCtx) {
  const entries = await Promise.all(
    imageAnchorStatuses.map(async (status) => {
      const rows = await ctx.db
        .query("memoryImageAnchors")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(OPERATIONAL_COUNT_LIMIT + 1);
      return [status, boundedCount(rows)] as const;
    }),
  );
  const counts = Object.fromEntries(entries) as Record<ImageAnchorStatus, BoundedCount>;
  const pending = counts.pending.count;
  const active = counts.active.count;
  const released = counts.released.count;

  return {
    value: { pending, active, released, total: pending + active + released },
    truncated: Object.values(counts).some((count) => count.truncated),
  };
}

function providerSnapshot(state: Doc<"memoryProviderState"> | null) {
  const healthStatus = state?.healthStatus ?? "unconfigured";
  return {
    configured: healthStatus !== "disabled" && healthStatus !== "unconfigured",
    healthStatus,
    readMode: state?.readMode ?? "convex",
    writeMode: state?.writeMode ?? "convex",
    lastSuccessfulSubmissionAt: state?.lastSuccessfulSubmissionAt,
    lastFailedSubmissionAt: state?.lastFailedSubmissionAt,
    lastWorkerActivityAt: state?.lastWorkerActivityAt,
    lastError: state?.lastError,
  };
}

function hydrationSnapshot(
  buckets: Doc<"memoryProviderMetrics">[],
) {
  const requests = buckets.reduce((sum, bucket) => sum + bucket.requestCount, 0);
  const failures = buckets.reduce((sum, bucket) => sum + bucket.failureCount, 0);
  const totalLatencyMs = buckets.reduce(
    (sum, bucket) => sum + bucket.totalLatencyMs,
    0,
  );
  const histogram = Array<number>(6).fill(0);
  for (const bucket of buckets) {
    bucket.latencyBuckets.forEach((count, index) => {
      histogram[index] = (histogram[index] ?? 0) + count;
    });
  }
  const observedLatencies = histogram.reduce((sum, count) => sum + count, 0);
  const percentileTarget = Math.ceil(observedLatencies * 0.95);
  const bounds = [100, 250, 500, 1_000, 2_500, null] as const;
  let cumulative = 0;
  let p95UpperBoundMs: number | null = null;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= percentileTarget && percentileTarget > 0) {
      p95UpperBoundMs = bounds[index] ?? null;
      break;
    }
  }
  return {
    requests,
    failures,
    averageLatencyMs: requests === 0 ? null : totalLatencyMs / requests,
    p95UpperBoundMs,
    observedBuckets: buckets.length,
  };
}

export const metrics = query({
  args: {},
  handler: async (ctx) => {
    const demoSetting = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", DEMO_SETTING_KEY))
      .unique();
    const providerStateKey =
      demoSetting?.value === "true" ? DEMO_DEPLOYMENT_STATE_KEY : DEPLOYMENT_STATE_KEY;

    const [
      messages,
      agents,
      automationRuns,
      usageRecords,
      providerState,
      sync,
      migration,
      imageAnchors,
      providerMetricBuckets,
      providerEvents,
    ] = await Promise.all([
      ctx.db
        .query("messages")
        .withIndex("by_createdAt")
        .order("desc")
        .take(METRICS_SCAN_LIMIT),
      ctx.db
        .query("executionAgents")
        .order("desc")
        .take(METRICS_SCAN_LIMIT),
      ctx.db
        .query("automationRuns")
        .order("desc")
        .take(METRICS_SCAN_LIMIT),
      ctx.db
        .query("usageRecords")
        .order("desc")
        .take(METRICS_SCAN_LIMIT),
      ctx.db
        .query("memoryProviderState")
        .withIndex("by_state_key", (q) => q.eq("stateKey", providerStateKey))
        .unique(),
      readSyncSnapshot(ctx),
      readMigrationSnapshot(ctx),
      readImageAnchorSnapshot(ctx),
      ctx.db
        .query("memoryProviderMetrics")
        .withIndex("by_bucket_start")
        .order("desc")
        .take(168),
      ctx.db
        .query("memoryProviderEvents")
        .withIndex("by_created_at")
        .order("desc")
        .take(50),
    ]);

    const truncated =
      messages.length === METRICS_SCAN_LIMIT ||
      agents.length === METRICS_SCAN_LIMIT ||
      automationRuns.length === METRICS_SCAN_LIMIT ||
      usageRecords.length === METRICS_SCAN_LIMIT ||
      sync.truncated ||
      migration.truncated ||
      imageAnchors.truncated;

    const buckets = new Map<
      string,
      {
        day: string;
        agentCost: number;
        inputTokens: number;
        outputTokens: number;
        agentsSpawned: number;
        agentsCompleted: number;
        agentsFailed: number;
        agentsCancelled: number;
        automationRuns: number;
      }
    >();

    function keyFor(timestamp: number) {
      return new Date(timestamp).toISOString().slice(0, 10);
    }

    function bucketFor(day: string) {
      let bucket = buckets.get(day);
      if (!bucket) {
        bucket = {
          day,
          agentCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          agentsSpawned: 0,
          agentsCompleted: 0,
          agentsFailed: 0,
          agentsCancelled: 0,
          automationRuns: 0,
        };
        buckets.set(day, bucket);
      }
      return bucket;
    }

    const usageAgentIds = new Set<string>();
    for (const record of usageRecords) {
      const bucket = bucketFor(keyFor(record.createdAt));
      bucket.agentCost += record.costUsd ?? 0;
      bucket.inputTokens += record.inputTokens ?? 0;
      bucket.outputTokens += record.outputTokens ?? 0;
      if (record.agentId) usageAgentIds.add(record.agentId);
    }

    for (const agent of agents) {
      const bucket = bucketFor(keyFor(agent.startedAt));
      bucket.agentsSpawned += 1;
      if (!usageAgentIds.has(agent.agentId)) {
        bucket.agentCost += agent.costUsd ?? 0;
        bucket.inputTokens += agent.inputTokens ?? 0;
        bucket.outputTokens += agent.outputTokens ?? 0;
      }
      if (agent.status === "completed") bucket.agentsCompleted += 1;
      else if (agent.status === "failed") bucket.agentsFailed += 1;
      else if (agent.status === "cancelled") bucket.agentsCancelled += 1;
    }

    for (const run of automationRuns) {
      bucketFor(keyFor(run.startedAt)).automationRuns += 1;
    }

    const dailyBuckets = [...buckets.values()].sort((a, b) =>
      a.day.localeCompare(b.day),
    );

    return {
      messages: messages.length,
      memoryProvider: providerSnapshot(providerState),
      hydration: hydrationSnapshot(providerMetricBuckets),
      providerEvents: providerEvents.map((event) => ({
        eventId: event.eventId,
        operation: event.operation,
        outcome: event.outcome,
        latencyMs: event.latencyMs,
        errorCode: event.errorCode,
        createdAt: event.createdAt,
      })),
      sync: sync.value,
      migration: migration.value,
      imageAnchors: imageAnchors.value,
      agents: {
        total: agents.length,
        completed: agents.filter((agent) => agent.status === "completed").length,
        failed: agents.filter((agent) => agent.status === "failed").length,
        cancelled: agents.filter((agent) => agent.status === "cancelled").length,
        running: agents.filter(
          (agent) => agent.status === "running" || agent.status === "spawned",
        ).length,
      },
      cost: {
        total: dailyBuckets.reduce((sum, bucket) => sum + bucket.agentCost, 0),
      },
      tokens: {
        input: dailyBuckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0),
        output: dailyBuckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0),
      },
      dailyBuckets,
      truncated,
      scanLimit: METRICS_SCAN_LIMIT,
    };
  },
});

/** Compatibility query now reports durable SuperMemory anchors, not message arrays. */
export const imageStorageStats = query({
  args: {},
  handler: async (ctx) => {
    const snapshot = await readImageAnchorSnapshot(ctx);
    return {
      count: snapshot.value.pending + snapshot.value.active,
      ...snapshot.value,
      truncated: snapshot.truncated,
    };
  },
});
