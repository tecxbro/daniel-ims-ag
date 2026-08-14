import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";

const MAX_BATCH_STORAGE_IDS = 200;
const OWNER_SUMMARY_COUNT_LIMIT = 10_000;

const statusV = v.union(v.literal("pending"), v.literal("active"), v.literal("released"));

type ImageAnchor = Doc<"memoryImageAnchors">;

function requireText(value: string, label: string, maxLength = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters`);
  }
  return normalized;
}

export function isRetainingImageAnchor(status: ImageAnchor["status"]): boolean {
  return status === "pending" || status === "active";
}

function assertOwner(anchor: ImageAnchor | null, ownerKey: string): ImageAnchor | null {
  if (!anchor) return null;
  if (anchor.ownerKey !== ownerKey) {
    // Do not reveal whether another owner has the same opaque capability.
    throw new Error("Image anchor not found");
  }
  return anchor;
}

async function anchorsByCustomId(
  ctx: QueryCtx | MutationCtx,
  customId: string,
): Promise<ImageAnchor[]> {
  return await ctx.db
    .query("memoryImageAnchors")
    .withIndex("by_custom_id", (q) => q.eq("customId", customId))
    .order("desc")
    .take(10);
}

async function anchorByCustomId(
  ctx: QueryCtx | MutationCtx,
  customId: string,
): Promise<ImageAnchor | null> {
  const anchors = await anchorsByCustomId(ctx, customId);
  if (anchors.length > 1) throw new Error("Duplicate image anchor customId");
  return anchors[0] ?? null;
}

async function requireStoredFile(ctx: MutationCtx, storageId: Id<"_storage">): Promise<void> {
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) throw new Error("Image storage file not found");
}

export const createPending = mutation({
  args: {
    storageId: v.id("_storage"),
    ownerKey: v.string(),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    customId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await requireStoredFile(ctx, args.storageId);
    const ownerKey = requireText(args.ownerKey, "ownerKey");
    const customId = requireText(args.customId, "customId", 100);
    const reason = requireText(args.reason, "reason", 1_000);
    const existing = assertOwner(await anchorByCustomId(ctx, customId), ownerKey);
    if (existing) {
      if (existing.storageId !== args.storageId) throw new Error("Image anchor customId collision");
      if (isRetainingImageAnchor(existing.status)) return existing;
      const replacement = {
        storageId: existing.storageId,
        ownerKey,
        ...(args.conversationId ? { conversationId: args.conversationId } : {}),
        ...(args.turnId ? { turnId: args.turnId } : {}),
        customId,
        status: "pending" as const,
        reason,
        createdAt: Date.now(),
      };
      await ctx.db.replace(existing._id, replacement);
      return { ...replacement, _id: existing._id, _creationTime: existing._creationTime };
    }
    const createdAt = Date.now();
    const id = await ctx.db.insert("memoryImageAnchors", {
      storageId: args.storageId,
      ownerKey,
      conversationId: args.conversationId,
      turnId: args.turnId,
      customId,
      status: "pending",
      reason,
      createdAt,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("Failed to create image anchor");
    return created;
  },
});

export const activate = mutation({
  args: {
    customId: v.string(),
    ownerKey: v.string(),
    providerDocumentId: v.string(),
  },
  handler: async (ctx, args) => {
    const anchor = assertOwner(await anchorByCustomId(ctx, args.customId), args.ownerKey);
    if (!anchor) throw new Error("Image anchor not found");
    const providerDocumentId = requireText(args.providerDocumentId, "providerDocumentId");
    if (anchor.status === "active") {
      if (anchor.providerDocumentId !== providerDocumentId) {
        throw new Error("Image anchor is active for a different provider document");
      }
      return anchor;
    }
    if (anchor.status !== "pending") throw new Error("Released image anchor cannot be activated");
    await ctx.db.patch(anchor._id, { status: "active", providerDocumentId });
    return { ...anchor, status: "active" as const, providerDocumentId };
  },
});

export const getActiveByStorageId = query({
  args: { storageId: v.id("_storage"), ownerKey: v.string() },
  handler: async (ctx, args) => {
    const anchors = await ctx.db
      .query("memoryImageAnchors")
      .withIndex("by_storage_id", (q) => q.eq("storageId", args.storageId))
      .order("desc")
      .take(10);
    return anchors.find(
      (anchor) => anchor.ownerKey === args.ownerKey && anchor.status === "active",
    ) ?? null;
  },
});

export const loadActiveByCustomId = query({
  args: { customId: v.string(), ownerKey: v.string() },
  handler: async (ctx, args) => {
    const anchor = assertOwner(await anchorByCustomId(ctx, args.customId), args.ownerKey);
    return anchor?.status === "active" ? anchor : null;
  },
});

export const listByCustomId = query({
  args: { customId: v.string(), ownerKey: v.string(), status: v.optional(statusV) },
  handler: async (ctx, args) => {
    const anchors = await anchorsByCustomId(ctx, args.customId);
    const foreign = anchors.some((anchor) => anchor.ownerKey !== args.ownerKey);
    if (foreign) throw new Error("Image anchor not found");
    return anchors.filter((anchor) => args.status === undefined || anchor.status === args.status);
  },
});

export const listByStatus = query({
  args: { status: statusV, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(500, Math.floor(args.limit ?? 100)));
    return await ctx.db
      .query("memoryImageAnchors")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("desc")
      .take(limit);
  },
});

/** Aggregate-only verification data for the local cutover control plane. */
export const getOwnerSummary = query({
  args: { ownerKey: v.string() },
  handler: async (ctx, args) => {
    const statuses = ["pending", "active", "released"] as const;
    const entries = await Promise.all(
      statuses.map(async (status) => {
        const rows = await ctx.db
          .query("memoryImageAnchors")
          .withIndex("by_owner_key_and_status", (q) =>
            q.eq("ownerKey", args.ownerKey).eq("status", status),
          )
          .take(OWNER_SUMMARY_COUNT_LIMIT + 1);
        return [status, rows] as const;
      }),
    );
    const counts = Object.fromEntries(
      entries.map(([status, rows]) => [
        status,
        Math.min(rows.length, OWNER_SUMMARY_COUNT_LIMIT),
      ]),
    ) as Record<(typeof statuses)[number], number>;
    return {
      ...counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      activeWithoutProviderId: entries
        .find(([status]) => status === "active")![1]
        .slice(0, OWNER_SUMMARY_COUNT_LIMIT)
        .filter((row) => !row.providerDocumentId).length,
      truncated: entries.some(([, rows]) => rows.length > OWNER_SUMMARY_COUNT_LIMIT),
    };
  },
});

/** Cleanup-facing lookup. Any pending or active row makes the blob retained. */
export const findRetainedStorageIds = query({
  args: { storageIds: v.array(v.id("_storage")) },
  handler: async (ctx, args) => {
    const storageIds = [...new Set(args.storageIds)];
    if (storageIds.length > MAX_BATCH_STORAGE_IDS) {
      throw new Error(`storageIds is limited to ${MAX_BATCH_STORAGE_IDS} items`);
    }
    const retained: Id<"_storage">[] = [];
    for (const storageId of storageIds) {
      const anchors = await ctx.db
        .query("memoryImageAnchors")
        .withIndex("by_storage_id", (q) => q.eq("storageId", storageId))
        .order("desc")
        .take(10);
      if (anchors.some((anchor) => isRetainingImageAnchor(anchor.status))) retained.push(storageId);
    }
    return retained;
  },
});

export const releaseAfterProviderDeletion = mutation({
  args: {
    customId: v.string(),
    ownerKey: v.string(),
    providerDocumentId: v.string(),
    providerDeletionConfirmed: v.boolean(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!args.providerDeletionConfirmed) {
      throw new Error("Provider deletion must be confirmed before releasing an image anchor");
    }
    const anchor = assertOwner(await anchorByCustomId(ctx, args.customId), args.ownerKey);
    if (!anchor) throw new Error("Image anchor not found");
    if (anchor.providerDocumentId !== args.providerDocumentId) {
      throw new Error("Provider document does not match the image anchor");
    }
    if (anchor.status === "released") return anchor;
    if (anchor.status !== "active") {
      throw new Error("Provider document does not match the active image anchor");
    }
    const releasedAt = args.now ?? Date.now();
    await ctx.db.patch(anchor._id, { status: "released", releasedAt });
    return { ...anchor, status: "released" as const, releasedAt };
  },
});

/** Narrow insertion point for the migration implementation; it does not choose policy. */
export const insertForMigration = internalMutation({
  args: {
    storageId: v.id("_storage"),
    ownerKey: v.string(),
    conversationId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    customId: v.string(),
    providerDocumentId: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("active")),
    reason: v.string(),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireStoredFile(ctx, args.storageId);
    if (args.status === "active" && !args.providerDocumentId) {
      throw new Error("Active migrated anchors require providerDocumentId");
    }
    const existing = assertOwner(await anchorByCustomId(ctx, args.customId), args.ownerKey);
    if (existing) {
      if (existing.storageId !== args.storageId) throw new Error("Image anchor customId collision");
      return existing;
    }
    const id = await ctx.db.insert("memoryImageAnchors", {
      storageId: args.storageId,
      ownerKey: requireText(args.ownerKey, "ownerKey"),
      conversationId: args.conversationId,
      turnId: args.turnId,
      customId: requireText(args.customId, "customId", 100),
      providerDocumentId: args.providerDocumentId,
      status: args.status,
      reason: requireText(args.reason, "reason", 1_000),
      createdAt: args.createdAt ?? Date.now(),
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("Failed to insert migrated image anchor");
    return created;
  },
});

/** Rechecks anchors transactionally immediately before deleting storage bytes. */
export const deleteStorageIfUnretained = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const anchors = await ctx.db
      .query("memoryImageAnchors")
      .withIndex("by_storage_id", (q) => q.eq("storageId", args.storageId))
      .order("desc")
      .take(10);
    if (anchors.some((anchor) => isRetainingImageAnchor(anchor.status))) {
      return { deleted: false as const, reason: "anchored" as const };
    }
    await ctx.storage.delete(args.storageId);
    return { deleted: true as const };
  },
});
