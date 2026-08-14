import { describe, expect, it, vi } from "vitest";
import {
  assertCleanupInvariants,
  executeLegacyCleanup,
  inspectLegacyCounts,
  LEGACY_CLEANUP_TABLES,
  parseArgs,
  requireDevelopmentDeployment,
  type CleanupRun,
  type ConvexCleanupAdmin,
  type LegacyCleanupCounts,
} from "../scripts/delete-legacy-memory-rows.js";

function onePageAdmin(counts: LegacyCleanupCounts) {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const admin: ConvexCleanupAdmin = {
    async run<T>(functionName, args) {
      calls.push({ functionName, args });
      const table = LEGACY_CLEANUP_TABLES.find(
        (candidate) => candidate.countFunction === functionName,
      );
      if (!table) throw new Error(`unexpected function ${functionName}`);
      const offset = args.cursor ? Number(args.cursor) : 0;
      const pageSize = Number(args.pageSize);
      const count = Math.min(pageSize, Math.max(0, counts[table.name] - offset));
      const nextOffset = offset + count;
      return {
        count,
        isDone: nextOffset >= counts[table.name],
        continueCursor: nextOffset >= counts[table.name] ? null : String(nextOffset),
      } as T;
    },
  };
  return { admin, calls };
}

function resumableAdmin(input: {
  counts: LegacyCleanupCounts;
  run: CleanupRun;
  markStatus?: "running" | "zero_verified";
}) {
  const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const counts = { ...input.counts };
  const run = { ...input.run };
  const admin: ConvexCleanupAdmin = {
    async run<T>(functionName, args) {
      calls.push({ functionName, args });
      const countTable = LEGACY_CLEANUP_TABLES.find(
        (candidate) => candidate.countFunction === functionName,
      );
      if (countTable) {
        const offset = args.cursor ? Number(args.cursor) : 0;
        const pageSize = Number(args.pageSize);
        const count = Math.min(
          pageSize,
          Math.max(0, counts[countTable.name] - offset),
        );
        const nextOffset = offset + count;
        return {
          count,
          isDone: nextOffset >= counts[countTable.name],
          continueCursor:
            nextOffset >= counts[countTable.name] ? null : String(nextOffset),
        } as T;
      }
      if (functionName === "legacyMemoryCleanup:startOrResumeRun") {
        return { action: "resumed", run: { ...run } } as T;
      }
      if (functionName === "legacyMemoryCleanup:getRun") return { ...run } as T;
      if (functionName === "legacyMemoryCleanup:markZeroVerified") {
        run.status = input.markStatus ?? "zero_verified";
        return { ...run } as T;
      }
      const deleteTable = LEGACY_CLEANUP_TABLES.find(
        (candidate) => candidate.deleteFunction === functionName,
      );
      if (deleteTable) {
        const size = Number(args.batchSize);
        const deleted = Math.min(size, counts[deleteTable.name]);
        counts[deleteTable.name] -= deleted;
        run[deleteTable.deletedField] += deleted;
        return {
          runId: run.runId,
          table: deleteTable.name,
          deleted,
          deletedTotal: run[deleteTable.deletedField],
          expected: run[deleteTable.expectedField],
          status: "running",
        } as T;
      }
      throw new Error(`unexpected function ${functionName}`);
    },
  };
  return { admin, calls, counts, run };
}

