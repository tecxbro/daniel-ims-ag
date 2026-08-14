import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const DEMO_PREFIX = "demo:";
const DEMO_SETTING_KEY = "debug_demo_mode";
const DEMO_DEPLOYMENT_STATE_KEY = `${DEMO_PREFIX}deployment`;
const DEMO_CONTAINER_STATE_KEY = `${DEMO_PREFIX}container:primary`;
const DEMO_OWNER_KEY = `${DEMO_PREFIX}owner`;
const DEMO_CONTAINER_TAG = `${DEMO_PREFIX}container`;
const DEMO_ROW_LIMIT = 100;
const MINUTE = 60 * 1000;

type SyncJobSeed = {
  suffix: string;
  status:
    | "pending"
    | "processing"
    | "submitted"
    | "completed"
    | "failed"
    | "dead_letter";
  attempts: number;
  ageMinutes: number;
  providerDocumentId?: string;
  providerMemoryIds?: string[];
  lastError?: string;
};

type AnchorSeed = {
  suffix: string;
  status: "pending" | "active" | "released";
  providerDocumentId?: string;
};

interface DemoCounts {
  providerStates: number;
  syncJobs: number;
  imageAnchors: number;
  // Zero-valued aliases keep the Settings panel compatible without creating
  // ordinary application data for an operational dashboard preview.
  conversations: 0;
  messages: 0;
  agents: 0;
  agentLogs: 0;
  memories: 0;
  automationRuns: 0;
}

const syncJobSeeds: readonly SyncJobSeed[] = [
  {
    suffix: "capture-pending",
    status: "pending",
    attempts: 0,
    ageMinutes: 2,
  },
  {
    suffix: "capture-pending-retry",
    status: "pending",
    attempts: 0,
    ageMinutes: 4,
  },
  {
    suffix: "capture-processing",
    status: "processing",
    attempts: 1,
    ageMinutes: 6,
  },
  {
    suffix: "capture-submitted",
    status: "submitted",
    attempts: 1,
    ageMinutes: 9,
    providerDocumentId: `${DEMO_PREFIX}provider:document:submitted`,
  },
  {
    suffix: "capture-completed",
    status: "completed",
    attempts: 1,
    ageMinutes: 13,
    providerDocumentId: `${DEMO_PREFIX}provider:document:capture`,
    providerMemoryIds: [`${DEMO_PREFIX}provider:memory:capture`],
  },
  {
    suffix: "capture-completed-retry",
    status: "completed",
    attempts: 1,
    ageMinutes: 18,
    providerDocumentId: `${DEMO_PREFIX}provider:document:capture-retry`,
    providerMemoryIds: [`${DEMO_PREFIX}provider:memory:capture-retry`],
  },
  {
    suffix: "capture-failed",
    status: "failed",
    attempts: 2,
    ageMinutes: 38,
    lastError: "Demo provider timeout; retry is scheduled.",
  },
  {
    suffix: "capture-dead-letter",
    status: "dead_letter",
    attempts: 5,
    ageMinutes: 52,
    lastError: "Demo conversation capture exhausted the retry policy.",
  },
] as const;

const anchorSeeds: readonly AnchorSeed[] = [
  { suffix: "pending", status: "pending" },
  {
    suffix: "active",
    status: "active",
    providerDocumentId: `${DEMO_PREFIX}provider:image:active`,
  },
  {
    suffix: "released",
    status: "released",
    providerDocumentId: `${DEMO_PREFIX}provider:image:released`,
  },
] as const;

function emptyCounts(): DemoCounts {
  return {
    providerStates: 0,
    syncJobs: 0,
    imageAnchors: 0,
    conversations: 0,
    messages: 0,
    agents: 0,
    agentLogs: 0,
    memories: 0,
    automationRuns: 0,
  };
}

function operationalTotal(counts: DemoCounts): number {
  return counts.providerStates + counts.syncJobs + counts.imageAnchors;
}

function syncJobId(seed: SyncJobSeed): string {
  return `${DEMO_PREFIX}sync:${seed.suffix}`;
}

function syncJobCustomId(seed: SyncJobSeed): string {
  return `${DEMO_PREFIX}content:${seed.suffix}`;
}

function syncJobPayload(seed: SyncJobSeed): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "conversation_turn",
    ingestionStrategy: "delta_turn_v1",
    providerInput: {
      content: `Demo conversation turn ${seed.suffix}`,
      containerTag: DEMO_CONTAINER_TAG,
      customId: syncJobCustomId(seed),
      taskType: "memory",
    },
  });
}

function anchorCustomId(seed: AnchorSeed): string {
  return `${DEMO_PREFIX}anchor:${seed.suffix}`;
}

async function readDemoSetting(ctx: QueryCtx | MutationCtx) {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", DEMO_SETTING_KEY))
    .unique();
  return row?.value ?? null;
}

