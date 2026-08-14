import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";

const healthStatusValidator = v.union(
  v.literal("disabled"),
  v.literal("unconfigured"),
  v.literal("healthy"),
  v.literal("degraded"),
  v.literal("unavailable"),
);
const readModeValidator = v.union(
  v.literal("convex"),
  v.literal("shadow"),
  v.literal("supermemory"),
);
const writeModeValidator = v.union(
  v.literal("convex"),
  v.literal("dual"),
  v.literal("supermemory"),
);
const jobKindValidator = v.union(
  v.literal("conversation_turn"),
  v.literal("explicit_memory"),
  v.literal("image"),
  v.literal("memory_update"),
  v.literal("memory_forget"),
);

const DEPLOYMENT_STATE_KEY = "deployment";
const MAX_ERROR_LENGTH = 2_000;
const BACKLOG_COUNT_LIMIT = 1_000;

function timestamp(value: number | undefined): number {
  return value ?? Date.now();
}

function containerStateKey(containerTag: string): string {
  return `container:${containerTag}`;
}

function normalizeError(error: string): string {
  const normalized = error.replace(/\s+/g, " ").trim();
  return (normalized || "SuperMemory provider failure").slice(0, MAX_ERROR_LENGTH);
}

async function getDeploymentRow(ctx: MutationCtx) {
  return await ctx.db
    .query("memoryProviderState")
    .withIndex("by_state_key", (q) => q.eq("stateKey", DEPLOYMENT_STATE_KEY))
    .unique();
}

