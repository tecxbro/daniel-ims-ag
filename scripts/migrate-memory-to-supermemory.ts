#!/usr/bin/env tsx
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  createSupermemoryAdapter,
  readMemoryProviderConfiguration,
} from "../server/memory/supermemory/client.js";
import { createContainerSettingsCoordinator } from "../server/memory/supermemory/container.js";
import { deriveMemoryIdentity } from "../server/memory/supermemory/identity.js";
import type { MigrationLedgerClient } from "./memory-migration-lib.js";
import {
  findLatestMemoryBackup,
  migrateLegacyMemories,
  readJsonl,
  resolveOwnerPhone,
  sha256Text,
  verifyExportManifest,
  type LegacyMemoryRecord,
  type MigrationImageAnchorClient,
} from "./memory-migration-lib.js";
import {
  paginateConvexMigration,
  runConvexMigrationFunction,
  type ConvexMigrationTarget,
} from "./convex-migration-cli.js";

loadEnv({ path: ".env.local" });
loadEnv();

interface MigrationCliOptions extends ConvexMigrationTarget {
  backupDirectory?: string;
  ownerPhone?: string;
  batchSize: number;
  historyBackfillDays: number;
  historyRateLimitMs: number;
  skipMemoryIds: Set<string>;
  skipReason?: string;
}

