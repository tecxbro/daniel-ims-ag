import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const pendingStatusV = v.union(
  v.literal("pending"),
  v.literal("answered"),
  v.literal("expired"),
  v.literal("cancelled"),
);

export const createPendingInput = mutation({
  args: {
    projectId: v.id("codingProjects"),
    sessionId: v.id("codingSessions"),
    conversationId: v.string(),
    codexRequestId: v.string(),
    codexQuestionId: v.optional(v.string()),
    question: v.string(),
    questionsJson: v.optional(v.string()),
    options: v.optional(v.array(v.string())),
    allowFreeform: v.boolean(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("codingPendingInputs", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const answerPendingInput = mutation({
  args: {
    pendingInputId: v.id("codingPendingInputs"),
    answer: v.string(),
  },
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.pendingInputId);
    if (!pending || pending.status !== "pending") return null;
    await ctx.db.patch(args.pendingInputId, {
      status: "answered",
      answer: args.answer,
      answeredAt: Date.now(),
    });
    return pending;
  },
});

export const updatePendingInputStatus = mutation({
  args: {
    pendingInputId: v.id("codingPendingInputs"),
    status: pendingStatusV,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pendingInputId, {
      status: args.status,
      ...(args.status === "answered" ? { answeredAt: Date.now() } : {}),
    });
    return args.pendingInputId;
  },
});

export const getPendingForConversation = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingPendingInputs")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending"),
      )
      .order("desc")
      .first();
  },
});

export const getByCodexRequestId = query({
  args: { codexRequestId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingPendingInputs")
      .withIndex("by_codexRequestId", (q) =>
        q.eq("codexRequestId", args.codexRequestId),
      )
      .first();
  },
});
