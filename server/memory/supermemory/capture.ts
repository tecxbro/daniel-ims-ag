import { createHash, randomUUID } from "node:crypto";
import { api } from "../../../convex/_generated/api.js";
import { convex } from "../../convex-client.js";
import { readMemoryProviderConfiguration } from "./client.js";
import {
  deriveMemoryIdentity,
  memoryIdSaltFingerprint,
} from "./identity.js";
import {
  buildConversationTurnJobPayload,
  CONVERSATION_INGESTION_STRATEGY,
  parseMemorySyncJobPayload,
  stableJson,
  type ConversationTurnJobPayload,
  type MemorySyncJobKind,
} from "./job-contract.js";
import type {
  MemoryOwnerContext,
  MemoryWriteMode,
  ProviderMetadata,
} from "./types.js";

export { CONVERSATION_INGESTION_STRATEGY };
export type { ConversationTurnJobPayload, MemorySyncJobKind };

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

export type PrepareRawTurnCaptureDependencies = Omit<
  RawTurnCaptureDependencies,
  "jobStore"
>;

export type PreparedRawTurnCapture =
  | {
      capture: { enqueued: false; reason: "write_mode_disabled" | "synthetic_proactive" };
      job: null;
    }
  | {
      capture: Omit<Extract<RawTurnCaptureResult, { jobId: string }>, "enqueued" | "duplicate">;
      job: EnqueueMemorySyncJobInput;
    };

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
  return buildConversationTurnJobPayload({
      content: buildRawTurnContent(input),
      containerTag: input.identity.containerTag,
      customId: input.identity.customId,
      taskType: "memory",
      metadata,
    });
}

export function normalizeMemorySyncPayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "kind" in payload) {
    const envelope = payload as ConversationTurnJobPayload;
    parseMemorySyncJobPayload(envelope, {
      kind: envelope.kind,
      containerTag: envelope.providerInput.containerTag,
      customId: envelope.providerInput.customId,
    });
  }
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
  const prepared = await prepareRawTurnCapture(input, dependencies);
  if (!prepared.job) return prepared.capture;
  const result = await dependencies.jobStore.enqueue(prepared.job);

  return {
    ...prepared.capture,
    enqueued: result.enqueued,
    duplicate: result.duplicate,
    jobId: result.jobId,
  };
}

export async function prepareRawTurnCapture(
  input: RawTurnCaptureInput,
  dependencies: PrepareRawTurnCaptureDependencies,
): Promise<PreparedRawTurnCapture> {
  if (input.kind === "proactive") {
    return {
      capture: { enqueued: false, reason: "synthetic_proactive" },
      job: null,
    };
  }
  const writeMode = dependencies.writeMode ?? readMemoryProviderConfiguration().writeMode;
  if (writeMode === "convex") {
    return {
      capture: { enqueued: false, reason: "write_mode_disabled" },
      job: null,
    };
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
  const job: EnqueueMemorySyncJobInput = {
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
  };

  return {
    capture: { jobId, payloadHash, identity },
    job,
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