async function setDemoSetting(ctx: MutationCtx, enabled: boolean) {
  const existing = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", DEMO_SETTING_KEY))
    .unique();
  const value = enabled ? "true" : "false";
  if (existing) {
    await ctx.db.patch(existing._id, { value, updatedAt: Date.now() });
    return;
  }
  await ctx.db.insert("settings", {
    key: DEMO_SETTING_KEY,
    value,
    updatedAt: Date.now(),
  });
}

async function demoCounts(ctx: QueryCtx | MutationCtx): Promise<DemoCounts> {
  const counts = emptyCounts();
  const [deploymentState, containerState, syncJobs, anchors] =
    await Promise.all([
      ctx.db
        .query("memoryProviderState")
        .withIndex("by_state_key", (q) =>
          q.eq("stateKey", DEMO_DEPLOYMENT_STATE_KEY),
        )
        .unique(),
      ctx.db
        .query("memoryProviderState")
        .withIndex("by_state_key", (q) =>
          q.eq("stateKey", DEMO_CONTAINER_STATE_KEY),
        )
        .unique(),
      Promise.all(
        syncJobSeeds.map((seed) =>
          ctx.db
            .query("memorySyncJobs")
            .withIndex("by_job_id", (q) => q.eq("jobId", syncJobId(seed)))
            .unique(),
        ),
      ),
      Promise.all(
        anchorSeeds.map((seed) =>
          ctx.db
            .query("memoryImageAnchors")
            .withIndex("by_custom_id", (q) =>
              q.eq("customId", anchorCustomId(seed)),
            )
            .take(DEMO_ROW_LIMIT),
        ),
      ),
    ]);

  counts.providerStates =
    Number(Boolean(deploymentState)) + Number(Boolean(containerState));
  counts.syncJobs = syncJobs.filter(Boolean).length;
  counts.imageAnchors = anchors.reduce((total, rows) => total + rows.length, 0);
  return counts;
}

async function deleteDemoRows(ctx: MutationCtx): Promise<DemoCounts> {
  const removed = emptyCounts();

  for (const seed of anchorSeeds) {
    const anchors = await ctx.db
      .query("memoryImageAnchors")
      .withIndex("by_custom_id", (q) => q.eq("customId", anchorCustomId(seed)))
      .take(DEMO_ROW_LIMIT);
    for (const anchor of anchors) {
      await ctx.db.delete(anchor._id);
      // Demo blobs are created solely for these namespaced anchors.
      await ctx.storage.delete(anchor.storageId);
      removed.imageAnchors += 1;
    }
  }

  for (const seed of syncJobSeeds) {
    const row = await ctx.db
      .query("memorySyncJobs")
      .withIndex("by_job_id", (q) => q.eq("jobId", syncJobId(seed)))
      .unique();
    if (!row) continue;
    await ctx.db.delete(row._id);
    removed.syncJobs += 1;
  }

  for (const stateKey of [
    DEMO_DEPLOYMENT_STATE_KEY,
    DEMO_CONTAINER_STATE_KEY,
  ]) {
    const row = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", stateKey))
      .unique();
    if (!row) continue;
    await ctx.db.delete(row._id);
    removed.providerStates += 1;
  }

  return removed;
}

async function seedDemoData(ctx: MutationCtx): Promise<DemoCounts> {
  const counts = emptyCounts();
  const now = Date.now();

  await ctx.db.insert("memoryProviderState", {
    stateKey: DEMO_DEPLOYMENT_STATE_KEY,
    scope: "deployment",
    healthStatus: "healthy",
    lastSuccessfulSubmissionAt: now - 3 * MINUTE,
    lastFailedSubmissionAt: now - 47 * MINUTE,
    lastError: "Demo retry recovered; the provider is healthy.",
    lastWorkerActivityAt: now - MINUTE,
    updatedAt: now - MINUTE,
  });
  await ctx.db.insert("memoryProviderState", {
    stateKey: DEMO_CONTAINER_STATE_KEY,
    scope: "container",
    containerTag: DEMO_CONTAINER_TAG,
    saltFingerprint: `${DEMO_PREFIX}salt-fingerprint`,
    initializedAt: now - 24 * 60 * MINUTE,
    updatedAt: now - 3 * MINUTE,
  });
  counts.providerStates = 2;

  for (const [index, seed] of syncJobSeeds.entries()) {
    const createdAt = now - seed.ageMinutes * MINUTE;
    const updatedAt = createdAt + Math.min(seed.ageMinutes, 2) * MINUTE;
    await ctx.db.insert("memorySyncJobs", {
      jobId: syncJobId(seed),
      kind: "conversation_turn",
      ownerKey: DEMO_OWNER_KEY,
      containerTag: DEMO_CONTAINER_TAG,
      customId: syncJobCustomId(seed),
      conversationId: `${DEMO_PREFIX}conversation`,
      turnId: `${DEMO_PREFIX}turn:${index + 1}`,
      payload: syncJobPayload(seed),
      payloadHash: String(index + 1).padStart(64, "0"),
      status: seed.status,
      providerDocumentId: seed.providerDocumentId,
      providerMemoryIds: seed.providerMemoryIds,
      attempts: seed.attempts,
      nextAttemptAt:
        seed.status === "failed"
          ? now + 10 * MINUTE
          : Math.max(createdAt, updatedAt),
      lastError: seed.lastError,
      createdAt,
      updatedAt,
    });
    counts.syncJobs += 1;
  }

  return counts;
}

