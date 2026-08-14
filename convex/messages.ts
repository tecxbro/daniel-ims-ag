import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  enqueueMemorySyncJob,
  jobKindValidator,
  type EnqueueMemorySyncJobArgs,
} from "./memorySyncJobs";
import { requireMemoryServerAuthority } from "./memoryProviderState";

interface MessageWriteArgs {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentId?: string;
  turnId?: string;
  imageStorageIds?: Id<"_storage">[];
  mediaError?: string;
}

async function updateConversationAfterInsert(
  ctx: MutationCtx,
  conversationId: string,
  now: number,
): Promise<void> {
  const conv = await ctx.db
    .query("conversations")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .unique();
  if (conv) {
    await ctx.db.patch(conv._id, {
      messageCount: conv.messageCount + 1,
      lastActivityAt: now,
    });
  } else {
    await ctx.db.insert("conversations", {
      conversationId,
      messageCount: 1,
      lastActivityAt: now,
    });
  }
}

async function insertMessage(
  ctx: MutationCtx,
  args: MessageWriteArgs,
  now: number,
) {
  const id = await ctx.db.insert("messages", { ...args, createdAt: now });
  await updateConversationAfterInsert(ctx, args.conversationId, now);
  return id;
}

export const send = mutation({
  args: {
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    mediaError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await insertMessage(ctx, args, now);
  },
});

/**
 * Commits one idempotent assistant turn and, when configured, its durable
 * conversation capture in the same transaction.
 */
export const persistAssistantTurn = mutation({
  args: {
    conversationId: v.string(),
    content: v.string(),
    turnId: v.string(),
    pairingAuthorityProof: v.optional(v.string()),
    job: v.optional(v.object({
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
    })),
  },
  handler: async (ctx, args) => {
    if (args.job && (args.job.kind !== "conversation_turn" || args.job.turnId !== args.turnId)) {
      throw new Error("assistant capture requires a matching conversation_turn job");
    }
    if (args.job && args.job.conversationId !== args.conversationId) {
      throw new Error("assistant capture conversation does not match the memory job");
    }
    if (args.job) {
      await requireMemoryServerAuthority(ctx, args.pairingAuthorityProof ?? "");
    }

    const existingMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id_and_turn_id_and_role", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .eq("turnId", args.turnId)
          .eq("role", "assistant"),
      )
      .take(2);
    if (existingMessages.length > 1) {
      throw new Error(`assistant turn has duplicate persisted rows: ${args.turnId}`);
    }
    const existingMessage = existingMessages[0];
    if (existingMessage && existingMessage.content !== args.content) {
      throw new Error(`assistant turn already has different content: ${args.turnId}`);
    }

    const jobResult = args.job
      ? await enqueueMemorySyncJob(ctx, args.job as EnqueueMemorySyncJobArgs)
      : null;
    const messageId =
      existingMessage?._id ??
      (await insertMessage(
        ctx,
        {
          conversationId: args.conversationId,
          role: "assistant",
          content: args.content,
          turnId: args.turnId,
        },
        args.job?.now ?? Date.now(),
      ));
    return {
      messageId,
      messageCreated: existingMessage === undefined,
      job: jobResult?.job,
      jobCreated: jobResult?.created ?? false,
      duplicate:
        existingMessage !== undefined && (jobResult === null || !jobResult.created),
    };
  },
});

export const list = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const recent = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 20);
    return msgs.reverse();
  },
});

/** Bounded source for local primary-owner pairing candidates. */
export const recentInboundSms = query({
  args: {
    pairingAuthorityProof: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", "deployment"))
      .unique();
    if (!state || state.pairingAuthorityProof !== args.pairingAuthorityProof) {
      return [];
    }
    const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 50)));
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_role_and_created_at", (q) => q.eq("role", "user"))
      .order("desc")
      .take(limit);
    return rows
      .filter((row) => /^sms:\+[1-9][0-9]{7,14}$/.test(row.conversationId))
      .map((row) => ({
        conversationId: row.conversationId,
        createdAt: row.createdAt,
      }));
  },
});

export const hasInboundUserMessage = query({
  args: {
    pairingAuthorityProof: v.string(),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("memoryProviderState")
      .withIndex("by_state_key", (q) => q.eq("stateKey", "deployment"))
      .unique();
    if (!state || state.pairingAuthorityProof !== args.pairingAuthorityProof) {
      return false;
    }
    if (!/^sms:\+[1-9][0-9]{7,14}$/.test(args.conversationId)) return false;
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(100);
    return rows.some((row) => row.role === "user");
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const getStorageUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const expiredWithImages = query({
  args: {
    olderThanMs: v.number(),
    cursor: v.optional(v.union(v.string(), v.null())),
    scanLimit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Cursor-based pagination over the by_createdAt index. Filtering after
    // pagination is unavoidable (Convex can't index on an array's emptiness),
    // but Convex's cursor keeps the scan bounded without timestamp tie gaps.
    const scanLimit = args.scanLimit ?? 200;
    const page = await ctx.db
      .query("messages")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", args.olderThanMs))
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: scanLimit });
    const imageRows = page.page.filter(
      (r) => Array.isArray(r.imageStorageIds) && r.imageStorageIds.length > 0,
    );
    return {
      rows: imageRows,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});

export const clearMessageImage = mutation({
  args: { messageId: v.id("messages"), storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.messageId);
    if (!row || !row.imageStorageIds) return;
    const remaining = row.imageStorageIds.filter((id) => id !== args.storageId);
    if (remaining.length === 0) {
      await ctx.db.patch(args.messageId, { imageStorageIds: undefined });
    } else {
      await ctx.db.patch(args.messageId, { imageStorageIds: remaining });
    }
  },
});

export const deleteImageBytes = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId);
  },
});
