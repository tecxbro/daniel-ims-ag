import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const eventTypeV = v.union(
  v.literal("codex_thread_started"),
  v.literal("plan_delta"),
  v.literal("plan_final"),
  v.literal("question_requested"),
  v.literal("user_answered"),
  v.literal("tool_event"),
  v.literal("file_change"),
  v.literal("diff"),
  v.literal("final_response"),
  v.literal("error"),
);

export const appendCodingEvent = mutation({
  args: {
    projectId: v.id("codingProjects"),
    sessionId: v.id("codingSessions"),
    type: eventTypeV,
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("codingEvents", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listForSession = query({
  args: { sessionId: v.id("codingSessions"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingEvents")
      .withIndex("by_session_and_createdAt", (q) =>
        q.eq("sessionId", args.sessionId),
      )
      .order("asc")
      .take(args.limit ?? 200);
  },
});
