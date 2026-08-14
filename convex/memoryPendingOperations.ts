import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";

const MAX_PROVIDER_MEMORY_IDS = 500;
const MAX_PREVIEW_LENGTH = 8_000;

const typeV = v.union(v.literal("forget"), v.literal("update"));

type PendingOperation = Doc<"memoryPendingOperations">;

export type PendingOperationAccess =
  | { ok: true; operation: PendingOperation }
  | {
      ok: false;
      reason: "not_found" | "expired" | "cancelled" | "completed" | "invalid_status";
    };

function nowOr(value: number | undefined): number {
  return value ?? Date.now();
}

function requireText(value: string, label: string, maxLength = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters`);
  }
  return normalized;
}

function exactIds(ids: string[]): string[] {
  const result = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (result.length < 1 || result.length > MAX_PROVIDER_MEMORY_IDS) {
    throw new Error("providerMemoryIds must contain between 1 and 500 exact IDs");
  }
  return result;
}

function assertOwner(
  operation: PendingOperation | null,
  ownerKey: string,
  conversationId?: string,
): PendingOperation | null {
  if (!operation) return null;
  if (
    operation.ownerKey !== ownerKey ||
    (conversationId !== undefined && operation.conversationId !== conversationId)
  ) {
    // Deliberately indistinguishable from an unknown capability.
    throw new Error("Pending operation not found");
  }
  return operation;
}

/** Pure access projection shared by queries, mutations, and unit tests. */
export function inspectPendingOperation(
  operation: PendingOperation | null,
  input: { ownerKey: string; conversationId?: string; now: number },
): PendingOperationAccess {
  const owned = assertOwner(operation, input.ownerKey, input.conversationId);
  if (!owned) return { ok: false, reason: "not_found" };
  if (owned.status === "pending" && owned.expiresAt <= input.now) {
    return { ok: false, reason: "expired" };
  }
  if (owned.status === "cancelled") return { ok: false, reason: "cancelled" };
  if (owned.status === "expired") return { ok: false, reason: "expired" };
  if (owned.status === "completed") return { ok: false, reason: "completed" };
  return { ok: true, operation: owned };
}

async function byOperationId(
  ctx: QueryCtx | MutationCtx,
  operationId: string,
): Promise<PendingOperation | null> {
  return await ctx.db
    .query("memoryPendingOperations")
    .withIndex("by_operation_id", (q) => q.eq("operationId", operationId))
    .unique();
}

export const createPending = mutation({
  args: {
    operationId: v.string(),
    ownerKey: v.string(),
    conversationId: v.string(),
    type: typeV,
    providerMemoryIds: v.array(v.string()),
    preview: v.string(),
    expiresAt: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = nowOr(args.now);
    const operationId = requireText(args.operationId, "operationId");
    const ownerKey = requireText(args.ownerKey, "ownerKey");
    const conversationId = requireText(args.conversationId, "conversationId");
    const providerMemoryIds = exactIds(args.providerMemoryIds);
    const preview = requireText(args.preview, "preview", MAX_PREVIEW_LENGTH);
    if (!Number.isFinite(args.expiresAt) || args.expiresAt <= now) {
      throw new Error("expiresAt must be in the future");
    }

    const existing = await byOperationId(ctx, operationId);
    if (existing) {
      assertOwner(existing, ownerKey, conversationId);
      const same =
        existing.type === args.type &&
        existing.preview === preview &&
        existing.expiresAt === args.expiresAt &&
        existing.providerMemoryIds.length === providerMemoryIds.length &&
        existing.providerMemoryIds.every((id, index) => id === providerMemoryIds[index]);
      if (!same) throw new Error("operationId already exists with a different payload");
      return existing;
    }

    const id = await ctx.db.insert("memoryPendingOperations", {
      operationId,
      ownerKey,
      conversationId,
      type: args.type,
      providerMemoryIds,
      preview,
      status: "pending",
      createdAt: now,
      expiresAt: args.expiresAt,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("Failed to create pending operation");
    return created;
  },
});

export const loadByOperationId = query({
  args: {
    operationId: v.string(),
    ownerKey: v.string(),
    conversationId: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const operation = await byOperationId(ctx, args.operationId);
    return inspectPendingOperation(operation, {
      ownerKey: args.ownerKey,
      conversationId: args.conversationId,
      now: nowOr(args.now),
    });
  },
});

export const loadCurrentPendingByConversation = query({
  args: {
    ownerKey: v.string(),
    conversationId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = nowOr(args.now);
    const candidates = await ctx.db
      .query("memoryPendingOperations")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", args.conversationId).eq("status", "pending"),
      )
      .order("desc")
      .take(25);
    const operation = candidates.find(
      (candidate) => candidate.ownerKey === args.ownerKey && candidate.expiresAt > now,
    );
    return operation ?? null;
  },
});

export const confirm = mutation({
  args: {
    operationId: v.string(),
    ownerKey: v.string(),
    conversationId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PendingOperationAccess> => {
    const now = nowOr(args.now);
    const operation = assertOwner(
      await byOperationId(ctx, args.operationId),
      args.ownerKey,
      args.conversationId,
    );
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status === "pending" && operation.expiresAt <= now) {
      await ctx.db.patch(operation._id, { status: "expired" });
      return { ok: false, reason: "expired" };
    }
    if (operation.status === "confirmed") return { ok: true, operation };
    if (operation.status === "cancelled") return { ok: false, reason: "cancelled" };
    if (operation.status === "completed") return { ok: false, reason: "completed" };
    if (operation.status === "expired") return { ok: false, reason: "expired" };
    await ctx.db.patch(operation._id, { status: "confirmed" });
    return { ok: true, operation: { ...operation, status: "confirmed" } };
  },
});

export const complete = mutation({
  args: {
    operationId: v.string(),
    ownerKey: v.string(),
    conversationId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PendingOperationAccess> => {
    const operation = assertOwner(
      await byOperationId(ctx, args.operationId),
      args.ownerKey,
      args.conversationId,
    );
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status === "completed") return { ok: true, operation };
    if (operation.status !== "confirmed") {
      return {
        ok: false,
        reason:
          operation.status === "cancelled"
            ? "cancelled"
            : operation.status === "expired"
              ? "expired"
              : "invalid_status",
      };
    }
    const completedAt = nowOr(args.now);
    await ctx.db.patch(operation._id, { status: "completed", completedAt });
    return {
      ok: true,
      operation: { ...operation, status: "completed", completedAt },
    };
  },
});

export const cancel = mutation({
  args: {
    operationId: v.string(),
    ownerKey: v.string(),
    conversationId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PendingOperationAccess> => {
    const now = nowOr(args.now);
    const operation = assertOwner(
      await byOperationId(ctx, args.operationId),
      args.ownerKey,
      args.conversationId,
    );
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status === "pending" && operation.expiresAt <= now) {
      await ctx.db.patch(operation._id, { status: "expired" });
      return { ok: false, reason: "expired" };
    }
    if (operation.status === "cancelled") return { ok: true, operation };
    if (operation.status !== "pending") {
      return {
        ok: false,
        reason: operation.status === "completed" ? "completed" : "invalid_status",
      };
    }
    await ctx.db.patch(operation._id, { status: "cancelled" });
    return { ok: true, operation: { ...operation, status: "cancelled" } };
  },
});

export const expire = mutation({
  args: {
    operationId: v.string(),
    ownerKey: v.string(),
    conversationId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<PendingOperationAccess> => {
    const now = nowOr(args.now);
    const operation = assertOwner(
      await byOperationId(ctx, args.operationId),
      args.ownerKey,
      args.conversationId,
    );
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status === "expired") return { ok: true, operation };
    if (operation.status !== "pending" || operation.expiresAt > now) {
      return { ok: false, reason: "invalid_status" };
    }
    await ctx.db.patch(operation._id, { status: "expired" });
    return { ok: true, operation: { ...operation, status: "expired" } };
  },
});
