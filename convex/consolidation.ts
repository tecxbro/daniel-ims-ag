import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusV = v.union(
  v.literal("running"),
  v.literal("completed"),
  v.literal("failed"),
);

function rejectLegacyConsolidationWrite(operation: string): never {
  throw new Error(
    `LEGACY_MEMORY_WRITE_FROZEN: ${operation} is disabled after the SuperMemory-only cutover`,
  );
}

export const createRun = mutation({
  args: { runId: v.string(), trigger: v.string() },
  handler: async () => {
    rejectLegacyConsolidationWrite("consolidation.createRun");
  },
});

export const updateRun = mutation({
  args: {
    runId: v.string(),
    status: v.optional(statusV),
    proposalsCount: v.optional(v.number()),
    mergedCount: v.optional(v.number()),
    prunedCount: v.optional(v.number()),
    notes: v.optional(v.string()),
    details: v.optional(v.string()),
  },
  handler: async () => {
    rejectLegacyConsolidationWrite("consolidation.updateRun");
  },
});

export const listRuns = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db.query("consolidationRuns").order("desc").take(args.limit ?? 25);
  },
});
