import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createPendingDecision = mutation({
  args: {
    conversationId: v.string(),
    prompt: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("pendingDecisions", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const latestPendingDecision = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pendingDecisions")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending"),
      )
      .order("desc")
      .first();
  },
});
