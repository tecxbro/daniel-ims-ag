import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_RUN_ID_LENGTH = 128;

const countPageArgs = {
  cursor: v.optional(v.union(v.string(), v.null())),
  pageSize: v.optional(v.number()),
};

function pageSize(value: number | undefined): number {
  const normalized = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_PAGE_SIZE) {
    throw new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return normalized;
}

function runId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_RUN_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    throw new Error(
      `runId must be 1-${MAX_RUN_ID_LENGTH} characters using letters, numbers, dot, underscore, colon, or hyphen`,
    );
  }
  return normalized;
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

async function findRun(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  cleanupRunId: string,
): Promise<Doc<"legacyMemoryCleanupRuns"> | null> {
  const rows = await ctx.db
    .query("legacyMemoryCleanupRuns")
    .withIndex("by_run_id", (q) => q.eq("runId", cleanupRunId))
    .take(1);
  return rows[0] ?? null;
}

function publicRun(run: Doc<"legacyMemoryCleanupRuns">) {
  return {
    runId: run.runId,
    expectedMemoryRecords: run.expectedMemoryRecords,
    expectedMemoryEvents: run.expectedMemoryEvents,
    expectedConsolidationRuns: run.expectedConsolidationRuns,
    deletedMemoryRecords: run.deletedMemoryRecords,
    deletedMemoryEvents: run.deletedMemoryEvents,
    deletedConsolidationRuns: run.deletedConsolidationRuns,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export const countMemoryRecordsPage = internalQuery({
  args: countPageArgs,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("memoryRecords").order("asc").paginate({
      cursor: args.cursor ?? null,
      numItems: pageSize(args.pageSize),
    });
    return {
      count: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const countMemoryEventsPage = internalQuery({
  args: countPageArgs,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("memoryEvents").order("asc").paginate({
      cursor: args.cursor ?? null,
      numItems: pageSize(args.pageSize),
    });
    return {
      count: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const countConsolidationRunsPage = internalQuery({
  args: countPageArgs,
  handler: async (ctx, args) => {
    const result = await ctx.db.query("consolidationRuns").order("asc").paginate({
      cursor: args.cursor ?? null,
      numItems: pageSize(args.pageSize),
    });
    return {
      count: result.page.length,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const startOrResumeRun = internalMutation({
  args: {
    runId: v.string(),
    expectedMemoryRecords: v.number(),
    expectedMemoryEvents: v.number(),
    expectedConsolidationRuns: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cleanupRunId = runId(args.runId);
    const expectedMemoryRecords = count(
      args.expectedMemoryRecords,
      "expectedMemoryRecords",
    );
    const expectedMemoryEvents = count(args.expectedMemoryEvents, "expectedMemoryEvents");
    const expectedConsolidationRuns = count(
      args.expectedConsolidationRuns,
      "expectedConsolidationRuns",
    );
    const existing = await findRun(ctx, cleanupRunId);
    if (existing) {
      if (
        existing.expectedMemoryRecords !== expectedMemoryRecords ||
        existing.expectedMemoryEvents !== expectedMemoryEvents ||
        existing.expectedConsolidationRuns !== expectedConsolidationRuns
      ) {
        throw new Error(`cleanup run ${cleanupRunId} expected counts do not match checkpoint`);
      }
      return { action: "resumed" as const, run: publicRun(existing) };
    }

    const now = args.now ?? Date.now();
    const id = await ctx.db.insert("legacyMemoryCleanupRuns", {
      runId: cleanupRunId,
      expectedMemoryRecords,
      expectedMemoryEvents,
      expectedConsolidationRuns,
      deletedMemoryRecords: 0,
      deletedMemoryEvents: 0,
      deletedConsolidationRuns: 0,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(id);
    if (!created) throw new Error("failed to create legacy memory cleanup checkpoint");
    return { action: "created" as const, run: publicRun(created) };
  },
});

export const getRun = internalQuery({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await findRun(ctx, runId(args.runId));
    return run ? publicRun(run) : null;
  },
});

type CleanupTable = "memoryRecords" | "memoryEvents" | "consolidationRuns";
type DeletedField =
  | "deletedMemoryRecords"
  | "deletedMemoryEvents"
  | "deletedConsolidationRuns";
type ExpectedField =
  | "expectedMemoryRecords"
  | "expectedMemoryEvents"
  | "expectedConsolidationRuns";

async function deleteBatch<T extends CleanupTable>(
  ctx: MutationCtx,
  args: { runId: string; batchSize?: number; now?: number },
  table: T,
  deletedField: DeletedField,
  expectedField: ExpectedField,
): Promise<{
  runId: string;
  table: T;
  deleted: number;
  deletedTotal: number;
  expected: number;
  status: "running";
}> {
  const cleanupRunId = runId(args.runId);
  const run = await findRun(ctx, cleanupRunId);
  if (!run) throw new Error(`cleanup run ${cleanupRunId} was not found`);
  if (run.status !== "running") {
    throw new Error(`cleanup run ${cleanupRunId} is already zero_verified`);
  }

  const size = pageSize(args.batchSize);
  const rows = await ctx.db.query(table).order("asc").take(size);
  const deletedTotal = run[deletedField] + rows.length;
  const expected = run[expectedField];
  if (deletedTotal > expected) {
    throw new Error(
      `cleanup run ${cleanupRunId} would exceed expected ${table} count (${deletedTotal} > ${expected})`,
    );
  }
  for (const row of rows) {
    await ctx.db.delete(row._id as Id<T>);
  }
  await ctx.db.patch(run._id, {
    [deletedField]: deletedTotal,
    updatedAt: args.now ?? Date.now(),
  });
  return {
    runId: cleanupRunId,
    table,
    deleted: rows.length,
    deletedTotal,
    expected,
    status: "running",
  };
}

const deleteBatchArgs = {
  runId: v.string(),
  batchSize: v.optional(v.number()),
  now: v.optional(v.number()),
};

export const deleteMemoryRecordsBatch = internalMutation({
  args: deleteBatchArgs,
  handler: async (ctx, args) =>
    await deleteBatch(
      ctx,
      args,
      "memoryRecords",
      "deletedMemoryRecords",
      "expectedMemoryRecords",
    ),
});

export const deleteMemoryEventsBatch = internalMutation({
  args: deleteBatchArgs,
  handler: async (ctx, args) =>
    await deleteBatch(
      ctx,
      args,
      "memoryEvents",
      "deletedMemoryEvents",
      "expectedMemoryEvents",
    ),
});

export const deleteConsolidationRunsBatch = internalMutation({
  args: deleteBatchArgs,
  handler: async (ctx, args) =>
    await deleteBatch(
      ctx,
      args,
      "consolidationRuns",
      "deletedConsolidationRuns",
      "expectedConsolidationRuns",
    ),
});

async function requireLegacyTablesEmpty(ctx: Pick<MutationCtx, "db">): Promise<void> {
  const [memoryRecords, memoryEvents, consolidationRuns] = await Promise.all([
    ctx.db.query("memoryRecords").take(1),
    ctx.db.query("memoryEvents").take(1),
    ctx.db.query("consolidationRuns").take(1),
  ]);
  if (memoryRecords.length || memoryEvents.length || consolidationRuns.length) {
    throw new Error("legacy memory cleanup cannot be zero_verified while rows remain");
  }
}

function requireDeletedCountsMatchExpected(run: Doc<"legacyMemoryCleanupRuns">): void {
  if (
    run.deletedMemoryRecords !== run.expectedMemoryRecords ||
    run.deletedMemoryEvents !== run.expectedMemoryEvents ||
    run.deletedConsolidationRuns !== run.expectedConsolidationRuns
  ) {
    throw new Error("legacy memory cleanup deleted counts do not match expected counts");
  }
}

export const markZeroVerified = internalMutation({
  args: { runId: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cleanupRunId = runId(args.runId);
    const run = await findRun(ctx, cleanupRunId);
    if (!run) throw new Error(`cleanup run ${cleanupRunId} was not found`);
    requireDeletedCountsMatchExpected(run);
    await requireLegacyTablesEmpty(ctx);
    if (run.status !== "zero_verified") {
      await ctx.db.patch(run._id, {
        status: "zero_verified",
        updatedAt: args.now ?? Date.now(),
      });
    }
    return {
      ...publicRun(run),
      status: "zero_verified" as const,
      updatedAt: run.status === "zero_verified" ? run.updatedAt : (args.now ?? Date.now()),
    };
  },
});

export const removeVerifiedRun = internalMutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const cleanupRunId = runId(args.runId);
    const run = await findRun(ctx, cleanupRunId);
    if (!run) return { runId: cleanupRunId, removed: false };
    if (run.status !== "zero_verified") {
      throw new Error(`cleanup run ${cleanupRunId} is not zero_verified`);
    }
    requireDeletedCountsMatchExpected(run);
    await requireLegacyTablesEmpty(ctx);
    await ctx.db.delete(run._id);
    return { runId: cleanupRunId, removed: true };
  },
});
