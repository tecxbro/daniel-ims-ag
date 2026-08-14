import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";

const healthStatusValidator = v.union(
  v.literal("unconfigured"),
  v.literal("recovery_required"),
  v.literal("healthy"),
  v.literal("degraded"),
  v.literal("unavailable"),
);
const jobKindValidator = v.literal("conversation_turn");

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

async function getDeploymentRow(ctx: MutationCtx | QueryCtx) {
  return await ctx.db
    .query("memoryProviderState")
    .withIndex("by_state_key", (q) => q.eq("stateKey", DEPLOYMENT_STATE_KEY))
    .unique();
}

function validOwnerKey(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

function validFingerprint(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

function validPairingProof(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function validSmsConversation(value: string): boolean {
  return /^sms:\+[1-9][0-9]{7,14}$/.test(value);
}

/** Shared gate for public functions that are called only by the local server. */
export async function requireMemoryServerAuthority(
  ctx: MutationCtx | QueryCtx,
  pairingAuthorityProof: string,
) {
  if (!validPairingProof(pairingAuthorityProof)) {
    throw new Error("memory server authority is invalid");
  }
  const deployment = await getDeploymentRow(ctx);
  if (!deployment || deployment.pairingAuthorityProof !== pairingAuthorityProof) {
    throw new Error("memory server authority is invalid");
  }
  return deployment;
}

/**
 * Initializes server-only identity material through the authenticated Convex
 * CLI/admin path. This function is intentionally absent from the public API.
 */
export const initializeIdentityConfiguration = internalMutation({
  args: {
    saltFingerprint: v.string(),
    pairingAuthorityProof: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!validFingerprint(args.saltFingerprint) || !validPairingProof(args.pairingAuthorityProof)) {
      throw new Error("memory identity configuration is invalid");
    }
    const now = timestamp(args.now);
    const existing = await getDeploymentRow(ctx);
    if (existing) {
      if (
        (existing.saltFingerprint && existing.saltFingerprint !== args.saltFingerprint) ||
        (existing.pairingAuthorityProof &&
          existing.pairingAuthorityProof !== args.pairingAuthorityProof) ||
        ((!existing.saltFingerprint || !existing.pairingAuthorityProof) &&
          Boolean(existing.primaryOwnerKey))
      ) {
        await ctx.db.patch(existing._id, {
          healthStatus: "recovery_required",
          updatedAt: now,
        });
        return { status: "recovery_required" as const };
      }
      await ctx.db.patch(existing._id, {
        saltFingerprint: args.saltFingerprint,
        pairingAuthorityProof: args.pairingAuthorityProof,
        ...(existing.healthStatus === "recovery_required"
          ? { healthStatus: undefined }
          : {}),
        updatedAt: now,
      });
      return { status: "ready" as const };
    }
    await ctx.db.insert("memoryProviderState", {
      stateKey: DEPLOYMENT_STATE_KEY,
      scope: "deployment",
      saltFingerprint: args.saltFingerprint,
      pairingAuthorityProof: args.pairingAuthorityProof,
      updatedAt: now,
    });
    return { status: "ready" as const };
  },
});

/**
 * Verifies already-initialized identity material. A caller without the
 * persisted server-only proof cannot initialize state, force recovery, or
 * learn the stored fingerprint.
 */
export const verifyIdentityConfiguration = mutation({
  args: {
    saltFingerprint: v.string(),
    pairingAuthorityProof: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!validFingerprint(args.saltFingerprint) || !validPairingProof(args.pairingAuthorityProof)) {
      throw new Error("memory identity configuration is invalid");
    }
    const existing = await getDeploymentRow(ctx);
    if (!existing) return { status: "unconfigured" as const };

    // Proof comparison comes first so arbitrary browser callers cannot mutate
    // identity health or probe the stored fingerprint.
    if (existing.pairingAuthorityProof !== args.pairingAuthorityProof) {
      return { status: "recovery_required" as const };
    }
    const now = timestamp(args.now);
    if (
      existing.saltFingerprint !== args.saltFingerprint ||
      (Boolean(existing.primaryOwnerKey) &&
        (!existing.primaryContainerTag ||
          !existing.primaryConversationId ||
          !existing.primaryRegisteredAt))
    ) {
      await ctx.db.patch(existing._id, {
        healthStatus: "recovery_required",
        updatedAt: now,
      });
      return { status: "recovery_required" as const };
    }
    if (existing.healthStatus === "recovery_required") {
      await ctx.db.patch(existing._id, {
        healthStatus: undefined,
        updatedAt: now,
      });
    }
    return { status: "ready" as const };
  },
});

export const getIdentityPresence = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", DEPLOYMENT_STATE_KEY))
      .unique();
    return {
      hasSaltFingerprint: Boolean(row?.saltFingerprint),
      hasPairingAuthority: Boolean(row?.pairingAuthorityProof),
      hasPrimaryOwner: Boolean(row?.primaryOwnerKey),
      recoveryRequired: row?.healthStatus === "recovery_required",
    };
  },
});

