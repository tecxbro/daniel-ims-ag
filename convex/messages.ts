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

const HISTORY_MAX_TURNS = 10;
const HISTORY_MAX_CHARACTERS = 16_000;
const HISTORY_MESSAGE_MAX_CHARACTERS = 4_000;
const HISTORY_SCAN_LIMIT = 200;
const HISTORY_TRUNCATION_MARKER = "\n… [prior message truncated] …\n";
const HISTORY_TURN_FIXED_CHARACTERS =
  "USER: ".length + "\nASSISTANT: ".length;

function safePrefix(value: string, length: number): string {
  let end = Math.max(0, Math.min(value.length, length));
  const trailing = value.charCodeAt(end - 1);
  if (trailing >= 0xd800 && trailing <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function safeSuffix(value: string, length: number): string {
  let start = Math.max(0, value.length - Math.max(0, length));
  const leading = value.charCodeAt(start);
  if (leading >= 0xdc00 && leading <= 0xdfff) start += 1;
  return value.slice(start);
}

function truncateHistoryMessage(
  content: string,
  maxCharacters: number,
): { content: string; truncated: boolean } {
  if (content.length <= maxCharacters) {
    return { content, truncated: false };
  }
  if (maxCharacters <= HISTORY_TRUNCATION_MARKER.length) {
    return {
      content: safePrefix(content, maxCharacters),
      truncated: true,
    };
  }
  const contentCharacters = maxCharacters - HISTORY_TRUNCATION_MARKER.length;
  const prefixCharacters = Math.ceil(contentCharacters * 0.75);
  const suffixCharacters = contentCharacters - prefixCharacters;
  return {
    content:
      safePrefix(content, prefixCharacters) +
      HISTORY_TRUNCATION_MARKER +
      safeSuffix(content, suffixCharacters),
    truncated: true,
  };
}

/**
 * Returns the newest complete prior turns, already bounded for prompt use.
 * The inbound row is an exact chronology boundary, so a later concurrent turn
 * cannot leak into this turn's prompt even if it finishes first.
 */
export const recentCompleteTurns = query({
  args: {
    conversationId: v.string(),
    beforeMessageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const inbound = await ctx.db.get(args.beforeMessageId);
    if (
      !inbound ||
      inbound.conversationId !== args.conversationId ||
      inbound.role !== "user" ||
      !inbound.turnId
    ) {
      return [];
    }

    type HistoryRow = typeof inbound;
    type PendingTurn = {
      turnId: string;
      user?: HistoryRow;
      assistant?: HistoryRow;
    };

    const pending = new Map<string, PendingTurn>();
    const completedTurnIds = new Set<string>();
    const completeNewestFirst: Array<Required<PendingTurn>> = [];
    const rows = ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q
          .eq("conversationId", args.conversationId)
          .lt("_creationTime", inbound._creationTime),
      )
      .order("desc");

    let scanned = 0;
    for await (const row of rows) {
      scanned += 1;
      if (scanned > HISTORY_SCAN_LIMIT) break;
      if (
        !row.turnId ||
        row.turnId === inbound.turnId ||
        completedTurnIds.has(row.turnId) ||
        (row.role !== "user" && row.role !== "assistant")
      ) {
        continue;
      }

      const turn = pending.get(row.turnId) ?? { turnId: row.turnId };
      if (row.role === "user" && !turn.user) turn.user = row;
      if (row.role === "assistant" && !turn.assistant) turn.assistant = row;
      pending.set(row.turnId, turn);
      if (turn.user && turn.assistant) {
        completeNewestFirst.push(turn as Required<PendingTurn>);
        completedTurnIds.add(row.turnId);
        pending.delete(row.turnId);
        if (completeNewestFirst.length === HISTORY_MAX_TURNS) break;
      }
    }

    const selectedNewestFirst: Array<{
      turnId: string;
      user: { content: string; truncated: boolean };
      assistant: { content: string; truncated: boolean };
    }> = [];
    let usedCharacters = 0;

    for (const turn of completeNewestFirst) {
      const separatorCharacters = selectedNewestFirst.length === 0 ? 0 : 2;
      const availableContentCharacters =
        HISTORY_MAX_CHARACTERS -
        usedCharacters -
        separatorCharacters -
        HISTORY_TURN_FIXED_CHARACTERS;
      if (availableContentCharacters < 2) break;

      let userLimit = Math.min(
        turn.user.content.length,
        HISTORY_MESSAGE_MAX_CHARACTERS,
      );
      let assistantLimit = Math.min(
        turn.assistant.content.length,
        HISTORY_MESSAGE_MAX_CHARACTERS,
      );
      let overflow =
        userLimit + assistantLimit - availableContentCharacters;
      if (overflow > 0) {
        const assistantReduction = Math.min(
          overflow,
          Math.max(0, assistantLimit - 1),
        );
        assistantLimit -= assistantReduction;
        overflow -= assistantReduction;
      }
      if (overflow > 0) {
        userLimit -= Math.min(overflow, Math.max(0, userLimit - 1));
      }
      if (userLimit < 1 || assistantLimit < 1) break;

      const user = truncateHistoryMessage(turn.user.content, userLimit);
      const assistant = truncateHistoryMessage(
        turn.assistant.content,
        assistantLimit,
      );
      selectedNewestFirst.push({ turnId: turn.turnId, user, assistant });
      usedCharacters +=
        separatorCharacters +
        HISTORY_TURN_FIXED_CHARACTERS +
        user.content.length +
        assistant.content.length;
      if (usedCharacters >= HISTORY_MAX_CHARACTERS) break;
    }

    return selectedNewestFirst.reverse();
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
