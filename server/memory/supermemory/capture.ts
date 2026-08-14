import { createHash, randomUUID } from "node:crypto";
import { api } from "../../../convex/_generated/api.js";
import { convex } from "../../convex-client.js";
import { readMemoryProviderConfiguration } from "./client.js";
import {
  deriveMemoryIdentity,
  memoryIdSaltFingerprint,
} from "./identity.js";
import type {
  CaptureTurnInput,
  MemoryOwnerContext,
  MemoryWriteMode,
  ProviderMetadata,
} from "./types.js";

export const CONVERSATION_INGESTION_STRATEGY = "delta_turn_v1" as const;

export type MemorySyncJobKind =
  | "conversation_turn"
  | "explicit_memory"
  | "image"
  | "memory_update"
  | "memory_forget";

export interface ConversationTurnJobPayload {
  schemaVersion: 1;
  ingestionStrategy: typeof CONVERSATION_INGESTION_STRATEGY;
  providerInput: CaptureTurnInput;
}

export interface EnqueueMemorySyncJobInput {
  jobId: string;
  kind: MemorySyncJobKind;
  ownerKey: string;
  containerTag: string;
  customId?: string;
  conversationId?: string;
  turnId?: string;
  payload: string;
  payloadHash: string;
  now: number;
}

export interface EnqueueMemorySyncJobResult {
  jobId: string;
  enqueued: boolean;
  duplicate: boolean;
}

export interface MemorySyncJobStore {
  enqueue(input: EnqueueMemorySyncJobInput): Promise<EnqueueMemorySyncJobResult>;
}

export interface MemoryIdentityStateStore {
  ensureIdentitySaltFingerprint(saltFingerprint: string): Promise<string>;
}

/**
 * Implementation 6 can install this boundary for explicitly durable images.
 * Ordinary screenshots and receipts remain text-only capture in this module.
 */
export interface DurableImageCapturePolicy {
  enqueueEligibleImages(input: {
    identity: MemoryOwnerContext;
    turnId: string;
    imageStorageIds: string[];
    eligibilityToken: string;
  }): Promise<void>;
}

export interface RawTurnCaptureInput {
  conversationId: string;
  memoryOwnerId: string;
  turnId: string;
  userMessage: string;
  assistantReply: string;
  imageStorageIds?: string[];
  kind?: "user" | "proactive";
  channel?: "imessage" | "local";
}

export type RawTurnCaptureResult =
  | {
      enqueued: false;
      reason: "write_mode_disabled" | "synthetic_proactive";
    }
  | {
      enqueued: boolean;
      duplicate: boolean;
      jobId: string;
      payloadHash: string;
      identity: MemoryOwnerContext;
    };

