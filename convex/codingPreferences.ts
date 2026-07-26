import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const storePreference = mutation({
  args: {
    conversationId: v.string(),
    key: v.string(),
    value: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("codingPreferences")
      .withIndex("by_conversation_and_key", (q) =>
        q.eq("conversationId", args.conversationId).eq("key", args.key),
      )
      .unique();
    const patch = { value: args.value, updatedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("codingPreferences", {
      conversationId: args.conversationId,
      key: args.key,
      ...patch,
    });
  },
});

export const getPreference = query({
  args: { conversationId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingPreferences")
      .withIndex("by_conversation_and_key", (q) =>
        q.eq("conversationId", args.conversationId).eq("key", args.key),
      )
      .unique();
  },
});