interface LegacyMessage {
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  turnId?: string;
  createdAt: number;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseArgs(argv: string[]): MigrationCliOptions {
  const options: MigrationCliOptions = {
    batchSize: 25,
    historyBackfillDays: parseNonNegativeInteger(
      process.env.DANIEL_SUPERMEMORY_HISTORY_BACKFILL_DAYS ?? "0",
      "DANIEL_SUPERMEMORY_HISTORY_BACKFILL_DAYS",
    ),
    historyRateLimitMs: 100,
    skipMemoryIds: new Set(),
  };
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
    else if (arg === "--batch-size") options.batchSize = parseNonNegativeInteger(value(), arg);
    else if (arg === "--history-backfill-days") {
      options.historyBackfillDays = parseNonNegativeInteger(value(), arg);
    } else if (arg === "--history-rate-limit-ms") {
      options.historyRateLimitMs = parseNonNegativeInteger(value(), arg);
    } else if (arg === "--skip-memory-ids") {
      options.skipMemoryIds = new Set(
        value()
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
    } else if (arg === "--skip-reason") {
      options.skipReason = value();
    } else if (arg === "--prod") options.prod = true;
    else if (arg === "--deployment") options.deployment = value();
    else if (arg === "--help") {
      console.log(
        "Usage: npm run memory:migrate -- --owner-phone +1... [--backup-dir PATH] [--batch-size 1..100] [--skip-memory-ids id1,id2 --skip-reason TEXT] [--history-backfill-days N] [--history-rate-limit-ms N] [--prod | --deployment NAME]",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.batchSize < 1 || options.batchSize > 100) {
    throw new Error("--batch-size must be an integer between 1 and 100");
  }
  if (options.skipMemoryIds.size > 0 && !options.skipReason?.trim()) {
    throw new Error("--skip-memory-ids requires --skip-reason");
  }
  return options;
}

function createLedger(target: ConvexMigrationTarget): MigrationLedgerClient {
  return {
    async prepare(input) {
      return await runConvexMigrationFunction("memoryMigration:prepare", input, target);
    },
    async markMigrated(input) {
      await runConvexMigrationFunction("memoryMigration:markMigrated", input, target);
    },
    async markFailed(input) {
      await runConvexMigrationFunction("memoryMigration:markFailed", input, target);
    },
    async markSkipped(input) {
      await runConvexMigrationFunction("memoryMigration:markSkipped", input, target);
    },
  };
}

function createImageAnchors(target: ConvexMigrationTarget): MigrationImageAnchorClient {
  return {
    async insert(input) {
      await runConvexMigrationFunction("memoryImageAnchors:insertForMigration", input, target);
    },
  };
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function buildHistoricalTurnContent(input: {
  turnId: string;
  userMessage: string;
  assistantReply: string;
}): string {
  return [
    "Conversation between the user and Daniel.",
    `Turn: ${input.turnId}`,
    "",
    `USER: ${input.userMessage}`,
    "",
    `DANIEL: ${input.assistantReply}`,
  ].join("\n");
}

async function backfillTranscriptHistory(input: {
  days: number;
  rateLimitMs: number;
  ownerPhone: string;
  salt: string;
  target: ConvexMigrationTarget;
  ledger: MigrationLedgerClient;
  provider: ReturnType<typeof createSupermemoryAdapter>;
}): Promise<{ submitted: number; skipped: number; unpaired: number }> {
  if (input.days === 0) return { submitted: 0, skipped: 0, unpaired: 0 };
  const createdAtOrAfter = Date.now() - input.days * 24 * 60 * 60 * 1_000;
  const pendingByTurn = new Map<string, LegacyMessage>();
  const pendingByConversation = new Map<string, LegacyMessage[]>();
  let submitted = 0;
  let skipped = 0;

  for await (const message of paginateConvexMigration<LegacyMessage>({
    functionName: "memoryRecords:exportMessagesSincePage",
    args: { createdAtOrAfter },
    pageSize: 100,
    target: input.target,
  })) {
    if (message.role === "system") continue;
    const turnKey = message.turnId
      ? `${message.conversationId}:${message.turnId}`
      : undefined;
    if (message.role === "user") {
      if (turnKey) pendingByTurn.set(turnKey, message);
      const queue = pendingByConversation.get(message.conversationId) ?? [];
      queue.push(message);
      pendingByConversation.set(message.conversationId, queue);
      continue;
    }

    let userMessage = turnKey ? pendingByTurn.get(turnKey) : undefined;
    if (!userMessage) userMessage = pendingByConversation.get(message.conversationId)?.shift();
    if (!userMessage) continue;
    if (turnKey) pendingByTurn.delete(turnKey);
    const queue = pendingByConversation.get(message.conversationId);
    if (queue) {
      const index = queue.indexOf(userMessage);
      if (index >= 0) queue.splice(index, 1);
    }

    const turnId = message.turnId ?? userMessage.turnId ?? `history-${userMessage.createdAt}`;
    const identity = deriveMemoryIdentity(
      { memoryOwnerId: input.ownerPhone, conversationId: message.conversationId },
      { salt: input.salt },
    );
    const content = buildHistoricalTurnContent({
      turnId,
      userMessage: userMessage.content,
      assistantReply: message.content,
    });
    const contentHash = sha256Text(content);
    const legacyMemoryId = `transcript:${sha256Text(`${message.conversationId}:${turnId}`).slice(0, 40)}`;
    const prepared = await input.ledger.prepare({
      legacyMemoryId,
      ownerKey: identity.ownerKey,
      containerTag: identity.containerTag,
      contentHash,
    });
    if (prepared.action === "skip") {
      skipped += 1;
      continue;
    }
    try {
      const document = await input.provider.captureTurn({
        content,
        containerTag: identity.containerTag,
        customId: identity.customId,
        taskType: "memory",
        metadata: {
          source: "daniel_history_backfill",
          kind: "conversation_turn",
          channel: "imessage",
          conversationKey: identity.conversationKey,
          turnId,
          schemaVersion: 1,
        },
      });
      await input.ledger.markMigrated({
        legacyMemoryId,
        contentHash,
        providerDocumentId: document.id,
      });
      submitted += 1;
      await wait(input.rateLimitMs);
    } catch (error) {
      await input.ledger.markFailed({
        legacyMemoryId,
        contentHash,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      });
    }
  }

  const unpaired = [...pendingByConversation.values()].reduce((sum, queue) => sum + queue.length, 0);
  return { submitted, skipped, unpaired };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const ownerPhone = resolveOwnerPhone(options.ownerPhone, process.env.DANIEL_USER_PHONE);
  const salt = process.env.DANIEL_MEMORY_ID_SALT?.trim();
  const apiKey = process.env.SUPERMEMORY_API_KEY?.trim();
  if (!salt) throw new Error("DANIEL_MEMORY_ID_SALT is required for migration");
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is required for migration");

  const backupDirectory = options.backupDirectory
    ? resolve(options.backupDirectory)
    : await findLatestMemoryBackup();
  const manifest = await verifyExportManifest(backupDirectory);
  const identity = deriveMemoryIdentity(
    { memoryOwnerId: ownerPhone, conversationId: `sms:${ownerPhone}` },
    { salt },
  );
  const config = readMemoryProviderConfiguration(process.env);
  const provider = createSupermemoryAdapter({
    apiKey,
    timeoutMs: config.timeoutMs,
    defaultSearchLimit: config.searchLimit,
    defaultThreshold: config.threshold,
  });
  const target: ConvexMigrationTarget = options;
  const ledger = createLedger(target);

  const coordinator = createContainerSettingsCoordinator({
    provider,
    memoryIdSalt: salt,
    stateStore: {
      async ensureIdentitySaltFingerprint(saltFingerprint) {
        return await runConvexMigrationFunction(
          "memoryProviderState:ensureIdentitySaltFingerprint",
          { saltFingerprint },
          target,
        );
      },
      async getContainerState(containerTag) {
        return await runConvexMigrationFunction(
          "memoryProviderState:getContainerState",
          { containerTag },
          target,
        );
      },
      async markContainerInitialized(state) {
        await runConvexMigrationFunction(
          "memoryProviderState:markContainerInitialized",
          state,
          target,
        );
      },
    },
  });
  await coordinator.ensureContainerSettings(identity.containerTag);

  const report = await migrateLegacyMemories({
    records: readJsonl<LegacyMemoryRecord>(join(backupDirectory, "memory-records.jsonl")),
    ownerKey: identity.ownerKey,
    containerTag: identity.containerTag,
    ledger,
    provider,
    anchors: createImageAnchors(target),
    batchSize: options.batchSize,
    skipMemoryIds: options.skipMemoryIds,
    skipReason: options.skipReason,
  });
  const history = await backfillTranscriptHistory({
    days: options.historyBackfillDays,
    rateLimitMs: options.historyRateLimitMs,
    ownerPhone,
    salt,
    target,
    ledger,
    provider,
  });

  console.log(
    JSON.stringify(
      {
        backupDirectory,
        exportTimestamp: manifest.exportTimestamp,
        containerTag: identity.containerTag,
        report,
        history,
      },
      null,
      2,
    ),
  );
  if (report.failed > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