/** Creates the deployment fingerprint once and always returns persisted data. */
export const ensureIdentitySaltFingerprint = mutation({
  args: {
    saltFingerprint: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await getDeploymentRow(ctx);
    if (existing?.saltFingerprint) return existing.saltFingerprint;

    const now = timestamp(args.now);
    if (existing) {
      await ctx.db.patch(existing._id, {
        saltFingerprint: args.saltFingerprint,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("memoryProviderState", {
        stateKey: DEPLOYMENT_STATE_KEY,
        scope: "deployment",
        saltFingerprint: args.saltFingerprint,
        updatedAt: now,
      });
    }
    return args.saltFingerprint;
  },
});

export const getContainerState = query({
  args: { containerTag: v.string() },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", containerStateKey(args.containerTag)))
      .unique();
    if (!state) return null;
    return {
      containerTag: args.containerTag,
      initializedAt: state.initializedAt,
      saltFingerprint: state.saltFingerprint,
    };
  },
});

/** Persists only a successfully applied container configuration. */
export const markContainerInitialized = mutation({
  args: {
    containerTag: v.string(),
    initializedAt: v.number(),
    saltFingerprint: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const stateKey = containerStateKey(args.containerTag);
    const existing = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", stateKey))
      .unique();
    if (existing) {
      if (existing.scope !== "container" || existing.containerTag !== args.containerTag) {
        throw new Error(`invalid provider state row for container: ${args.containerTag}`);
      }
      if (existing.saltFingerprint && existing.saltFingerprint !== args.saltFingerprint) {
        throw new Error("memory identity salt fingerprint does not match container state");
      }
      if (!existing.initializedAt) {
        await ctx.db.patch(existing._id, {
          initializedAt: args.initializedAt,
          saltFingerprint: args.saltFingerprint,
          updatedAt: timestamp(args.now),
        });
      }
      return {
        containerTag: args.containerTag,
        initializedAt: existing.initializedAt ?? args.initializedAt,
        saltFingerprint: existing.saltFingerprint ?? args.saltFingerprint,
      };
    }

    await ctx.db.insert("memoryProviderState", {
      stateKey,
      scope: "container",
      containerTag: args.containerTag,
      saltFingerprint: args.saltFingerprint,
      initializedAt: args.initializedAt,
      updatedAt: timestamp(args.now),
    });
    return {
      containerTag: args.containerTag,
      initializedAt: args.initializedAt,
      saltFingerprint: args.saltFingerprint,
    };
  },
});

export const updateHealth = mutation({
  args: {
    healthStatus: healthStatusValidator,
    error: v.optional(v.string()),
    readMode: v.optional(readModeValidator),
    writeMode: v.optional(writeModeValidator),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = timestamp(args.now);
    const existing = await getDeploymentRow(ctx);
    const patch = {
      healthStatus: args.healthStatus,
      ...(args.error === undefined ? {} : { lastError: normalizeError(args.error) }),
      ...(args.readMode === undefined ? {} : { readMode: args.readMode }),
      ...(args.writeMode === undefined ? {} : { writeMode: args.writeMode }),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("memoryProviderState", {
      stateKey: DEPLOYMENT_STATE_KEY,
      scope: "deployment",
      ...patch,
    });
    return await ctx.db.get(id);
  },
});

export const recordSuccess = mutation({
  args: {
    jobId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    providerDocumentId: v.optional(v.string()),
    providerMemoryIds: v.optional(v.array(v.string())),
    at: v.optional(v.number()),
    readMode: v.optional(readModeValidator),
    writeMode: v.optional(writeModeValidator),
  },
  handler: async (ctx, args) => {
    const now = timestamp(args.at);
    const existing = await getDeploymentRow(ctx);
    const patch = {
      healthStatus: "healthy" as const,
      lastSuccessfulSubmissionAt: now,
      lastError: undefined,
      ...(args.readMode === undefined ? {} : { readMode: args.readMode }),
      ...(args.writeMode === undefined ? {} : { writeMode: args.writeMode }),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("memoryProviderState", {
      stateKey: DEPLOYMENT_STATE_KEY,
      scope: "deployment",
      ...patch,
    });
    return await ctx.db.get(id);
  },
});

export const recordFailure = mutation({
  args: {
    jobId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    error: v.string(),
    retryable: v.optional(v.boolean()),
    deadLetter: v.optional(v.boolean()),
    healthStatus: v.optional(
      v.union(v.literal("degraded"), v.literal("unavailable")),
    ),
    at: v.optional(v.number()),
    readMode: v.optional(readModeValidator),
    writeMode: v.optional(writeModeValidator),
  },
  handler: async (ctx, args) => {
    const now = timestamp(args.at);
    const existing = await getDeploymentRow(ctx);
    const patch = {
      healthStatus:
        args.healthStatus ??
        (args.retryable === false ? ("unavailable" as const) : ("degraded" as const)),
      lastFailedSubmissionAt: now,
      lastError: normalizeError(args.error),
      ...(args.readMode === undefined ? {} : { readMode: args.readMode }),
      ...(args.writeMode === undefined ? {} : { writeMode: args.writeMode }),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("memoryProviderState", {
      stateKey: DEPLOYMENT_STATE_KEY,
      scope: "deployment",
      ...patch,
    });
    return await ctx.db.get(id);
  },
});

export const heartbeat = mutation({
  args: {
    workerId: v.optional(v.string()),
    activity: v.optional(v.string()),
    jobId: v.optional(v.string()),
    at: v.optional(v.number()),
    healthStatus: v.optional(healthStatusValidator),
    readMode: v.optional(readModeValidator),
    writeMode: v.optional(writeModeValidator),
  },
  handler: async (ctx, args) => {
    const now = timestamp(args.at);
    const existing = await getDeploymentRow(ctx);
    const patch = {
      lastWorkerActivityAt: now,
      ...(args.healthStatus === undefined ? {} : { healthStatus: args.healthStatus }),
      ...(args.readMode === undefined ? {} : { readMode: args.readMode }),
      ...(args.writeMode === undefined ? {} : { writeMode: args.writeMode }),
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }
    const id = await ctx.db.insert("memoryProviderState", {
      stateKey: DEPLOYMENT_STATE_KEY,
      scope: "deployment",
      ...patch,
    });
    return await ctx.db.get(id);
  },
});

export const getDeploymentState = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", DEPLOYMENT_STATE_KEY))
      .unique();
  },
});

/** Bounded, index-only backlog snapshot for status routes. */
export const getBacklogSummary = query({
  args: {},
  handler: async (ctx) => {
    const statuses = [
      "pending",
      "processing",
      "submitted",
      "failed",
      "dead_letter",
    ] as const;
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
    const counts = Object.fromEntries(entries);
    return {
      counts,
      pending: counts.pending.count,
      processing: counts.processing.count,
      submitted: counts.submitted.count,
      failed: counts.failed.count,
      active: entries
        .filter(([status]) => status !== "dead_letter")
        .reduce((sum, [, value]) => sum + value.count, 0),
      deadLetter: counts.dead_letter.count,
      total: entries.reduce((sum, [, value]) => sum + value.count, 0),
      truncated: entries.some(([, value]) => value.truncated),
      countLimitPerStatus: BACKLOG_COUNT_LIMIT,
    };
  },
});
