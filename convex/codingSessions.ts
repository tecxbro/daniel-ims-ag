import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const sessionModeV = v.union(
  v.literal("plan"),
  v.literal("build"),
  v.literal("debug"),
  v.literal("followup"),
);

const sessionStatusV = v.union(
  v.literal("running"),
  v.literal("waiting_for_user"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const createSession = mutation({
  args: {
    projectId: v.id("codingProjects"),
    conversationId: v.string(),
    mode: sessionModeV,
    workspacePath: v.string(),
    codexThreadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("codingSessions", {
      ...args,
      status: "running",
      startedAt: Date.now(),
    });
  },
});

export const updateSessionStatus = mutation({
  args: {
    sessionId: v.id("codingSessions"),
    status: v.optional(sessionStatusV),
    codexThreadId: v.optional(v.string()),
    finalSummary: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { sessionId, ...patch } = args;
    const status = patch.status;
    await ctx.db.patch(sessionId, {
      ...patch,
      ...(status && ["completed", "failed", "cancelled"].includes(status)
        ? { completedAt: Date.now() }
        : {}),
    });
    return sessionId;
  },
});

export const get = query({
  args: { sessionId: v.id("codingSessions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

export const getSessionByCodexThreadId = query({
  args: { codexThreadId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingSessions")
      .withIndex("by_codexThreadId", (q) =>
        q.eq("codexThreadId", args.codexThreadId),
      )
      .first();
  },
});

export const getLatestForProject = query({
  args: { projectId: v.id("codingProjects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingSessions")
      .withIndex("by_project_and_startedAt", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("desc")
      .first();
  },
});
