import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMemoryExport } from "../scripts/export-convex-memory.js";
import {
  legacyMemoryContentHash,
  mapLegacyMemoryToExact,
  migrateLegacyMemories,
  resolveOwnerPhone,
  stableLegacyImageAnchorCustomId,
  verifyExportManifest,
  type LegacyMemoryRecord,
  type MigrationLedgerClient,
  type MigrationLedgerRow,
} from "../scripts/memory-migration-lib.js";
import type { MemorySearchResult } from "../server/memory/supermemory/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function memory(overrides: Partial<LegacyMemoryRecord> = {}): LegacyMemoryRecord {
  return {
    memoryId: "legacy_1",
    content: "The user prefers aisle seats.",
    tier: "long",
    segment: "preference",
    importance: 0.9,
    decayRate: 0.1,
    accessCount: 4,
    lastAccessedAt: 2_000,
    lifecycle: "active",
    createdAt: 1_000,
    embedding: [0.1, 0.2],
    supersedes: ["old_1"],
    ...overrides,
  };
}

function fakeLedger(): {
  client: MigrationLedgerClient;
  rows: Map<string, MigrationLedgerRow>;
  migratedIds: string[];
} {
  const rows = new Map<string, MigrationLedgerRow>();
  const migratedIds: string[] = [];
  return {
    rows,
    migratedIds,
    client: {
      async prepare(input) {
        const existing = rows.get(input.legacyMemoryId);
        if (existing) {
          if (existing.contentHash !== input.contentHash) throw new Error("content hash changed");
          return {
            action:
              existing.status === "migrated" || existing.status === "skipped"
                ? ("skip" as const)
                : ("resume" as const),
            row: existing,
          };
        }
        const row: MigrationLedgerRow = { ...input, status: "pending" };
        rows.set(input.legacyMemoryId, row);
        return { action: "create" as const, row };
      },
      async markMigrated(input) {
        const row = rows.get(input.legacyMemoryId)!;
        rows.set(input.legacyMemoryId, { ...row, ...input, status: "migrated" });
        if (input.providerMemoryId) migratedIds.push(input.providerMemoryId);
      },
      async markFailed(input) {
        const row = rows.get(input.legacyMemoryId)!;
        rows.set(input.legacyMemoryId, {
          ...row,
          status: "failed",
          lastError: input.error,
        });
      },
      async markSkipped(input) {
        const row = rows.get(input.legacyMemoryId)!;
        rows.set(input.legacyMemoryId, {
          ...row,
          status: "skipped",
          lastError: input.reason,
        });
      },
    },
  };
}

async function* rows<T>(values: T[]): AsyncGenerator<T> {
  for (const value of values) yield value;
}

