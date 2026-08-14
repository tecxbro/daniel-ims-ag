import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import type {
  CreateExactMemoryInput,
  MemorySearchResult,
  ProviderMemoryResult,
} from "../server/memory/supermemory/types.js";

export const MEMORY_EXPORT_FILES = [
  "memory-records.jsonl",
  "memory-events.jsonl",
  "consolidation-runs.jsonl",
] as const;

export type MemoryExportFileName = (typeof MEMORY_EXPORT_FILES)[number];
export type LegacyMemoryLifecycle = "active" | "archived" | "pruned";

export interface LegacyMemoryRecord {
  _id?: string;
  _creationTime?: number;
  memoryId: string;
  content: string;
  tier: "short" | "long" | "permanent";
  segment:
    | "identity"
    | "preference"
    | "correction"
    | "relationship"
    | "project"
    | "knowledge"
    | "context";
  importance: number;
  decayRate: number;
  accessCount: number;
  lastAccessedAt: number;
  sourceTurn?: string;
  lifecycle: LegacyMemoryLifecycle;
  supersedes?: string[];
  embedding?: number[];
  metadata?: string;
  createdAt: number;
  imageStorageIds?: string[];
}

export interface ExportFileManifest {
  rows: number;
  bytes: number;
  sha256: string;
}

export interface MemoryExportManifest {
  schemaVersion: 1;
  exportTimestamp: string;
  deploymentIdentifier: string;
  files: Record<MemoryExportFileName, ExportFileManifest>;
}

export interface MigrationLedgerRow {
  legacyMemoryId: string;
  ownerKey: string;
  containerTag: string;
  status: "pending" | "migrated" | "failed" | "skipped";
  contentHash: string;
  providerDocumentId?: string;
  providerMemoryId?: string;
  lastError?: string;
}

export interface MigrationLedgerClient {
  prepare(input: {
    legacyMemoryId: string;
    ownerKey: string;
    containerTag: string;
    contentHash: string;
  }): Promise<{ action: "create" | "resume" | "skip"; row: MigrationLedgerRow }>;
  markMigrated(input: {
    legacyMemoryId: string;
    contentHash: string;
    providerDocumentId?: string;
    providerMemoryId?: string;
  }): Promise<void>;
  markFailed(input: {
    legacyMemoryId: string;
    contentHash: string;
    error: string;
  }): Promise<void>;
  markSkipped(input: {
    legacyMemoryId: string;
    contentHash: string;
    reason: string;
  }): Promise<void>;
}

export interface MigrationProvider {
  search(input: {
    q: string;
    containerTag: string;
    threshold?: number;
    limit?: number;
    searchMode?: "memories" | "hybrid" | "documents";
  }): Promise<MemorySearchResult[]>;
  createExact(input: CreateExactMemoryInput): Promise<ProviderMemoryResult[]>;
}

export interface MigrationImageAnchorClient {
  insert(input: {
    storageId: string;
    ownerKey: string;
    turnId?: string;
    customId: string;
    status: "pending";
    reason: string;
    createdAt: number;
  }): Promise<void>;
}

