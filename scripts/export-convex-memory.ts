#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { access, mkdir, open, rename } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  deploymentIdentifier,
  paginateConvexMigration,
  type ConvexMigrationTarget,
} from "./convex-migration-cli.js";
import type {
  ExportFileManifest,
  MemoryExportFileName,
  MemoryExportManifest,
} from "./memory-migration-lib.js";

loadEnv({ path: ".env.local" });
loadEnv();

const DATASETS: ReadonlyArray<{
  filename: MemoryExportFileName;
  functionName: string;
}> = [
  { filename: "memory-records.jsonl", functionName: "memoryRecords:exportMemoryRecordsPage" },
  { filename: "memory-events.jsonl", functionName: "memoryRecords:exportMemoryEventsPage" },
  {
    filename: "consolidation-runs.jsonl",
    functionName: "memoryRecords:exportConsolidationRunsPage",
  },
];

export interface WriteMemoryExportInput {
  outputRoot: string;
  exportDate: string;
  exportTimestamp: string;
  deploymentIdentifier: string;
  rows: Record<MemoryExportFileName, AsyncIterable<unknown>>;
}

function validateExportDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Export date must use YYYY-MM-DD");
  }
  return value;
}

function localDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function writeJsonl(
  filePath: string,
  rows: AsyncIterable<unknown>,
): Promise<ExportFileManifest> {
  const file = await open(filePath, "wx");
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  try {
    for await (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      const buffer = Buffer.from(line);
      await file.write(buffer);
      hash.update(buffer);
      count += 1;
      bytes += buffer.byteLength;
    }
  } finally {
    await file.close();
  }
  return { rows: count, bytes, sha256: hash.digest("hex") };
}

export async function writeMemoryExport(
  input: WriteMemoryExportInput,
): Promise<{ directory: string; manifest: MemoryExportManifest }> {
  const date = validateExportDate(input.exportDate);
  const root = resolve(input.outputRoot);
  const finalDirectory = join(root, date);
  const partialDirectory = join(root, `.${date}.partial-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  try {
    await access(finalDirectory);
    throw new Error(`Immutable export already exists at ${finalDirectory}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Immutable export already exists")) {
      throw error;
    }
  }
  await mkdir(partialDirectory, { recursive: false });

  const files = {} as Record<MemoryExportFileName, ExportFileManifest>;
  for (const { filename } of DATASETS) {
    files[filename] = await writeJsonl(join(partialDirectory, filename), input.rows[filename]);
  }
  const manifest: MemoryExportManifest = {
    schemaVersion: 1,
    exportTimestamp: input.exportTimestamp,
    deploymentIdentifier: input.deploymentIdentifier,
    files,
  };
  const manifestFile = await open(join(partialDirectory, "manifest.json"), "wx");
  try {
    await manifestFile.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await manifestFile.close();
  }

  try {
    await rename(partialDirectory, finalDirectory);
  } catch (error) {
    throw new Error(
      `Could not finalize immutable export at ${finalDirectory}; the partial export remains at ${partialDirectory}`,
      { cause: error },
    );
  }
  return { directory: finalDirectory, manifest };
}

interface ExportCliOptions extends ConvexMigrationTarget {
  outputRoot: string;
  exportDate: string;
  pageSize: number;
}

function parseArgs(argv: string[]): ExportCliOptions {
  const options: ExportCliOptions = {
    outputRoot: "backups/memory",
    exportDate: localDate(),
    pageSize: 100,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--output-root") options.outputRoot = value();
    else if (arg === "--date") options.exportDate = validateExportDate(value());
    else if (arg === "--page-size") options.pageSize = Number(value());
    else if (arg === "--prod") options.prod = true;
    else if (arg === "--deployment") options.deployment = value();
    else if (arg === "--help") {
      console.log(
        "Usage: npm run memory:export -- [--prod | --deployment NAME] [--date YYYY-MM-DD] [--output-root PATH] [--page-size 1..250]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 250) {
    throw new Error("--page-size must be an integer between 1 and 250");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = {} as Record<MemoryExportFileName, AsyncIterable<unknown>>;
  for (const dataset of DATASETS) {
    rows[dataset.filename] = paginateConvexMigration({
      functionName: dataset.functionName,
      pageSize: options.pageSize,
      target: options,
    });
  }
  const result = await writeMemoryExport({
    outputRoot: options.outputRoot,
    exportDate: options.exportDate,
    exportTimestamp: new Date().toISOString(),
    deploymentIdentifier: deploymentIdentifier(options),
    rows,
  });
  console.log(`Memory export written to ${result.directory}`);
  console.log(JSON.stringify(result.manifest, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath || basename(process.argv[1] ?? "") === "export-convex-memory.ts") {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