describe("Supermemory legacy migration", () => {
  it("requires an explicit owner and never guesses", () => {
    expect(() => resolveOwnerPhone(undefined, undefined)).toThrow(/owner is required/i);
    expect(resolveOwnerPhone(" +15550000000 ", undefined)).toBe("+15550000000");
    expect(resolveOwnerPhone(undefined, "+15551111111")).toBe("+15551111111");
  });

  it("maps exact memory fields without legacy embeddings or decay semantics", () => {
    const mapped = mapLegacyMemoryToExact(
      memory({
        tier: "permanent",
        segment: "identity",
        sourceTurn: "turn_1",
      }),
    );
    expect(mapped.memory).toMatchObject({
      content: "The user prefers aisle seats.",
      isStatic: true,
      metadata: {
        source: "daniel_legacy_migration",
        legacyMemoryId: "legacy_1",
        legacyTier: "permanent",
        legacySegment: "identity",
        legacySourceTurn: "turn_1",
      },
    });
    expect(mapped.memory.metadata).not.toHaveProperty("embedding");
    expect(mapped.memory.metadata).not.toHaveProperty("decayRate");
    expect(mapped.memory.metadata).not.toHaveProperty("accessCount");
    expect(mapLegacyMemoryToExact(memory()).memory.isStatic).toBe(false);
  });

  it("migrates only active rows in bounded batches and records image anchors", async () => {
    const ledger = fakeLedger();
    const createExact = vi.fn(async ({ memories }: { memories: unknown[] }) =>
      memories.map((_, index) => ({ id: `provider_${index}`, content: "created" })),
    );
    const search = vi.fn(async () => [] as MemorySearchResult[]);
    const insert = vi.fn(async () => undefined);
    const report = await migrateLegacyMemories({
      records: rows([
        memory({ imageStorageIds: ["storage_1"] }),
        memory({ memoryId: "legacy_archived", lifecycle: "archived" }),
        memory({ memoryId: "legacy_pruned", lifecycle: "pruned" }),
      ]),
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      ledger: ledger.client,
      provider: { search, createExact },
      anchors: { insert },
      batchSize: 10,
    });

    expect(report).toMatchObject({ active: 1, migrated: 1, exportOnly: 2, failed: 0 });
    expect(createExact).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        storageId: "storage_1",
        ownerKey: "owner_a",
        status: "pending",
      }),
    );
    expect(ledger.rows.get("legacy_1")?.status).toBe("migrated");
  });

  it("resumes idempotently and recovers a provider write completed before ledger update", async () => {
    const ledger = fakeLedger();
    const source = memory();
    const hash = legacyMemoryContentHash(source);
    ledger.rows.set(source.memoryId, {
      legacyMemoryId: source.memoryId,
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      status: "failed",
      contentHash: hash,
    });
    const createExact = vi.fn(async () => []);
    const search = vi.fn(async () => [
      {
        id: "provider_existing",
        content: source.content,
        kind: "memory" as const,
        similarity: 1,
        metadata: {
          legacyMemoryId: source.memoryId,
          migrationContentHash: hash,
        },
      },
    ]);
    const report = await migrateLegacyMemories({
      records: [source],
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      ledger: ledger.client,
      provider: { search, createExact },
      anchors: { insert: async () => undefined },
    });
    expect(report).toMatchObject({ recovered: 1, migrated: 0, failed: 0 });
    expect(createExact).not.toHaveBeenCalled();
    expect(ledger.migratedIds).toEqual(["provider_existing"]);

    const rerun = await migrateLegacyMemories({
      records: [source],
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      ledger: ledger.client,
      provider: { search, createExact },
      anchors: { insert: async () => undefined },
    });
    expect(rerun.alreadyMigrated).toBe(1);
    expect(createExact).not.toHaveBeenCalled();
  });

  it("stops when a migrated legacy row changes content", async () => {
    const ledger = fakeLedger();
    const original = memory();
    ledger.rows.set(original.memoryId, {
      legacyMemoryId: original.memoryId,
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      status: "migrated",
      contentHash: legacyMemoryContentHash(original),
      providerMemoryId: "provider_1",
    });
    await expect(
      migrateLegacyMemories({
        records: [memory({ content: "Changed content" })],
        ownerKey: "owner_a",
        containerTag: "daniel-user-owner_a",
        ledger: ledger.client,
        provider: { search: async () => [], createExact: async () => [] },
        anchors: { insert: async () => undefined },
      }),
    ).rejects.toThrow(/content hash changed/);
  });

  it("records an operator-approved active skip without calling the provider", async () => {
    const ledger = fakeLedger();
    const createExact = vi.fn(async () => []);
    const report = await migrateLegacyMemories({
      records: [memory()],
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      ledger: ledger.client,
      provider: { search: async () => [], createExact },
      anchors: { insert: async () => undefined },
      skipMemoryIds: new Set(["legacy_1"]),
      skipReason: "source row is intentionally excluded",
    });
    expect(report.explicitlySkipped).toBe(1);
    expect(ledger.rows.get("legacy_1")).toMatchObject({
      status: "skipped",
      lastError: "source row is intentionally excluded",
    });
    expect(createExact).not.toHaveBeenCalled();
  });

  it("records actionable row failures and continues without unsafe provider writes", async () => {
    const ledger = fakeLedger();
    const createExact = vi.fn(async () => []);
    const report = await migrateLegacyMemories({
      records: [memory({ content: "   " })],
      ownerKey: "owner_a",
      containerTag: "daniel-user-owner_a",
      ledger: ledger.client,
      provider: { search: async () => [], createExact },
      anchors: { insert: async () => undefined },
    });
    expect(report.failed).toBe(1);
    expect(ledger.rows.get("legacy_1")).toMatchObject({
      status: "failed",
      lastError: expect.stringMatching(/empty content/),
    });
    expect(createExact).not.toHaveBeenCalled();
  });

  it("keeps user containers isolated during provider requests", async () => {
    const seenContainers: string[] = [];
    const migrateFor = async (ownerKey: string, containerTag: string, id: string) => {
      const ledger = fakeLedger();
      await migrateLegacyMemories({
        records: [memory({ memoryId: id })],
        ownerKey,
        containerTag,
        ledger: ledger.client,
        provider: {
          async search(input) {
            seenContainers.push(input.containerTag);
            return [];
          },
          async createExact(input) {
            seenContainers.push(input.containerTag);
            return [{ id: `provider_${id}`, content: id }];
          },
        },
        anchors: { insert: async () => undefined },
      });
    };
    await migrateFor("owner_a", "daniel-user-owner_a", "a");
    await migrateFor("owner_b", "daniel-user-owner_b", "b");
    expect(new Set(seenContainers)).toEqual(
      new Set(["daniel-user-owner_a", "daniel-user-owner_b"]),
    );
  });

  it("writes an immutable complete export with validated checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "daniel-memory-export-"));
    temporaryDirectories.push(root);
    const result = await writeMemoryExport({
      outputRoot: root,
      exportDate: "2026-08-13",
      exportTimestamp: "2026-08-13T12:00:00.000Z",
      deploymentIdentifier: "test",
      rows: {
        "memory-records.jsonl": rows([memory()]),
        "memory-events.jsonl": rows([{ eventType: "extract" }]),
        "consolidation-runs.jsonl": rows([{ runId: "run_1" }]),
      },
    });
    const manifest = await verifyExportManifest(result.directory);
    expect(manifest.files["memory-records.jsonl"].rows).toBe(1);
    expect(manifest.files["memory-events.jsonl"].sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      writeMemoryExport({
        outputRoot: root,
        exportDate: "2026-08-13",
        exportTimestamp: "2026-08-13T13:00:00.000Z",
        deploymentIdentifier: "test",
        rows: {
          "memory-records.jsonl": rows([]),
          "memory-events.jsonl": rows([]),
          "consolidation-runs.jsonl": rows([]),
        },
      }),
    ).rejects.toThrow(/Immutable export already exists/);

    await writeFile(join(result.directory, "memory-events.jsonl"), "tampered\n");
    await expect(verifyExportManifest(result.directory)).rejects.toThrow(/mismatch/);
    expect(JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      deploymentIdentifier: "test",
    });
  });

  it("derives private deterministic image anchor IDs", () => {
    const first = stableLegacyImageAnchorCustomId("owner_a", "storage_private_1");
    expect(first).toBe(stableLegacyImageAnchorCustomId("owner_a", "storage_private_1"));
    expect(first).not.toContain("storage_private_1");
    expect(first).not.toBe(stableLegacyImageAnchorCustomId("owner_b", "storage_private_1"));
  });
});
