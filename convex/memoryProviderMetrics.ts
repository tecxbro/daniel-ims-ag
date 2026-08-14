import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const BUCKET_MS = 60 * 60 * 1_000;
const MAX_RECENT_BUCKETS = 24 * 31;
const LATENCY_BOUNDS_MS = [100, 250, 500, 1_000, 2_500] as const;

function bucketIndex(latencyMs: number): number {
  const index = LATENCY_BOUNDS_MS.findIndex((bound) => latencyMs <= bound);
  return index === -1 ? LATENCY_BOUNDS_MS.length : index;
}

export const recordHydration = mutation({
  args: {
    at: v.number(),
    failed: v.boolean(),
    latencyMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const bucketStart = Math.floor(args.at / BUCKET_MS) * BUCKET_MS;
    const existing = await ctx.db
      .query("memoryProviderMetrics")
      .withIndex("by_bucket_start", (q) => q.eq("bucketStart", bucketStart))
      .unique();
    const latencyMs = Math.max(0, args.latencyMs ?? 0);
    const latencyBuckets = existing?.latencyBuckets.slice() ?? Array<number>(6).fill(0);
    if (args.latencyMs !== undefined) latencyBuckets[bucketIndex(latencyMs)] += 1;
    if (existing) {
      await ctx.db.patch(existing._id, {
        requestCount: existing.requestCount + 1,
        failureCount: existing.failureCount + (args.failed ? 1 : 0),
        totalLatencyMs: existing.totalLatencyMs + latencyMs,
        latencyBuckets,
        updatedAt: args.at,
      });
      return existing._id;
    }
    return await ctx.db.insert("memoryProviderMetrics", {
      bucketStart,
      requestCount: 1,
      failureCount: args.failed ? 1 : 0,
      totalLatencyMs: latencyMs,
      latencyBuckets,
      updatedAt: args.at,
    });
  },
});

export const recent = query({
  args: { since: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(MAX_RECENT_BUCKETS, Math.floor(args.limit ?? 168)));
    return await ctx.db
      .query("memoryProviderMetrics")
      .withIndex("by_bucket_start", (q) => q.gte("bucketStart", args.since))
      .order("desc")
      .take(limit);
  },
});
