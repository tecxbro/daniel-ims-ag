import { query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("conversations").order("desc").take(50);
  },
});

export const get = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
  },
});