export interface MemoryMigrationReport {
  active: number;
  migrated: number;
  recovered: number;
  alreadyMigrated: number;
  explicitlySkipped: number;
  failed: number;
  exportOnly: number;
  imageAnchors: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function legacyMemoryContentHash(memory: LegacyMemoryRecord): string {
  return sha256Text(
    JSON.stringify({
      memoryId: memory.memoryId,
      content: memory.content,
      tier: memory.tier,
      segment: memory.segment,
      sourceTurn: memory.sourceTurn ?? null,
      createdAt: memory.createdAt,
      lifecycle: memory.lifecycle,
      importance: memory.importance,
      lastAccessedAt: memory.lastAccessedAt,
      imageStorageIds: [...(memory.imageStorageIds ?? [])].sort(),
    }),
  );
}

export function mapLegacyMemoryToExact(memory: LegacyMemoryRecord): {
  contentHash: string;
  memory: CreateExactMemoryInput["memories"][number];
} {
  const content = memory.content.trim();
  if (!content) throw new Error(`legacy memory ${memory.memoryId} has empty content`);
  const contentHash = legacyMemoryContentHash(memory);
  return {
    contentHash,
    memory: {
      content,
      isStatic: memory.tier === "permanent" && memory.segment === "identity",
      metadata: {
        source: "daniel_legacy_migration",
        schemaVersion: 1,
        legacyMemoryId: memory.memoryId,
        legacyTier: memory.tier,
        legacySegment: memory.segment,
        legacyCreatedAt: memory.createdAt,
        legacyLifecycle: memory.lifecycle,
        legacyImportance: memory.importance,
        legacyLastAccessedAt: memory.lastAccessedAt,
        migrationContentHash: contentHash,
        ...(memory.sourceTurn ? { legacySourceTurn: memory.sourceTurn } : {}),
      },
    },
  };
}

export function stableLegacyImageAnchorCustomId(ownerKey: string, storageId: string): string {
  return `daniel-legacy-image-${sha256Text(`${ownerKey}:${storageId}`).slice(0, 32)}`;
}

export function resolveOwnerPhone(explicit: string | undefined, envValue: string | undefined): string {
  const owner = explicit?.trim() || envValue?.trim();
  if (!owner) {
    throw new Error("Memory owner is required: pass --owner-phone or set DANIEL_USER_PHONE");
  }
  return owner;
}

export async function* readJsonl<T>(filePath: string): AsyncGenerator<T> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Invalid JSONL at ${filePath}:${lineNumber}`, { cause: error });
    }
  }
}

export async function sha256File(filePath: string): Promise<{
  sha256: string;
  bytes: number;
  rows: number;
}> {
  const hash = createHash("sha256");
  let rows = 0;
  const input = createReadStream(filePath);
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    for (const byte of buffer) if (byte === 10) rows += 1;
  }
  const details = await stat(filePath);
  return { sha256: hash.digest("hex"), bytes: details.size, rows };
}

function parseManifest(value: unknown): MemoryExportManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.exportTimestamp !== "string") {
    throw new Error("Invalid memory export manifest");
  }
  if (typeof value.deploymentIdentifier !== "string" || !isRecord(value.files)) {
    throw new Error("Invalid memory export manifest metadata");
  }
  const files = {} as Record<MemoryExportFileName, ExportFileManifest>;
  for (const filename of MEMORY_EXPORT_FILES) {
    const entry = value.files[filename];
    if (
      !isRecord(entry) ||
      typeof entry.rows !== "number" ||
      typeof entry.bytes !== "number" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error(`Invalid manifest entry for ${filename}`);
    }
    files[filename] = {
      rows: entry.rows,
      bytes: entry.bytes,
      sha256: entry.sha256,
    };
  }
  return {
    schemaVersion: 1,
    exportTimestamp: value.exportTimestamp,
    deploymentIdentifier: value.deploymentIdentifier,
    files,
  };
}

export async function verifyExportManifest(directory: string): Promise<MemoryExportManifest> {
  const manifest = parseManifest(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  for (const filename of MEMORY_EXPORT_FILES) {
    const actual = await sha256File(join(directory, filename));
    const expected = manifest.files[filename];
    if (
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes ||
      actual.rows !== expected.rows
    ) {
      throw new Error(`Export checksum/count mismatch for ${filename}`);
    }
  }
  return manifest;
}

export async function findLatestMemoryBackup(root = "backups/memory"): Promise<string> {
  const absoluteRoot = resolve(root);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const candidate of candidates) {
    const directory = join(absoluteRoot, candidate);
    try {
      await access(join(directory, "manifest.json"));
      return directory;
    } catch {
      // Continue to the next complete export.
    }
  }
  throw new Error(`No complete memory export found under ${absoluteRoot}`);
}

function matchingMigratedMemory(
  results: readonly MemorySearchResult[],
  legacyMemoryId: string,
  contentHash: string,
): MemorySearchResult | undefined {
  return results.find(
    (result) =>
      result.metadata?.legacyMemoryId === legacyMemoryId &&
      result.metadata?.migrationContentHash === contentHash,
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

interface PreparedMemory {
  source: LegacyMemoryRecord;
  contentHash: string;
  exact: CreateExactMemoryInput["memories"][number];
}

async function createImageAnchors(
  source: LegacyMemoryRecord,
  ownerKey: string,
  anchors: MigrationImageAnchorClient,
): Promise<number> {
  let count = 0;
  for (const storageId of source.imageStorageIds ?? []) {
    await anchors.insert({
      storageId,
      ownerKey,
      turnId: source.sourceTurn,
      customId: stableLegacyImageAnchorCustomId(ownerKey, storageId),
      status: "pending",
      reason: "legacy_memory_image_reference",
      createdAt: source.createdAt,
    });
    count += 1;
  }
  return count;
}

async function recoverExisting(
  provider: MigrationProvider,
  containerTag: string,
  item: PreparedMemory,
): Promise<MemorySearchResult | undefined> {
  const results = await provider.search({
    q: item.source.content,
    containerTag,
    searchMode: "memories",
    threshold: 0,
    limit: 20,
  });
  return matchingMigratedMemory(results, item.source.memoryId, item.contentHash);
}

export async function migrateLegacyMemories(input: {
  records: AsyncIterable<LegacyMemoryRecord> | Iterable<LegacyMemoryRecord>;
  ownerKey: string;
  containerTag: string;
  ledger: MigrationLedgerClient;
  provider: MigrationProvider;
  anchors: MigrationImageAnchorClient;
  batchSize?: number;
  skipMemoryIds?: ReadonlySet<string>;
  skipReason?: string;
}): Promise<MemoryMigrationReport> {
  const batchSize = input.batchSize ?? 25;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("batchSize must be an integer between 1 and 100");
  }
  const report: MemoryMigrationReport = {
    active: 0,
    migrated: 0,
    recovered: 0,
    alreadyMigrated: 0,
    explicitlySkipped: 0,
    failed: 0,
    exportOnly: 0,
    imageAnchors: 0,
  };
  let batch: PreparedMemory[] = [];

  const finishMigrated = async (
    item: PreparedMemory,
    providerMemoryId: string,
    recovered: boolean,
  ) => {
    await input.ledger.markMigrated({
      legacyMemoryId: item.source.memoryId,
      contentHash: item.contentHash,
      providerMemoryId,
    });
    report.imageAnchors += await createImageAnchors(item.source, input.ownerKey, input.anchors);
    if (recovered) report.recovered += 1;
    else report.migrated += 1;
  };

  const failItem = async (item: PreparedMemory, error: unknown) => {
    await input.ledger.markFailed({
      legacyMemoryId: item.source.memoryId,
      contentHash: item.contentHash,
      error: errorMessage(error),
    });
    report.failed += 1;
  };

  const flush = async () => {
    const current = batch;
    batch = [];
    if (current.length === 0) return;
    try {
      const created = await input.provider.createExact({
        containerTag: input.containerTag,
        memories: current.map((item) => item.exact),
      });
      if (created.length !== current.length) {
        throw new Error(
          `Supermemory returned ${created.length} memories for a ${current.length}-memory batch`,
        );
      }
      for (let index = 0; index < current.length; index += 1) {
        await finishMigrated(current[index], created[index].id, false);
      }
    } catch (batchError) {
      for (const item of current) {
        try {
          const recovered = await recoverExisting(input.provider, input.containerTag, item);
          if (recovered) await finishMigrated(item, recovered.id, true);
          else await failItem(item, batchError);
        } catch (recoveryError) {
          await failItem(item, recoveryError);
        }
      }
    }
  };

  for await (const source of input.records) {
    if (source.lifecycle !== "active") {
      report.exportOnly += 1;
      continue;
    }
    report.active += 1;
    const contentHash = legacyMemoryContentHash(source);
    const prepared = await input.ledger.prepare({
      legacyMemoryId: source.memoryId,
      ownerKey: input.ownerKey,
      containerTag: input.containerTag,
      contentHash,
    });
    if (prepared.action === "skip") {
      if (prepared.row.status === "migrated") {
        report.alreadyMigrated += 1;
        report.imageAnchors += await createImageAnchors(source, input.ownerKey, input.anchors);
      } else {
        report.explicitlySkipped += 1;
      }
      continue;
    }

    if (input.skipMemoryIds?.has(source.memoryId)) {
      await input.ledger.markSkipped({
        legacyMemoryId: source.memoryId,
        contentHash,
        reason: input.skipReason ?? "explicitly skipped by migration operator",
      });
      report.explicitlySkipped += 1;
      continue;
    }

    let mapped: ReturnType<typeof mapLegacyMemoryToExact>;
    try {
      mapped = mapLegacyMemoryToExact(source);
    } catch (error) {
      await input.ledger.markFailed({
        legacyMemoryId: source.memoryId,
        contentHash,
        error: errorMessage(error),
      });
      report.failed += 1;
      continue;
    }

    const item: PreparedMemory = {
      source,
      contentHash: mapped.contentHash,
      exact: mapped.memory,
    };
    try {
      const recovered = await recoverExisting(input.provider, input.containerTag, item);
      if (recovered) {
        await finishMigrated(item, recovered.id, true);
        continue;
      }
    } catch (error) {
      await failItem(item, error);
      continue;
    }
    batch.push(item);
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return report;
}