export const registerPrimaryOwner = mutation({
  args: {
    ownerKey: v.string(),
    containerTag: v.string(),
    conversationId: v.string(),
    saltFingerprint: v.string(),
    pairingAuthorityProof: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (
      !validOwnerKey(args.ownerKey) ||
      args.containerTag !== `daniel-user-${args.ownerKey}` ||
      !validSmsConversation(args.conversationId) ||
      !validFingerprint(args.saltFingerprint) ||
      !validPairingProof(args.pairingAuthorityProof)
    ) {
      throw new Error("primary memory owner registration is invalid");
    }
    const existing = await getDeploymentRow(ctx);
    if (
      !existing ||
      existing.saltFingerprint !== args.saltFingerprint ||
      existing.pairingAuthorityProof !== args.pairingAuthorityProof ||
      existing.healthStatus === "recovery_required"
    ) {
      return { status: "recovery_required" as const };
    }
    if (existing.primaryOwnerKey) {
      const identical =
        existing.primaryOwnerKey === args.ownerKey &&
        existing.primaryContainerTag === args.containerTag &&
        existing.primaryConversationId === args.conversationId;
      return { status: identical ? ("existing" as const) : ("conflict" as const) };
    }
    const primaryRegisteredAt = timestamp(args.now);
    await ctx.db.patch(existing._id, {
      primaryOwnerKey: args.ownerKey,
      primaryContainerTag: args.containerTag,
      primaryConversationId: args.conversationId,
      primaryRegisteredAt,
      updatedAt: primaryRegisteredAt,
    });
    return { status: "registered" as const };
  },
});

/** Protected by a proof that is derived from the server-only identity salt. */
export const getPrimaryOwnerForServer = query({
  args: { pairingAuthorityProof: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", DEPLOYMENT_STATE_KEY))
      .unique();
    if (!row || row.pairingAuthorityProof !== args.pairingAuthorityProof) return null;
    if (
      !row.primaryOwnerKey ||
      !row.primaryContainerTag ||
      !row.primaryConversationId ||
      !row.primaryRegisteredAt
    ) {
      return null;
    }
    return {
      ownerKey: row.primaryOwnerKey,
      containerTag: row.primaryContainerTag,
      conversationId: row.primaryConversationId,
      registeredAt: row.primaryRegisteredAt,
    };
  },
});

export const getContainerState = query({
  args: {
    containerTag: v.string(),
    pairingAuthorityProof: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    } catch {
      return null;
    }
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
    pairingAuthorityProof: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const deployment = await requireMemoryServerAuthority(
      ctx,
      args.pairingAuthorityProof,
    );
    if (
      deployment.saltFingerprint !== args.saltFingerprint
    ) {
      throw new Error("memory identity recovery is required");
    }
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
      return { initialized: true };
    }

    await ctx.db.insert("memoryProviderState", {
      stateKey,
      scope: "container",
      containerTag: args.containerTag,
      saltFingerprint: args.saltFingerprint,
      initializedAt: args.initializedAt,
      updatedAt: timestamp(args.now),
    });
    return { initialized: true };
  },
});

export const updateHealth = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    healthStatus: healthStatusValidator,
    error: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const now = timestamp(args.now);
    const patch = {
      healthStatus: args.healthStatus,
      ...(args.error === undefined ? {} : { lastError: normalizeError(args.error) }),
      updatedAt: now,
    };
    await ctx.db.patch(existing._id, patch);
    return { updated: true };
  },
});

export const recordSuccess = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    jobId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    providerDocumentId: v.optional(v.string()),
    providerMemoryIds: v.optional(v.array(v.string())),
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const now = timestamp(args.at);
    const patch = {
      healthStatus: "healthy" as const,
      lastSuccessfulSubmissionAt: now,
      lastError: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(existing._id, patch);
    return { updated: true };
  },
});

export const recordFailure = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    jobId: v.optional(v.string()),
    kind: v.optional(jobKindValidator),
    error: v.string(),
    retryable: v.optional(v.boolean()),
    deadLetter: v.optional(v.boolean()),
    healthStatus: v.optional(
      v.union(v.literal("degraded"), v.literal("unavailable")),
    ),
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const now = timestamp(args.at);
    const patch = {
      healthStatus:
        args.healthStatus ??
        (args.retryable === false ? ("unavailable" as const) : ("degraded" as const)),
      lastFailedSubmissionAt: now,
      lastError: normalizeError(args.error),
      updatedAt: now,
    };
    await ctx.db.patch(existing._id, patch);
    return { updated: true };
  },
});

export const heartbeat = mutation({
  args: {
    pairingAuthorityProof: v.string(),
    workerId: v.optional(v.string()),
    activity: v.optional(v.string()),
    jobId: v.optional(v.string()),
    at: v.optional(v.number()),
    healthStatus: v.optional(healthStatusValidator),
  },
  handler: async (ctx, args) => {
    const existing = await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof);
    const now = timestamp(args.at);
    const patch = {
      lastWorkerActivityAt: now,
      ...(args.healthStatus === undefined ? {} : { healthStatus: args.healthStatus }),
      updatedAt: now,
    };
    await ctx.db.patch(existing._id, patch);
    return { updated: true };
  },
});

export const getDeploymentState = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", DEPLOYMENT_STATE_KEY))
      .unique();
    if (!row) return null;
    return {
      healthStatus: row.healthStatus,
      lastSuccessfulSubmissionAt: row.lastSuccessfulSubmissionAt,
      lastFailedSubmissionAt: row.lastFailedSubmissionAt,
      hasError: Boolean(row.lastError),
      lastWorkerActivityAt: row.lastWorkerActivityAt,
      updatedAt: row.updatedAt,
      primaryOwnerRegistered: Boolean(row.primaryOwnerKey),
    };
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
