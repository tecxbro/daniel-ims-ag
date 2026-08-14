import { createHash } from "node:crypto";
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
import type { MemoryOwnerContext, ProviderMetadata } from "./types.js";

export { CONVERSATION_INGESTION_STRATEGY };
export type { ConversationTurnJobPayload, MemorySyncJobKind };

export interface EnqueueMemorySyncJobInput {
  jobId: string;
  kind: MemorySyncJobKind;
  ownerKey: string;
  containerTag: string;
  customId: string;
  conversationId: string;
  turnId: string;
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

export class MemoryIdentityRecoveryRequiredError extends Error {
  constructor() {
    super("memory identity recovery is required");
    this.name = "MemoryIdentityRecoveryRequiredError";
  }
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
      reason: "unconfigured" | "recovery_required" | "synthetic_proactive";
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
  memoryConfigured?: boolean;
  memoryIdSalt?: string;
  now?: () => number;
  createJobId?: () => string;
  /** Recovery finalization may retain a job when only the state read is unavailable. */
  allowUnverifiedIdentityOnStateError?: boolean;
}

export type PrepareRawTurnCaptureDependencies = Omit<
  RawTurnCaptureDependencies,
  "jobStore"
>;

export type PreparedRawTurnCapture =
  | {
      capture: {
        enqueued: false;
        reason: "unconfigured" | "recovery_required" | "synthetic_proactive";
      };
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
  customId: string;
  turnId: string;
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
  const memoryConfigured =
    dependencies.memoryConfigured ?? Boolean(process.env.SUPERMEMORY_API_KEY?.trim());
  if (!memoryConfigured) {
    return {
      capture: { enqueued: false, reason: "unconfigured" },
      job: null,
    };
  }
  let identity: MemoryOwnerContext;
  try {
    const currentSaltFingerprint = memoryIdSaltFingerprint(dependencies.memoryIdSalt);
    let persistedSaltFingerprint = currentSaltFingerprint;
    if (dependencies.identityStateStore) {
      try {
        persistedSaltFingerprint =
          await dependencies.identityStateStore.ensureIdentitySaltFingerprint(
            currentSaltFingerprint,
          );
      } catch (error) {
        if (
          !dependencies.allowUnverifiedIdentityOnStateError ||
          error instanceof MemoryIdentityRecoveryRequiredError
        ) {
          throw error;
        }
        // The assistant + job transaction still validates the server proof.
        // Keeping the deterministic job here lets the recovery journal retain
        // semantic capture intent during a transient Convex outage.
      }
    }
    identity = deriveMemoryIdentity(
      {
        memoryOwnerId: input.memoryOwnerId,
        conversationId: input.conversationId,
      },
      {
        salt: dependencies.memoryIdSalt,
        expectedSaltFingerprint: persistedSaltFingerprint,
      },
    );
  } catch {
    return {
      capture: { enqueued: false, reason: "recovery_required" },
      job: null,
    };
  }
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
  // Stable by normalized payload so a delivered turn finalized twice resolves
  // to the same durable source job instead of creating a conflicting recovery
  // journal record.
  const jobId = dependencies.createJobId?.() ?? `memory-sync-${payloadHash}`;
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