export interface RawTurnCaptureDependencies {
  jobStore: MemorySyncJobStore;
  identityStateStore?: MemoryIdentityStateStore;
  writeMode?: MemoryWriteMode;
  memoryIdSalt?: string;
  now?: () => number;
  createJobId?: () => string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function buildRawTurnContent(input: {
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

export function buildConversationTurnPayload(input: {
  identity: MemoryOwnerContext;
  turnId: string;
  userMessage: string;
  assistantReply: string;
  imageStorageIds?: string[];
  channel?: "imessage" | "local";
}): ConversationTurnJobPayload {
  const imageCount = input.imageStorageIds?.length ?? 0;
  const metadata: ProviderMetadata = {
    source: "daniel",
    kind: "conversation_turn",
    channel: input.channel ?? "imessage",
    conversationKey: input.identity.conversationKey,
    turnId: input.turnId,
    schemaVersion: 1,
    hasImages: imageCount > 0,
    imageCount,
  };
  return {
    schemaVersion: 1,
    ingestionStrategy: CONVERSATION_INGESTION_STRATEGY,
    providerInput: {
      content: buildRawTurnContent(input),
      containerTag: input.identity.containerTag,
      customId: input.identity.customId,
      taskType: "memory",
      metadata,
    },
  };
}

export function normalizeMemorySyncPayload(payload: unknown): string {
  return stableJson(payload);
}

export function computeMemorySyncPayloadHash(input: {
  kind: MemorySyncJobKind;
  containerTag: string;
  customId?: string;
  turnId?: string;
  normalizedPayload: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.kind}:${input.containerTag}:${input.customId ?? ""}:${input.turnId ?? ""}:${input.normalizedPayload}`,
      "utf8",
    )
    .digest("hex");
}

export async function captureRawTurn(
  input: RawTurnCaptureInput,
  dependencies: RawTurnCaptureDependencies,
): Promise<RawTurnCaptureResult> {
  if (input.kind === "proactive") {
    return { enqueued: false, reason: "synthetic_proactive" };
  }
  const writeMode = dependencies.writeMode ?? readMemoryProviderConfiguration().writeMode;
  if (writeMode === "convex") {
    return { enqueued: false, reason: "write_mode_disabled" };
  }

  const currentSaltFingerprint = memoryIdSaltFingerprint(dependencies.memoryIdSalt);
  const persistedSaltFingerprint = dependencies.identityStateStore
    ? await dependencies.identityStateStore.ensureIdentitySaltFingerprint(
        currentSaltFingerprint,
      )
    : currentSaltFingerprint;
  const identity = deriveMemoryIdentity(
    {
      memoryOwnerId: input.memoryOwnerId,
      conversationId: input.conversationId,
    },
    {
      salt: dependencies.memoryIdSalt,
      expectedSaltFingerprint: persistedSaltFingerprint,
    },
  );
  const payload = buildConversationTurnPayload({
    identity,
    turnId: input.turnId,
    userMessage: input.userMessage,
    assistantReply: input.assistantReply,
    imageStorageIds: input.imageStorageIds,
    channel: input.channel,
  });
  const normalizedPayload = normalizeMemorySyncPayload(payload);
  const payloadHash = computeMemorySyncPayloadHash({
    kind: "conversation_turn",
    containerTag: identity.containerTag,
    customId: identity.customId,
    turnId: input.turnId,
    normalizedPayload,
  });
  const jobId = dependencies.createJobId?.() ?? `memory-sync-${randomUUID()}`;
  const result = await dependencies.jobStore.enqueue({
    jobId,
    kind: "conversation_turn",
    ownerKey: identity.ownerKey,
    containerTag: identity.containerTag,
    customId: identity.customId,
    conversationId: identity.conversationId,
    turnId: input.turnId,
    payload: normalizedPayload,
    payloadHash,
    now: (dependencies.now ?? Date.now)(),
  });

  return {
    enqueued: result.enqueued,
    duplicate: result.duplicate,
    jobId: result.jobId,
    payloadHash,
    identity,
  };
}

/**
 * Explicit/durable image memory is owned by Implementation 6. Normal turn
 * capture never calls this helper; it only records image counts in metadata.
 */
export async function enqueueDurableImageCapture(
  input: {
    identity: MemoryOwnerContext;
    turnId: string;
    imageStorageIds: string[];
    eligibilityToken: string;
  },
  policy: DurableImageCapturePolicy,
): Promise<void> {
  await policy.enqueueEligibleImages(input);
}

const convexJobStore: MemorySyncJobStore = {
  async enqueue(input) {
    const result = await convex.mutation(api.memorySyncJobs.enqueue, input);
    return {
      jobId: result.job.jobId,
      enqueued: result.created,
      duplicate: result.duplicate,
    };
  },
};

const convexIdentityStateStore: MemoryIdentityStateStore = {
  async ensureIdentitySaltFingerprint(saltFingerprint) {
    return await convex.mutation(
      api.memoryProviderState.ensureIdentitySaltFingerprint,
      { saltFingerprint },
    );
  },
};

export function enqueueRawTurnCapture(
  input: RawTurnCaptureInput,
): Promise<RawTurnCaptureResult> {
  return captureRawTurn(input, {
    jobStore: convexJobStore,
    identityStateStore: convexIdentityStateStore,
    // Implementation 8 owns writes unconditionally. Avoid re-reading migration
    // modes here so a malformed legacy flag cannot suppress the durable outbox.
    writeMode: "supermemory",
  });
}
