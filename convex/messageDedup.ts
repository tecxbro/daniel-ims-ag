import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const claim = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messageDedup")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) return { claimed: false };
    await ctx.db.insert("messageDedup", {
      key: args.key,
      claimedAt: Date.now(),
    });
    return { claimed: true };
  },
});
