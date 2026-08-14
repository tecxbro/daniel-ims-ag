#!/usr/bin/env tsx
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  createSupermemoryAdapter,
  readMemoryProviderConfiguration,
} from "../server/memory/supermemory/client.js";
import { deriveMemoryIdentity } from "../server/memory/supermemory/identity.js";
import {
  findLatestMemoryBackup,
  legacyMemoryContentHash,
  readJsonl,
  resolveOwnerPhone,
  stableLegacyImageAnchorCustomId,
  verifyExportManifest,
  type LegacyMemoryRecord,
  type MigrationLedgerRow,
} from "./memory-migration-lib.js";
import {
  paginateConvexMigration,
  runConvexMigrationFunction,
  type ConvexMigrationTarget,
} from "./convex-migration-cli.js";

loadEnv({ path: ".env.local" });
loadEnv();

interface VerifyCliOptions extends ConvexMigrationTarget {
  backupDirectory?: string;
  ownerPhone?: string;
  isolationOwnerPhone?: string;
  factIds: string[];
  offline: boolean;
}

function parseArgs(argv: string[]): VerifyCliOptions {
  const options: VerifyCliOptions = { factIds: [], offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--backup-dir") options.backupDirectory = value();
    else if (arg === "--owner-phone") options.ownerPhone = value();
    else if (arg === "--isolation-owner-phone") options.isolationOwnerPhone = value();
    else if (arg === "--fact-ids") {
      options.factIds = value()
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--offline") options.offline = true;
    else if (arg === "--prod") options.prod = true;
    else if (arg === "--deployment") options.deployment = value();
    else if (arg === "--help") {
      console.log(
        "Usage: npm run memory:verify -- --owner-phone +1... [--backup-dir PATH] [--offline | --fact-ids id1,... --isolation-owner-phone +1...] [--prod | --deployment NAME]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function ledgerRows(target: ConvexMigrationTarget): Promise<MigrationLedgerRow[]> {
  const rows: MigrationLedgerRow[] = [];
  for (const status of ["pending", "migrated", "failed", "skipped"] as const) {
    for await (const row of paginateConvexMigration<MigrationLedgerRow>({
      functionName: "memoryMigration:listByStatus",
      args: { status },
      pageSize: 100,
      target,
    })) {
      rows.push(row);
    }
  }
  return rows;
}

async function checkProvider(input: {
  active: LegacyMemoryRecord[];
  inactive: LegacyMemoryRecord[];
  factIds: string[];
  ownerPhone: string;
  isolationOwnerPhone?: string;
}): Promise<{
  searchableFacts: number;
  inactiveAbsent: number;
  profilePopulated: boolean;
  crossUserLeaks: number;
}> {
  if (input.factIds.length < 25) {
    throw new Error("Live verification requires at least 25 manually selected --fact-ids");
  }
  if (!input.isolationOwnerPhone) {
    throw new Error("Live verification requires --isolation-owner-phone");
  }
  const apiKey = process.env.SUPERMEMORY_API_KEY?.trim();
  const salt = process.env.DANIEL_MEMORY_ID_SALT?.trim();
  if (!apiKey || !salt) {
    throw new Error("Live verification requires SUPERMEMORY_API_KEY and DANIEL_MEMORY_ID_SALT");
  }
  const config = readMemoryProviderConfiguration(process.env);
  const provider = createSupermemoryAdapter({
    apiKey,
    timeoutMs: config.timeoutMs,
    defaultSearchLimit: config.searchLimit,
    defaultThreshold: config.threshold,
  });
  const owner = deriveMemoryIdentity(
    { memoryOwnerId: input.ownerPhone, conversationId: `sms:${input.ownerPhone}` },
    { salt },
  );
  const isolationOwner = deriveMemoryIdentity(
    {
      memoryOwnerId: input.isolationOwnerPhone,
      conversationId: `sms:${input.isolationOwnerPhone}`,
    },
    { salt },
  );
  const byId = new Map(input.active.map((memory) => [memory.memoryId, memory]));
  const selectedMemories = input.factIds.map((factId) => {
    const selected = byId.get(factId);
    if (!selected) throw new Error(`Selected fact is not active in the export: ${factId}`);
    return selected;
  });
  if (!selectedMemories.some((memory) => memory.segment === "identity")) {
    throw new Error("Live verification fact set must include an identity memory");
  }
  if (!selectedMemories.some((memory) => memory.segment === "preference")) {
    throw new Error("Live verification fact set must include a preference memory");
  }
  let searchableFacts = 0;
  let crossUserLeaks = 0;
  for (const factId of input.factIds) {
    const memory = byId.get(factId)!;
    const contentHash = legacyMemoryContentHash(memory);
    const results = await provider.search({
      q: memory.content,
      containerTag: owner.containerTag,
      searchMode: "memories",
      threshold: 0,
      limit: 20,
    });
    const matched = results.some(
      (result) =>
        result.metadata?.legacyMemoryId === memory.memoryId &&
        result.metadata?.migrationContentHash === contentHash,
    );
    if (!matched) throw new Error(`Selected fact is not searchable: ${factId}`);
    if (
      results.some(
        (result) =>
          result.metadata?.legacyMemoryId === memory.memoryId &&
          result.metadata?.migrationContentHash !== contentHash,
      )
    ) {
      throw new Error(`Selected fact returned a stale migrated version: ${factId}`);
    }
    searchableFacts += 1;

    const foreignResults = await provider.search({
      q: memory.content,
      containerTag: isolationOwner.containerTag,
      searchMode: "memories",
      threshold: 0,
      limit: 20,
    });
    if (foreignResults.some((result) => result.metadata?.legacyMemoryId === memory.memoryId)) {
      crossUserLeaks += 1;
    }
  }

  let inactiveAbsent = 0;
  for (const memory of input.inactive) {
    const results = await provider.search({
      q: memory.content,
      containerTag: owner.containerTag,
      searchMode: "memories",
      threshold: 0,
      limit: 20,
    });
    if (results.some((result) => result.metadata?.legacyMemoryId === memory.memoryId)) {
      throw new Error(`Archived/pruned fact was resurrected: ${memory.memoryId}`);
    }
    inactiveAbsent += 1;
  }
  const profile = await provider.profile({
    containerTag: owner.containerTag,
    q: "Summarize durable identity and preferences",
    threshold: config.threshold,
  });
  const profilePopulated =
    profile.profile.static.length + profile.profile.dynamic.length + profile.results.length > 0;
  if (!profilePopulated) throw new Error("Supermemory profile verification returned no context");
  if (crossUserLeaks > 0) throw new Error(`Detected ${crossUserLeaks} cross-user memory leaks`);
  return { searchableFacts, inactiveAbsent, profilePopulated, crossUserLeaks };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ownerPhone = resolveOwnerPhone(options.ownerPhone, process.env.DANIEL_USER_PHONE);
  const salt = process.env.DANIEL_MEMORY_ID_SALT?.trim();
  if (!salt) throw new Error("DANIEL_MEMORY_ID_SALT is required for verification");
  const identity = deriveMemoryIdentity(
    { memoryOwnerId: ownerPhone, conversationId: `sms:${ownerPhone}` },
    { salt },
  );
  const backupDirectory = options.backupDirectory
    ? resolve(options.backupDirectory)
    : await findLatestMemoryBackup();
  const manifest = await verifyExportManifest(backupDirectory);
  const active: LegacyMemoryRecord[] = [];
  const inactive: LegacyMemoryRecord[] = [];
  for await (const memory of readJsonl<LegacyMemoryRecord>(
    join(backupDirectory, "memory-records.jsonl"),
  )) {
    (memory.lifecycle === "active" ? active : inactive).push(memory);
  }

  const relevantLedger = (await ledgerRows(options)).filter(
    (row) => row.ownerKey === identity.ownerKey && row.containerTag === identity.containerTag,
  );
  const byLegacyId = new Map(relevantLedger.map((row) => [row.legacyMemoryId, row]));
  const reconciliation = { migrated: 0, skipped: 0, failed: 0, pending: 0, missing: 0 };
  let imageAnchorsVerified = 0;
  for (const memory of active) {
    const row = byLegacyId.get(memory.memoryId);
    if (!row) reconciliation.missing += 1;
    else reconciliation[row.status] += 1;
    if (row && row.contentHash !== legacyMemoryContentHash(memory)) {
      throw new Error(`Ledger content hash mismatch for ${memory.memoryId}`);
    }
    if (row?.status === "migrated" && !row.providerMemoryId && !row.providerDocumentId) {
      throw new Error(`Migrated ledger row has no provider ID: ${memory.memoryId}`);
    }
    for (const storageId of memory.imageStorageIds ?? []) {
      const customId = stableLegacyImageAnchorCustomId(identity.ownerKey, storageId);
      const anchors = await runConvexMigrationFunction<Array<{ status: string }>>(
        "memoryImageAnchors:listByCustomId",
        { customId, ownerKey: identity.ownerKey },
        options,
      );
      if (!anchors.some((anchor) => anchor.status === "pending" || anchor.status === "active")) {
        throw new Error(`Missing image anchor for ${memory.memoryId}`);
      }
      imageAnchorsVerified += 1;
    }
  }
  const reconciled =
    reconciliation.migrated +
      reconciliation.skipped +
      reconciliation.failed +
      reconciliation.pending +
      reconciliation.missing ===
    active.length;
  if (!reconciled) throw new Error("Active-memory reconciliation arithmetic failed");
  if (reconciliation.failed || reconciliation.pending || reconciliation.missing) {
    throw new Error(`Migration is not cutover-ready: ${JSON.stringify(reconciliation)}`);
  }

  const provider = options.offline
    ? { skipped: true as const }
    : await checkProvider({
        active,
        inactive,
        factIds: options.factIds,
        ownerPhone,
        isolationOwnerPhone: options.isolationOwnerPhone,
      });
  console.log(
    JSON.stringify(
      {
        backupDirectory,
        exportTimestamp: manifest.exportTimestamp,
        activeRows: active.length,
        inactiveExportOnlyRows: inactive.length,
        reconciliation,
        imageAnchorsVerified,
        provider,
      },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