describe("legacy memory cleanup CLI", () => {
  it("selects only the three explicitly permitted tables", () => {
    expect(LEGACY_CLEANUP_TABLES.map((table) => table.name)).toEqual([
      "memoryRecords",
      "memoryEvents",
      "consolidationRuns",
    ]);
    expect(JSON.stringify(LEGACY_CLEANUP_TABLES)).not.toContain("messages");
    expect(JSON.stringify(LEGACY_CLEANUP_TABLES)).not.toContain("memoryMigrationRows");
  });

  it("dry-run counting makes no mutation calls and returns aggregate counts", async () => {
    const { admin, calls } = onePageAdmin({
      memoryRecords: 12,
      memoryEvents: 44,
      consolidationRuns: 1,
    });
    await expect(inspectLegacyCounts(admin, 25)).resolves.toEqual({
      memoryRecords: 12,
      memoryEvents: 44,
      consolidationRuns: 1,
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((call) => call.functionName.includes("count"))).toBe(true);
  });

  it("rejects every deployment configuration except an explicit cloud dev target", () => {
    expect(requireDevelopmentDeployment({ CONVEX_DEPLOYMENT: "dev:safe-target-123" })).toBe(
      "development",
    );
    for (const deployment of [
      undefined,
      "",
      "prod:unsafe-target-123",
      "preview:branch-123",
      "local:local-project",
      "unsafe-target-123",
    ]) {
      expect(() => requireDevelopmentDeployment({ CONVEX_DEPLOYMENT: deployment })).toThrow(
        "requires an explicit development",
      );
    }
    expect(() =>
      requireDevelopmentDeployment({
        CONVEX_DEPLOYMENT: "dev:safe-target-123",
        CONVEX_DEPLOY_KEY: "configured",
      }),
    ).toThrow("alternate Convex target configuration");
  });

  it("defaults to dry-run and requires a run ID plus all expected counts for execution", () => {
    expect(parseArgs([])).toMatchObject({ mode: "dry-run", batchSize: 25 });
    expect(parseArgs(["--execute", "--run-id", "cleanup-1"])).toMatchObject({
      mode: "execute",
      runId: "cleanup-1",
      expected: undefined,
    });
    expect(() =>
      parseArgs([
        "--execute",
        "--run-id",
        "cleanup-1",
        "--expect-memory-records",
        "12",
      ]),
    ).toThrow("expected counts must include");
    expect(
      parseArgs([
        "--execute",
        "--run-id",
        "cleanup-1",
        "--expect-memory-records",
        "12",
        "--expect-memory-events",
        "44",
        "--expect-consolidation-runs",
        "1",
      ]),
    ).toMatchObject({
      mode: "execute",
      runId: "cleanup-1",
      expected: { memoryRecords: 12, memoryEvents: 44, consolidationRuns: 1 },
    });
  });

  it("resumes the same checkpoint ID in bounded batches and verifies every invariant", async () => {
    const state = resumableAdmin({
      counts: { memoryRecords: 3, memoryEvents: 2, consolidationRuns: 1 },
      run: {
        runId: "cleanup-resume",
        expectedMemoryRecords: 5,
        expectedMemoryEvents: 2,
        expectedConsolidationRuns: 1,
        deletedMemoryRecords: 2,
        deletedMemoryEvents: 0,
        deletedConsolidationRuns: 0,
        status: "running",
        createdAt: 1,
        updatedAt: 2,
      },
    });
    const log = vi.fn();

    const result = await executeLegacyCleanup({
      admin: state.admin,
      runId: "cleanup-resume",
      batchSize: 2,
      log,
    });

    expect(result.remaining).toEqual({
      memoryRecords: 0,
      memoryEvents: 0,
      consolidationRuns: 0,
    });
    expect(result.run.status).toBe("zero_verified");
    const deletionCalls = state.calls.filter((call) => call.functionName.includes("delete"));
    expect(deletionCalls).toHaveLength(4);
    expect(deletionCalls.every((call) => call.args.batchSize === 2)).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "zero_verified", runId: "cleanup-resume" }),
    );
  });

  it("stops before the first resumed batch when remaining plus deleted drifts", async () => {
    const state = resumableAdmin({
      counts: { memoryRecords: 2, memoryEvents: 0, consolidationRuns: 0 },
      run: {
        runId: "cleanup-drift",
        expectedMemoryRecords: 4,
        expectedMemoryEvents: 0,
        expectedConsolidationRuns: 0,
        deletedMemoryRecords: 1,
        deletedMemoryEvents: 0,
        deletedConsolidationRuns: 0,
        status: "running",
        createdAt: 1,
        updatedAt: 2,
      },
    });
    await expect(
      executeLegacyCleanup({
        admin: state.admin,
        runId: "cleanup-drift",
        expected: { memoryRecords: 4, memoryEvents: 0, consolidationRuns: 0 },
        batchSize: 2,
      }),
    ).rejects.toThrow("Cleanup invariant failed for memoryRecords");
    expect(state.calls.some((call) => call.functionName.includes("delete"))).toBe(false);
  });

  it("requires the checkpoint mutation to return zero_verified", async () => {
    const state = resumableAdmin({
      counts: { memoryRecords: 0, memoryEvents: 0, consolidationRuns: 0 },
      run: {
        runId: "cleanup-verification-required",
        expectedMemoryRecords: 0,
        expectedMemoryEvents: 0,
        expectedConsolidationRuns: 0,
        deletedMemoryRecords: 0,
        deletedMemoryEvents: 0,
        deletedConsolidationRuns: 0,
        status: "running",
        createdAt: 1,
        updatedAt: 2,
      },
      markStatus: "running",
    });
    await expect(
      executeLegacyCleanup({
        admin: state.admin,
        runId: "cleanup-verification-required",
        expected: { memoryRecords: 0, memoryEvents: 0, consolidationRuns: 0 },
      }),
    ).rejects.toThrow("was not marked zero_verified");
  });

  it("checks remaining plus deleted equals expected for all three tables", () => {
    const run: CleanupRun = {
      runId: "cleanup-invariants",
      expectedMemoryRecords: 12,
      expectedMemoryEvents: 44,
      expectedConsolidationRuns: 1,
      deletedMemoryRecords: 2,
      deletedMemoryEvents: 4,
      deletedConsolidationRuns: 1,
      status: "running",
      createdAt: 1,
      updatedAt: 2,
    };
    expect(() =>
      assertCleanupInvariants(run, {
        memoryRecords: 10,
        memoryEvents: 40,
        consolidationRuns: 0,
      }),
    ).not.toThrow();
  });
});