export const isEnabled = internalQuery({
  args: {},
  handler: async (ctx) => (await readDemoSetting(ctx)) === "true",
});

const imageSeedValidator = v.object({
  storageId: v.id("_storage"),
  customId: v.string(),
  status: v.union(
    v.literal("pending"),
    v.literal("active"),
    v.literal("released"),
  ),
  providerDocumentId: v.optional(v.string()),
});

export const insertImageAnchors = internalMutation({
  args: { images: v.array(imageSeedValidator), now: v.number() },
  handler: async (ctx, args) => {
    if (args.images.length > anchorSeeds.length) {
      throw new Error(
        `dashboard demo accepts at most ${anchorSeeds.length} image anchors`,
      );
    }
    if ((await readDemoSetting(ctx)) !== "true") {
      for (const image of args.images)
        await ctx.storage.delete(image.storageId);
      return { inserted: 0 };
    }

    let inserted = 0;
    for (const [index, image] of args.images.entries()) {
      const existing = await ctx.db
        .query("memoryImageAnchors")
        .withIndex("by_custom_id", (q) => q.eq("customId", image.customId))
        .take(DEMO_ROW_LIMIT);
      if (existing.length > 0) {
        await ctx.storage.delete(image.storageId);
        continue;
      }
      await ctx.db.insert("memoryImageAnchors", {
        storageId: image.storageId,
        ownerKey: DEMO_OWNER_KEY,
        conversationId: `${DEMO_PREFIX}conversation`,
        turnId: `${DEMO_PREFIX}image-turn:${index + 1}`,
        customId: image.customId,
        providerDocumentId: image.providerDocumentId,
        status: image.status,
        reason: `Implementation 10 dashboard demo ${image.status} image anchor`,
        createdAt: args.now - (index + 1) * 20 * MINUTE,
        releasedAt:
          image.status === "released" ? args.now - 5 * MINUTE : undefined,
      });
      inserted += 1;
    }
    return { inserted };
  },
});

/**
 * File writes are action-only in Convex. `setMode` schedules this internal
 * action, which rechecks the setting before and during the insert so a quick
 * disable cannot leave late demo anchors behind.
 */
export const seedImageAnchors = internalAction({
  args: {},
  handler: async (ctx): Promise<{ inserted: number }> => {
    const enabled: boolean = await ctx.runQuery(internal.demo.isEnabled, {});
    if (!enabled) return { inserted: 0 };

    const stored: Array<{
      storageId: Id<"_storage">;
      customId: string;
      status: AnchorSeed["status"];
      providerDocumentId?: string;
    }> = [];
    try {
      for (const seed of anchorSeeds) {
        const storageId = await ctx.storage.store(
          new Blob(
            [
              `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#10b981"/></svg>`,
            ],
            { type: "image/svg+xml" },
          ),
        );
        stored.push({
          storageId,
          customId: anchorCustomId(seed),
          status: seed.status,
          providerDocumentId: seed.providerDocumentId,
        });
      }
      const result: { inserted: number } = await ctx.runMutation(
        internal.demo.insertImageAnchors,
        { images: stored, now: Date.now() },
      );
      return result;
    } catch (error) {
      for (const image of stored) await ctx.storage.delete(image.storageId);
      throw error;
    }
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    const [setting, counts] = await Promise.all([
      readDemoSetting(ctx),
      demoCounts(ctx),
    ]);
    const total = operationalTotal(counts);
    return {
      enabled: setting === "true",
      seeded: total > 0,
      counts,
      total,
      scanLimit: DEMO_ROW_LIMIT,
    };
  },
});

export const setMode = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    const removed = await deleteDemoRows(ctx);
    const seeded = args.enabled ? await seedDemoData(ctx) : null;
    await setDemoSetting(ctx, args.enabled);
    if (args.enabled) {
      await ctx.scheduler.runAfter(0, internal.demo.seedImageAnchors, {});
    }
    const counts = seeded ?? emptyCounts();
    return {
      enabled: args.enabled,
      removed,
      seeded,
      counts,
      total: operationalTotal(counts),
    };
  },
});
