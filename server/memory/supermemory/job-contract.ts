import type { CaptureTurnInput } from "./types.js";

export const MEMORY_SYNC_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_INGESTION_STRATEGY = "delta_turn_v1" as const;

export type MemorySyncJobKind = "conversation_turn";

export interface MemorySyncPayloadByKind {
  conversation_turn: CaptureTurnInput;
}

export type ConversationTurnJobPayload = {
  schemaVersion: typeof MEMORY_SYNC_SCHEMA_VERSION;
  kind: MemorySyncJobKind;
  ingestionStrategy: typeof CONVERSATION_INGESTION_STRATEGY;
  providerInput: CaptureTurnInput;
};

export type MemorySyncJobPayload = ConversationTurnJobPayload;

export interface MemorySyncPayloadScope {
  kind: MemorySyncJobKind;
  containerTag: string;
  customId: string;
}

export class MemorySyncPayloadError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "MemorySyncPayloadError";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemorySyncPayloadError(
      `memory sync conversation_turn payload requires ${field}`,
    );
  }
  return value;
}

export function parseMemorySyncJobPayload(
  value: unknown,
  scope: MemorySyncPayloadScope,
): ConversationTurnJobPayload {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new MemorySyncPayloadError("memory sync payload contains invalid JSON");
    }
  }
  const envelope = asObject(parsed);
  if (!envelope) throw new MemorySyncPayloadError("memory sync payload must be an object");
  if (envelope.schemaVersion !== MEMORY_SYNC_SCHEMA_VERSION) {
    throw new MemorySyncPayloadError(
      `unsupported memory sync payload schemaVersion: ${String(envelope.schemaVersion)}`,
    );
  }
  if (scope.kind !== "conversation_turn" || envelope.kind !== "conversation_turn") {
    throw new MemorySyncPayloadError(
      `memory sync payload kind ${String(envelope.kind)} does not match durable job ${scope.kind}`,
    );
  }
  if (envelope.ingestionStrategy !== CONVERSATION_INGESTION_STRATEGY) {
    throw new MemorySyncPayloadError(
      "memory sync conversation_turn payload must use delta_turn_v1",
    );
  }
  const providerInput = asObject(envelope.providerInput);
  if (!providerInput) {
    throw new MemorySyncPayloadError(
      "memory sync conversation_turn payload requires providerInput",
    );
  }
  const containerTag = requireString(providerInput.containerTag, "containerTag");
  const customId = requireString(providerInput.customId, "customId");
  requireString(providerInput.content, "content");
  if (containerTag !== scope.containerTag) {
    throw new MemorySyncPayloadError(
      "memory sync conversation_turn payload containerTag does not match its durable identity",
    );
  }
  if (customId !== scope.customId) {
    throw new MemorySyncPayloadError(
      "memory sync conversation_turn payload customId does not match its durable identity",
    );
  }
  if (
    providerInput.taskType !== undefined &&
    providerInput.taskType !== "memory" &&
    providerInput.taskType !== "superrag"
  ) {
    throw new MemorySyncPayloadError(
      "memory sync conversation_turn payload has an invalid taskType",
    );
  }
  return {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: "conversation_turn",
    ingestionStrategy: CONVERSATION_INGESTION_STRATEGY,
    providerInput: providerInput as unknown as CaptureTurnInput,
  };
}

export function buildConversationTurnJobPayload(
  providerInput: CaptureTurnInput,
): ConversationTurnJobPayload {
  return parseMemorySyncJobPayload(
    {
      schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
      kind: "conversation_turn",
      ingestionStrategy: CONVERSATION_INGESTION_STRATEGY,
      providerInput,
    },
    {
      kind: "conversation_turn",
      containerTag: providerInput.containerTag,
      customId: providerInput.customId,
    },
  );
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
