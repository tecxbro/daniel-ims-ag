import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const projectStatusV = v.union(
  v.literal("planning"),
  v.literal("building"),
  v.literal("waiting_for_user"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const createProject = mutation({
  args: {
    projectKey: v.string(),
    conversationId: v.string(),
    userId: v.optional(v.string()),
    title: v.string(),
    repoUrl: v.optional(v.string()),
    branch: v.optional(v.string()),
    workspacePath: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("codingProjects", {
      ...args,
      status: "planning",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateProjectStatus = mutation({
  args: {
    projectId: v.id("codingProjects"),
    status: v.optional(projectStatusV),
    title: v.optional(v.string()),
    repoUrl: v.optional(v.string()),
    branch: v.optional(v.string()),
    workspacePath: v.optional(v.string()),
    lastCodexThreadId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { projectId, ...patch } = args;
    await ctx.db.patch(projectId, {
      ...patch,
      updatedAt: Date.now(),
    });
    return projectId;
  },
});

export const get = query({
  args: { projectId: v.id("codingProjects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.projectId);
  },
});

export const getByProjectKey = query({
  args: { projectKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codingProjects")
      .withIndex("by_projectKey", (q) => q.eq("projectKey", args.projectKey))
      .unique();
  },
});

export const getActiveProjectForConversation = query({
  args: {
    conversationId: v.string(),
    repoUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("codingProjects")
      .withIndex("by_conversation_and_updatedAt", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(20);
    return (
      rows.find((row) => {
        if (["failed", "cancelled"].includes(row.status)) return false;
        if (args.repoUrl && row.repoUrl && row.repoUrl !== args.repoUrl) return false;
        if (args.repoUrl && !row.repoUrl) return false;
        return true;
      }) ?? null
    );
  },
});
