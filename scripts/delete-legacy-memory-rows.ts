#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";

const execFileAsync = promisify(execFile);
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

export const LEGACY_CLEANUP_TABLES = [
  {
    name: "memoryRecords",
    countFunction: "legacyMemoryCleanup:countMemoryRecordsPage",
    deleteFunction: "legacyMemoryCleanup:deleteMemoryRecordsBatch",
    expectedField: "expectedMemoryRecords",
    deletedField: "deletedMemoryRecords",
  },
  {
    name: "memoryEvents",
    countFunction: "legacyMemoryCleanup:countMemoryEventsPage",
    deleteFunction: "legacyMemoryCleanup:deleteMemoryEventsBatch",
    expectedField: "expectedMemoryEvents",
    deletedField: "deletedMemoryEvents",
  },
  {
    name: "consolidationRuns",
    countFunction: "legacyMemoryCleanup:countConsolidationRunsPage",
    deleteFunction: "legacyMemoryCleanup:deleteConsolidationRunsBatch",
    expectedField: "expectedConsolidationRuns",
    deletedField: "deletedConsolidationRuns",
  },
] as const;

type CleanupTableName = (typeof LEGACY_CLEANUP_TABLES)[number]["name"];
export type LegacyCleanupCounts = Record<CleanupTableName, number>;

export interface CleanupRun {
  runId: string;
  expectedMemoryRecords: number;
  expectedMemoryEvents: number;
  expectedConsolidationRuns: number;
  deletedMemoryRecords: number;
  deletedMemoryEvents: number;
  deletedConsolidationRuns: number;
  status: "running" | "zero_verified";
  createdAt: number;
  updatedAt: number;
}

export interface ConvexCleanupAdmin {
  run<T>(functionName: string, args: Record<string, unknown>): Promise<T>;
}

export type CleanupLogger = (event: Record<string, unknown>) => void;

interface CountPage {
  count: number;
  isDone: boolean;
  continueCursor: string | null;
}

interface DeleteBatchResult {
  runId: string;
  table: CleanupTableName;
  deleted: number;
  deletedTotal: number;
  expected: number;
  status: "running";
}

