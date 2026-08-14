import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { api } from "../../../convex/_generated/api.js";
import { convex } from "../../convex-client.js";
import {
  MemoryIdentityRecoveryRequiredError,
  prepareRawTurnCapture,
  type EnqueueMemorySyncJobInput,
  type RawTurnCaptureInput,
} from "./capture.js";
import {
  memoryIdSaltFingerprint,
  memoryPairingAuthorityProof,
} from "./identity.js";
import { parseMemorySyncJobPayload } from "./job-contract.js";

const LEGACY_RECOVERY_SCHEMA_VERSION = 1 as const;
const RECOVERY_SCHEMA_VERSION = 2 as const;
const DEFAULT_REPLAY_INTERVAL_MS = 30_000;
const DEFAULT_REPLAY_LIMIT = 50;
const MAX_RECOVERY_FILE_BYTES = 2 * 1024 * 1024;

export interface AssistantCaptureRecoveryRecord {
  schemaVersion: typeof LEGACY_RECOVERY_SCHEMA_VERSION | typeof RECOVERY_SCHEMA_VERSION;
  createdAt: number;
  assistant: {
    conversationId: string;
    content: string;
    turnId: string;
  };
  job?: EnqueueMemorySyncJobInput;
}

export interface AssistantCapturePersistenceResult {
  job?: { jobId?: string; payloadHash?: string };
}

export interface CaptureRecoveryDependencies {
  directory?: string;
  now?: () => number;
  persist?: (
    record: AssistantCaptureRecoveryRecord,
  ) => Promise<AssistantCapturePersistenceResult>;
  memoryIdSalt?: string;
  memoryConfigured?: boolean;
  ensureIdentitySaltFingerprint?: (saltFingerprint: string) => Promise<string>;
}

export interface CaptureRecoveryStatus {
  unresolvedCount: number;
  oldestCreatedAt: number | null;
  oldestAgeMs: number | null;
}

function defaultRecoveryDirectory(): string {
  const configured = process.env.DANIEL_MEMORY_RECOVERY_DIR?.trim();
  if (configured) return configured;
  if (platform() === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Daniel",
      "memory-capture-recovery",
    );
  }
  const stateRoot = process.env.XDG_STATE_HOME?.trim();
  return join(stateRoot || join(homedir(), ".local", "state"), "daniel", "memory-capture-recovery");
}

function recoveryDirectory(override?: string): string {
  const directory = resolve(override ?? defaultRecoveryDirectory());
  if (!isAbsolute(directory)) throw new Error("memory recovery directory must be absolute");
  const repository = resolve(process.cwd());
  if (directory === repository || directory.startsWith(`${repository}${sep}`)) {
    throw new Error("memory recovery directory must be outside the repository");
  }
  return directory;
}

function recordFileName(record: AssistantCaptureRecoveryRecord): string {
  const digest = createHash("sha256")
    .update(`${record.assistant.conversationId}:${record.assistant.turnId}`, "utf8")
    .digest("hex");
  return `${digest}.json`;
}

function validateRecord(value: unknown): AssistantCaptureRecoveryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capture recovery record must be an object");
  }
  const record = value as Partial<AssistantCaptureRecoveryRecord>;
  if (
    (record.schemaVersion !== LEGACY_RECOVERY_SCHEMA_VERSION &&
      record.schemaVersion !== RECOVERY_SCHEMA_VERSION) ||
    typeof record.createdAt !== "number" ||
    !record.assistant ||
    typeof record.assistant.conversationId !== "string" ||
    typeof record.assistant.content !== "string" ||
    typeof record.assistant.turnId !== "string" ||
    (record.schemaVersion === LEGACY_RECOVERY_SCHEMA_VERSION && !record.job) ||
    (record.job !== undefined &&
      (record.job.kind !== "conversation_turn" ||
        record.job.turnId !== record.assistant.turnId ||
        record.job.conversationId !== record.assistant.conversationId))
  ) {
    throw new Error("capture recovery record is invalid");
  }
  if (record.job) {
    parseMemorySyncJobPayload(record.job.payload, {
      kind: record.job.kind,
      containerTag: record.job.containerTag,
      customId: record.job.customId,
    });
  }
  return record as AssistantCaptureRecoveryRecord;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

export async function writeCaptureRecoveryRecord(
  record: AssistantCaptureRecoveryRecord,
  options: Pick<CaptureRecoveryDependencies, "directory"> = {},
): Promise<string> {
  const validated = validateRecord(record);
  const directory = recoveryDirectory(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, recordFileName(validated));
  try {
    const existing = validateRecord(JSON.parse(await readFile(path, "utf8")));
    if (
      existing.job?.payloadHash !== validated.job?.payloadHash ||
      existing.assistant.content !== validated.assistant.content
    ) {
      throw new Error(`capture recovery turn has conflicting content: ${validated.assistant.turnId}`);
    }
    return path;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      // Create the first durable record below.
    } else {
      throw error;
    }
  }
  const serialized = JSON.stringify(validated);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECOVERY_FILE_BYTES) {
    throw new Error("capture recovery record exceeds the local size limit");
  }
  await atomicWrite(path, serialized);
  return path;
}

async function defaultPersist(
  record: AssistantCaptureRecoveryRecord,
): Promise<AssistantCapturePersistenceResult> {
  return await convex.mutation(api.messages.persistAssistantTurn, {
    ...record.assistant,
    job: record.job,
    pairingAuthorityProof: record.job ? memoryPairingAuthorityProof() : undefined,
  });
}

