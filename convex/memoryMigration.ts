import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const statusV = v.union(
  v.literal("pending"),
  v.literal("migrated"),
  v.literal("failed"),
  v.literal("skipped"),
);

const MAX_ERROR_LENGTH = 2_000;
const VERIFICATION_COUNT_LIMIT = 10_000;

function requireHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("contentHash must be a 64-character lowercase SHA-256 digest");
  }
  return value;
}

function requireText(value: string, label: string, maxLength = 500): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters`);
  }
  return normalized;
}

async function findRow(
  ctx: Pick<MutationCtx, "db"> | Pick<QueryCtx, "db">,
  legacyMemoryId: string,
): Promise<Doc<"memoryMigrationRows"> | null> {
  return await ctx.db
    .query("memoryMigrationRows")
    .withIndex("by_legacy_memory_id", (q) => q.eq("legacyMemoryId", legacyMemoryId))
    .unique();
}

export const prepare = internalMutation({
  args: {
    legacyMemoryId: v.string(),
    ownerKey: v.string(),
    containerTag: v.string(),
    contentHash: v.string(),
  },
  handler: async (ctx, args) => {
    const legacyMemoryId = requireText(args.legacyMemoryId, "legacyMemoryId");
    const ownerKey = requireText(args.ownerKey, "ownerKey", 100);
    const containerTag = requireText(args.containerTag, "containerTag", 100);
    const contentHash = requireHash(args.contentHash);
    const existing = await findRow(ctx, legacyMemoryId);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        throw new Error(`content hash changed for legacy memory ${legacyMemoryId}`);
      }
      if (existing.ownerKey !== ownerKey || existing.containerTag !== containerTag) {
        throw new Error(`owner/container changed for legacy memory ${legacyMemoryId}`);
      }
      return {
        action:
          existing.status === "migrated" || existing.status === "skipped"
            ? ("skip" as const)
            : ("resume" as const),
        row: existing,
      };
    }

    const now = Date.now();
    const id = await ctx.db.insert("memoryMigrationRows", {
      legacyMemoryId,
      ownerKey,
      containerTag,
      status: "pending",
      contentHash,
      createdAt: now,
      updatedAt: now,
    });
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Failed to create memory migration row");
    return { action: "create" as const, row };
  },
});

export const getByLegacyMemoryId = internalQuery({
  args: { legacyMemoryId: v.string() },
  handler: async (ctx, args) => {
    return await findRow(ctx, requireText(args.legacyMemoryId, "legacyMemoryId"));
  },
});

export const markMigrated = internalMutation({
  args: {
    legacyMemoryId: v.string(),
    contentHash: v.string(),
    providerDocumentId: v.optional(v.string()),
    providerMemoryId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const legacyMemoryId = requireText(args.legacyMemoryId, "legacyMemoryId");
    const row = await findRow(ctx, legacyMemoryId);
    if (!row) throw new Error("Memory migration row not found");
    if (row.contentHash !== requireHash(args.contentHash)) {
      throw new Error(`content hash changed for legacy memory ${legacyMemoryId}`);
    }
    const providerDocumentId = args.providerDocumentId
      ? requireText(args.providerDocumentId, "providerDocumentId")
      : undefined;
    const providerMemoryId = args.providerMemoryId
      ? requireText(args.providerMemoryId, "providerMemoryId")
      : undefined;
    if (!providerDocumentId && !providerMemoryId) {
      throw new Error("A migrated row requires a provider document or memory ID");
    }
    await ctx.db.patch(row._id, {
      status: "migrated",
      providerDocumentId,
      providerMemoryId,
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return {
      ...row,
      status: "migrated" as const,
      providerDocumentId,
      providerMemoryId,
      lastError: undefined,
    };
  },
});

export const markFailed = internalMutation({
  args: {
    legacyMemoryId: v.string(),
    contentHash: v.string(),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const legacyMemoryId = requireText(args.legacyMemoryId, "legacyMemoryId");
    const row = await findRow(ctx, legacyMemoryId);
    if (!row) throw new Error("Memory migration row not found");
    if (row.contentHash !== requireHash(args.contentHash)) {
      throw new Error(`content hash changed for legacy memory ${legacyMemoryId}`);
    }
    const lastError = requireText(args.error, "error", MAX_ERROR_LENGTH);
    await ctx.db.patch(row._id, { status: "failed", lastError, updatedAt: Date.now() });
    return { ...row, status: "failed" as const, lastError };
  },
});

export const markSkipped = internalMutation({
  args: {
    legacyMemoryId: v.string(),
    contentHash: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const legacyMemoryId = requireText(args.legacyMemoryId, "legacyMemoryId");
    const row = await findRow(ctx, legacyMemoryId);
    if (!row) throw new Error("Memory migration row not found");
    if (row.contentHash !== requireHash(args.contentHash)) {
      throw new Error(`content hash changed for legacy memory ${legacyMemoryId}`);
    }
    const lastError = requireText(args.reason, "reason", MAX_ERROR_LENGTH);
    await ctx.db.patch(row._id, { status: "skipped", lastError, updatedAt: Date.now() });
    return { ...row, status: "skipped" as const, lastError };
  },
});

export const listByStatus = internalQuery({
  args: {
    status: statusV,
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pageSize = args.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 250) {
      throw new Error("pageSize must be an integer between 1 and 250");
    }
    return await ctx.db
      .query("memoryMigrationRows")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize });
  },
});

/**
 * Aggregate-only server/dashboard cutover verification. It intentionally
 * returns no memory text, legacy IDs, provider IDs, or owner identifiers.
 */
export const verifyOwnerCutover = query({
  args: {
    ownerKey: v.string(),
    containerTag: v.string(),
  },
  handler: async (ctx, args) => {
    const statuses = ["pending", "migrated", "failed", "skipped"] as const;
    const entries = await Promise.all(
      statuses.map(async (status) => {
        const rows = await ctx.db
          .query("memoryMigrationRows")
          .withIndex("by_owner_key_and_container_tag_and_status", (q) =>
            q
              .eq("ownerKey", args.ownerKey)
              .eq("containerTag", args.containerTag)
              .eq("status", status),
          )
          .take(VERIFICATION_COUNT_LIMIT + 1);
        return [status, rows] as const;
      }),
    );
    const counts = Object.fromEntries(
      entries.map(([status, rows]) => [
        status,
        Math.min(rows.length, VERIFICATION_COUNT_LIMIT),
      ]),
    ) as Record<(typeof statuses)[number], number>;
    const migratedRows = entries.find(([status]) => status === "migrated")![1];
    const migratedWithoutProviderId = migratedRows
      .slice(0, VERIFICATION_COUNT_LIMIT)
      .filter((row) => !row.providerDocumentId && !row.providerMemoryId).length;
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const truncated = entries.some(([, rows]) => rows.length > VERIFICATION_COUNT_LIMIT);
    return {
      total,
      ...counts,
      migratedWithoutProviderId,
      truncated,
      reconciled:
        total > 0 &&
        !truncated &&
        counts.pending === 0 &&
        counts.failed === 0 &&
        migratedWithoutProviderId === 0,
    };
  },
});