interface CliOptions {
  mode: "dry-run" | "execute" | "remove-verified-run";
  runId?: string;
  batchSize: number;
  expected?: LegacyCleanupCounts;
  help: boolean;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function positiveBatchSize(value: string): number {
  const parsed = nonNegativeInteger(value, "--batch-size");
  if (parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return parsed;
}

function flagValue(argv: string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${argv[index]} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  let execute = false;
  let removeVerifiedRun = false;
  let runId: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;
  let expectedMemoryRecords: number | undefined;
  let expectedMemoryEvents: number | undefined;
  let expectedConsolidationRuns: number | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") execute = true;
    else if (arg === "--remove-verified-run") removeVerifiedRun = true;
    else if (arg === "--run-id") {
      runId = flagValue(argv, index);
      index += 1;
    } else if (arg === "--batch-size") {
      batchSize = positiveBatchSize(flagValue(argv, index));
      index += 1;
    } else if (arg === "--expect-memory-records") {
      expectedMemoryRecords = nonNegativeInteger(flagValue(argv, index), arg);
      index += 1;
    } else if (arg === "--expect-memory-events") {
      expectedMemoryEvents = nonNegativeInteger(flagValue(argv, index), arg);
      index += 1;
    } else if (arg === "--expect-consolidation-runs") {
      expectedConsolidationRuns = nonNegativeInteger(flagValue(argv, index), arg);
      index += 1;
    } else if (arg === "--help") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (execute && removeVerifiedRun) {
    throw new Error("--execute and --remove-verified-run are mutually exclusive");
  }
  if (help) return { mode: "dry-run", runId, batchSize, help };
  if (removeVerifiedRun) {
    if (!runId) throw new Error("--remove-verified-run requires --run-id");
    return { mode: "remove-verified-run", runId, batchSize, help };
  }
  if (!execute) return { mode: "dry-run", runId, batchSize, help };
  if (!runId) throw new Error("--execute requires --run-id");
  const suppliedExpectedCount = [
    expectedMemoryRecords,
    expectedMemoryEvents,
    expectedConsolidationRuns,
  ].filter((value) => value !== undefined).length;
  if (suppliedExpectedCount > 0 && suppliedExpectedCount < 3) {
    throw new Error(
      "expected counts must include --expect-memory-records, --expect-memory-events, and --expect-consolidation-runs together",
    );
  }
  return {
    mode: "execute",
    runId,
    batchSize,
    expected:
      suppliedExpectedCount === 3
        ? {
            memoryRecords: expectedMemoryRecords!,
            memoryEvents: expectedMemoryEvents!,
            consolidationRuns: expectedConsolidationRuns!,
          }
        : undefined,
    help,
  };
}

export function requireDevelopmentDeployment(
  env: Record<string, string | undefined>,
): "development" {
  const conflictingVariables = [
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
    "CONVEX_SELF_HOSTED_URL",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
  ].filter((name) => env[name]?.trim());
  if (conflictingVariables.length > 0) {
    throw new Error(
      `Refusing cleanup while alternate Convex target configuration is present: ${conflictingVariables.join(", ")}`,
    );
  }
  const deployment = env.CONVEX_DEPLOYMENT?.trim();
  if (!deployment || !/^dev:[A-Za-z0-9][A-Za-z0-9-]*$/.test(deployment)) {
    throw new Error("Legacy memory cleanup requires an explicit development Convex deployment");
  }
  return "development";
}

export function createConvexCleanupAdmin(): ConvexCleanupAdmin {
  return {
    async run<T>(functionName: string, args: Record<string, unknown>): Promise<T> {
      try {
        const { stdout } = await execFileAsync(
          "npx",
          [
            "convex",
            "run",
            functionName,
            JSON.stringify(args),
            "--typecheck",
            "disable",
            "--codegen",
            "disable",
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        const serialized = stdout.trim();
        return (serialized ? JSON.parse(serialized) : null) as T;
      } catch (error) {
        const details = error as { stderr?: string; message?: string };
        throw new Error(
          `Convex cleanup function ${functionName} failed: ${details.stderr?.trim() || details.message || String(error)}`,
          { cause: error },
        );
      }
    },
  };
}

async function countTable(
  admin: ConvexCleanupAdmin,
  functionName: string,
  pageSize: number,
): Promise<number> {
  let cursor: string | null = null;
  let total = 0;
  for (;;) {
    const page: CountPage = await admin.run<CountPage>(functionName, {
      cursor,
      pageSize,
    });
    if (
      !Number.isSafeInteger(page.count) ||
      page.count < 0 ||
      page.count > pageSize ||
      typeof page.isDone !== "boolean"
    ) {
      throw new Error(`Invalid bounded count response from ${functionName}`);
    }
    total += page.count;
    if (!Number.isSafeInteger(total)) throw new Error(`Count overflow from ${functionName}`);
    if (page.isDone) return total;
    if (!page.continueCursor || page.continueCursor === cursor) {
      throw new Error(`Count cursor did not advance for ${functionName}`);
    }
    cursor = page.continueCursor;
  }
}

export async function inspectLegacyCounts(
  admin: ConvexCleanupAdmin,
  pageSize = DEFAULT_BATCH_SIZE,
): Promise<LegacyCleanupCounts> {
  const counts = {} as LegacyCleanupCounts;
  for (const table of LEGACY_CLEANUP_TABLES) {
    counts[table.name] = await countTable(admin, table.countFunction, pageSize);
  }
  return counts;
}

export function assertCleanupInvariants(
  run: CleanupRun,
  remaining: LegacyCleanupCounts,
): void {
  for (const table of LEGACY_CLEANUP_TABLES) {
    const expected = run[table.expectedField];
    const deleted = run[table.deletedField];
    if (
      !Number.isSafeInteger(expected) ||
      !Number.isSafeInteger(deleted) ||
      deleted < 0 ||
      remaining[table.name] < 0 ||
      deleted + remaining[table.name] !== expected
    ) {
      throw new Error(
        `Cleanup invariant failed for ${table.name}: remaining + deleted must equal expected`,
      );
    }
  }
}

async function getRequiredRun(
  admin: ConvexCleanupAdmin,
  runId: string,
): Promise<CleanupRun> {
  const run = await admin.run<CleanupRun | null>("legacyMemoryCleanup:getRun", { runId });
  if (!run) throw new Error(`Cleanup checkpoint ${runId} was not found`);
  return run;
}

export async function executeLegacyCleanup(input: {
  admin: ConvexCleanupAdmin;
  runId: string;
  expected?: LegacyCleanupCounts;
  batchSize?: number;
  log?: CleanupLogger;
}): Promise<{ run: CleanupRun; remaining: LegacyCleanupCounts }> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = input.log ?? (() => undefined);
  const existing = await input.admin.run<CleanupRun | null>("legacyMemoryCleanup:getRun", {
    runId: input.runId,
  });
  let remaining = await inspectLegacyCounts(input.admin, batchSize);
  let expected: LegacyCleanupCounts;
  if (existing) {
    expected = {
      memoryRecords: existing.expectedMemoryRecords,
      memoryEvents: existing.expectedMemoryEvents,
      consolidationRuns: existing.expectedConsolidationRuns,
    };
    if (
      input.expected &&
      LEGACY_CLEANUP_TABLES.some(
        (table) => input.expected![table.name] !== expected[table.name],
      )
    ) {
      throw new Error(`cleanup run ${input.runId} expected counts do not match checkpoint`);
    }
    assertCleanupInvariants(existing, remaining);
  } else {
    if (!input.expected) {
      throw new Error(
        "A new cleanup run requires all three confirmed expected counts",
      );
    }
    expected = input.expected;
    for (const table of LEGACY_CLEANUP_TABLES) {
      if (remaining[table.name] !== expected[table.name]) {
        throw new Error(
          `Confirmed expected count does not match current ${table.name} count`,
        );
      }
    }
  }
  const checkpoint = await input.admin.run<{ action: "created" | "resumed"; run: CleanupRun }>(
    "legacyMemoryCleanup:startOrResumeRun",
    {
      runId: input.runId,
      expectedMemoryRecords: expected.memoryRecords,
      expectedMemoryEvents: expected.memoryEvents,
      expectedConsolidationRuns: expected.consolidationRuns,
    },
  );
  let run = checkpoint.run;
  assertCleanupInvariants(run, remaining);
  log({ event: "checkpoint", action: checkpoint.action, runId: input.runId, remaining });

  if (run.status === "running") {
    for (const table of LEGACY_CLEANUP_TABLES) {
      while (remaining[table.name] > 0) {
        const batch = await input.admin.run<DeleteBatchResult>(table.deleteFunction, {
          runId: input.runId,
          batchSize,
        });
        if (batch.table !== table.name || batch.deleted < 1 || batch.deleted > batchSize) {
          throw new Error(`Invalid deletion response for ${table.name}`);
        }
        remaining = await inspectLegacyCounts(input.admin, batchSize);
        run = await getRequiredRun(input.admin, input.runId);
        assertCleanupInvariants(run, remaining);
        log({
          event: "batch_deleted",
          runId: input.runId,
          table: table.name,
          deleted: batch.deleted,
          deletedTotal: batch.deletedTotal,
          remaining: remaining[table.name],
        });
      }
    }
  }

  remaining = await inspectLegacyCounts(input.admin, batchSize);
  run = await getRequiredRun(input.admin, input.runId);
  assertCleanupInvariants(run, remaining);
  if (Object.values(remaining).some((value) => value !== 0)) {
    throw new Error("Legacy memory cleanup cannot be zero_verified while rows remain");
  }
  run = await input.admin.run<CleanupRun>("legacyMemoryCleanup:markZeroVerified", {
    runId: input.runId,
  });
  if (run.status !== "zero_verified") {
    throw new Error("Legacy memory cleanup checkpoint was not marked zero_verified");
  }
  log({ event: "zero_verified", runId: input.runId, remaining });
  return { run, remaining };
}

export async function removeVerifiedCleanupRun(
  admin: ConvexCleanupAdmin,
  runId: string,
): Promise<{ runId: string; removed: boolean }> {
  const remaining = await inspectLegacyCounts(admin, DEFAULT_BATCH_SIZE);
  if (Object.values(remaining).some((value) => value !== 0)) {
    throw new Error("Refusing to remove cleanup checkpoint while legacy rows remain");
  }
  return await admin.run("legacyMemoryCleanup:removeVerifiedRun", { runId });
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx scripts/delete-legacy-memory-rows.ts [--batch-size 1..100]
  npx tsx scripts/delete-legacy-memory-rows.ts --execute --run-id ID \\
    --expect-memory-records N --expect-memory-events N --expect-consolidation-runs N \\
    [--batch-size 1..100]
  npx tsx scripts/delete-legacy-memory-rows.ts --remove-verified-run --run-id ID`);
}

async function main(): Promise<void> {
  loadEnv({ path: ".env.local" });
  loadEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  const deploymentType = requireDevelopmentDeployment(process.env);
  const admin = createConvexCleanupAdmin();
  const log: CleanupLogger = (event) => console.log(JSON.stringify(event));
  log({ event: "deployment_verified", deploymentType });

  if (options.mode === "dry-run") {
    const counts = await inspectLegacyCounts(admin, options.batchSize);
    log({ event: "dry_run", counts });
    return;
  }
  if (options.mode === "remove-verified-run") {
    const result = await removeVerifiedCleanupRun(admin, options.runId!);
    log({ event: "verified_checkpoint_removed", ...result });
    return;
  }
  await executeLegacyCleanup({
    admin,
    runId: options.runId!,
    expected: options.expected,
    batchSize: options.batchSize,
    log,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
