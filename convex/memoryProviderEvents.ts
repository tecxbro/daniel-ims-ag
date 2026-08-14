import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const operationValidator = v.union(
  v.literal("hydration"),
  v.literal("profile"),
  v.literal("search"),
  v.literal("documents"),
  v.literal("entries"),
);

export const record = mutation({
  args: {
    eventId: v.string(),
    operation: operationValidator,
    outcome: v.union(v.literal("success"), v.literal("failure")),
    latencyMs: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("memoryProviderEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("memoryProviderEvents", {
      ...args,
      errorCode: args.errorCode?.slice(0, 80),
      latencyMs:
        args.latencyMs === undefined ? undefined : Math.max(0, args.latencyMs),
    });
  },
});

export const recent = query({
  args: { since: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(200, Math.floor(args.limit ?? 50)));
    return await ctx.db
      .query("memoryProviderEvents")
      .withIndex("by_created_at", (q) => q.gte("createdAt", args.since))
      .order("desc")
      .take(limit);
  },
});