async function prepareRecoveryRecord(
  input: RawTurnCaptureInput & { assistantReply: string },
  dependencies: CaptureRecoveryDependencies,
): Promise<AssistantCaptureRecoveryRecord> {
  const now = dependencies.now ?? Date.now;
  const base = {
    memoryConfigured: dependencies.memoryConfigured,
    memoryIdSalt: dependencies.memoryIdSalt,
    now,
  };
  const prepared = await prepareRawTurnCapture(input, {
    ...base,
    allowUnverifiedIdentityOnStateError: true,
    identityStateStore: {
      ensureIdentitySaltFingerprint:
        dependencies.ensureIdentitySaltFingerprint ??
        (async (saltFingerprint) =>
          {
            const result = await convex.mutation(
              api.memoryProviderState.verifyIdentityConfiguration,
              {
                saltFingerprint,
                pairingAuthorityProof: memoryPairingAuthorityProof(
                  dependencies.memoryIdSalt,
                ),
              },
            );
            if (result.status !== "ready") {
              throw new MemoryIdentityRecoveryRequiredError();
            }
            return saltFingerprint;
          }),
    },
  });
  return validateRecord({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    createdAt: now(),
    assistant: {
      conversationId: input.conversationId,
      content: input.assistantReply,
      turnId: input.turnId,
    },
    job: prepared.job ?? undefined,
  });
}

function confirmsExpectedJob(
  expected: EnqueueMemorySyncJobInput,
  result: AssistantCapturePersistenceResult,
): boolean {
  return (
    result.job?.jobId === expected.jobId ||
    result.job?.payloadHash === expected.payloadHash
  );
}

/**
 * Finalizes a delivered/local assistant turn. A failed Convex transaction is
 * converted into an atomic local recovery record; failure to create either
 * durable representation is allowed to propagate to the caller.
 */
export async function finalizeAssistantTurnCapture(
  input: RawTurnCaptureInput,
  dependencies: CaptureRecoveryDependencies = {},
): Promise<{ durable: "convex" | "journal" | "skipped"; jobId?: string }> {
  if (input.kind === "proactive") return { durable: "skipped" };
  const record = await prepareRecoveryRecord(input, dependencies);
  const persist = dependencies.persist ?? defaultPersist;
  try {
    const result = await persist(record);
    if (record.job && !confirmsExpectedJob(record.job, result)) {
      throw new Error("Convex did not confirm the expected memory sync job");
    }
    return { durable: "convex", jobId: record.job?.jobId };
  } catch (error) {
    await writeCaptureRecoveryRecord(record, dependencies);
    console.warn("[supermemory-capture] Convex unavailable; turn journaled", {
      turnId: input.turnId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { durable: "journal", jobId: record.job?.jobId };
  }
}

async function recoveryFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function replayCaptureRecoveryJournal(
  dependencies: CaptureRecoveryDependencies & { limit?: number } = {},
): Promise<{ attempted: number; recovered: number; remaining: number }> {
  const directory = recoveryDirectory(dependencies.directory);
  const files = await recoveryFiles(directory);
  const limit = Math.max(1, Math.min(200, Math.floor(dependencies.limit ?? DEFAULT_REPLAY_LIMIT)));
  const persist = dependencies.persist ?? defaultPersist;
  let attempted = 0;
  let recovered = 0;
  for (const name of files.slice(0, limit)) {
    attempted += 1;
    const path = join(directory, name);
    try {
      const record = validateRecord(JSON.parse(await readFile(path, "utf8")));
      const result = await persist(record);
      if (record.job && !confirmsExpectedJob(record.job, result)) {
        throw new Error("Convex did not confirm the expected memory sync job");
      }
      await unlink(path);
      recovered += 1;
    } catch (error) {
      console.warn("[supermemory-capture] recovery replay deferred", {
        record: name.slice(0, 12),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return { attempted, recovered, remaining: files.length - recovered };
}

export async function inspectCaptureRecoveryJournal(
  dependencies: Pick<CaptureRecoveryDependencies, "directory" | "now"> = {},
): Promise<CaptureRecoveryStatus> {
  const directory = recoveryDirectory(dependencies.directory);
  const files = await recoveryFiles(directory);
  let oldestCreatedAt: number | null = null;
  for (const name of files.slice(0, 200)) {
    try {
      const record = validateRecord(JSON.parse(await readFile(join(directory, name), "utf8")));
      oldestCreatedAt =
        oldestCreatedAt === null ? record.createdAt : Math.min(oldestCreatedAt, record.createdAt);
    } catch {
      // A corrupt record remains visible in the count and is never deleted automatically.
    }
  }
  const now = (dependencies.now ?? Date.now)();
  return {
    unresolvedCount: files.length,
    oldestCreatedAt,
    oldestAgeMs: oldestCreatedAt === null ? null : Math.max(0, now - oldestCreatedAt),
  };
}

export function startCaptureRecoveryReplay(
  dependencies: CaptureRecoveryDependencies & { intervalMs?: number } = {},
): { stop(): void } {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await replayCaptureRecoveryJournal(dependencies);
    } finally {
      running = false;
    }
  };
  void run().catch((error) =>
    console.error("[supermemory-capture] recovery replay failed", error),
  );
  const interval = setInterval(
    () =>
      void run().catch((error) =>
        console.error("[supermemory-capture] recovery replay failed", error),
      ),
    Math.max(1_000, dependencies.intervalMs ?? DEFAULT_REPLAY_INTERVAL_MS),
  );
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}

export function currentMemorySaltFingerprint(memoryIdSalt?: string): string {
  return memoryIdSaltFingerprint(memoryIdSalt);
}
