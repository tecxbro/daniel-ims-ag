import type {
  CaptureTurnInput,
  CreateExactMemoryInput,
  ProviderMetadata,
  UpdateMemoryInput,
} from "./types.js";

export const MEMORY_SYNC_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_INGESTION_STRATEGY = "delta_turn_v1" as const;

export type MemorySyncJobKind =
  | "conversation_turn"
  | "explicit_memory"
  | "image"
  | "memory_update"
  | "memory_forget";

export type DurableImageReason =
  | "explicit_request"
  | "durable_object"
  | "remember_image_tool"
  | "migration";

export interface ImageJobInput {
  containerTag: string;
  storageId: string;
  customId: string;
  reason: DurableImageReason;
  conversationId?: string;
  turnId?: string;
  metadata?: ProviderMetadata;
}

export interface MemoryForgetJobInput {
  containerTag: string;
  ids: string[];
  reason?: string;
}

export interface MemorySyncPayloadByKind {
  conversation_turn: CaptureTurnInput;
  explicit_memory: CreateExactMemoryInput;
  image: ImageJobInput;
  memory_update: UpdateMemoryInput & { id: string };
  memory_forget: MemoryForgetJobInput;
}

export type ConversationTurnJobPayload = {
  schemaVersion: typeof MEMORY_SYNC_SCHEMA_VERSION;
  kind: "conversation_turn";
  ingestionStrategy: typeof CONVERSATION_INGESTION_STRATEGY;
  providerInput: MemorySyncPayloadByKind["conversation_turn"];
};

export type ExplicitMemoryOutboxPayload = {
  schemaVersion: typeof MEMORY_SYNC_SCHEMA_VERSION;
  kind: "explicit_memory";
  providerInput: MemorySyncPayloadByKind["explicit_memory"];
};

export type ImageOutboxPayload = {
  schemaVersion: typeof MEMORY_SYNC_SCHEMA_VERSION;
  kind: "image";
  providerInput: MemorySyncPayloadByKind["image"];
};

export type MemoryUpdateOutboxPayload = {
  schemaVersion: typeof MEMORY_SYNC_SCHEMA_VERSION;
  kind: "memory_update";
  providerInput: MemorySyncPayloadByKind["memory_update"];
};

export type MemoryForgetOutboxPayload = {
  schemaVersion: typeof MEMORY_SYNC_SCHEMA_VERSION;
  kind: "memory_forget";
  providerInput: MemorySyncPayloadByKind["memory_forget"];
};

export type MemorySyncJobPayload =
  | ConversationTurnJobPayload
  | ExplicitMemoryOutboxPayload
  | ImageOutboxPayload
  | MemoryUpdateOutboxPayload
  | MemoryForgetOutboxPayload;

export interface MemorySyncPayloadScope {
  kind: MemorySyncJobKind;
  containerTag: string;
  customId?: string;
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

function requireString(
  value: unknown,
  field: string,
  kind: MemorySyncJobKind,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemorySyncPayloadError(`memory sync ${kind} payload requires ${field}`);
  }
  return value;
}

function validateContainer(
  providerInput: Record<string, unknown>,
  scope: MemorySyncPayloadScope,
): void {
  const containerTag = requireString(providerInput.containerTag, "containerTag", scope.kind);
  if (containerTag !== scope.containerTag) {
    throw new MemorySyncPayloadError(
      `memory sync ${scope.kind} payload containerTag does not match its durable identity`,
    );
  }
}

function validateProviderInput(
  kind: MemorySyncJobKind,
  providerInput: Record<string, unknown>,
  scope: MemorySyncPayloadScope,
): void {
  validateContainer(providerInput, scope);
  switch (kind) {
    case "conversation_turn": {
      requireString(providerInput.content, "content", kind);
      const customId = requireString(providerInput.customId, "customId", kind);
      if (scope.customId !== undefined && customId !== scope.customId) {
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
      return;
    }
    case "explicit_memory": {
      if (!Array.isArray(providerInput.memories) || providerInput.memories.length < 1) {
        throw new MemorySyncPayloadError(
          "memory sync explicit_memory payload requires memories",
        );
      }
      for (const memory of providerInput.memories) {
        const record = asObject(memory);
        requireString(record?.content, "memories[].content", kind);
      }
      return;
    }
    case "image": {
      requireString(providerInput.storageId, "storageId", kind);
      const customId = requireString(providerInput.customId, "customId", kind);
      if (scope.customId !== undefined && customId !== scope.customId) {
        throw new MemorySyncPayloadError(
          "memory sync image payload customId does not match its durable identity",
        );
      }
      if (
        providerInput.reason !== "explicit_request" &&
        providerInput.reason !== "durable_object" &&
        providerInput.reason !== "remember_image_tool" &&
        providerInput.reason !== "migration"
      ) {
        throw new MemorySyncPayloadError("memory sync image payload has an invalid reason");
      }
      return;
    }
    case "memory_update":
      requireString(providerInput.id, "id", kind);
      requireString(providerInput.newContent, "newContent", kind);
      return;
    case "memory_forget": {
      if (!Array.isArray(providerInput.ids) || providerInput.ids.length < 1) {
        throw new MemorySyncPayloadError("memory sync memory_forget payload requires ids");
      }
      const ids = providerInput.ids.map((id) => requireString(id, "ids[]", kind));
      if (new Set(ids).size !== ids.length) {
        throw new MemorySyncPayloadError("memory sync memory_forget payload ids must be unique");
      }
      return;
    }
    default:
      return assertNever(kind);
  }
}

function legacyEnvelope(
  value: Record<string, unknown>,
  scope: MemorySyncPayloadScope,
): MemorySyncJobPayload {
  const providerInput = asObject(value.providerInput) ?? value;
  const normalized = { ...providerInput };
  if (normalized.containerTag === undefined) normalized.containerTag = scope.containerTag;
  if (
    (scope.kind === "conversation_turn" || scope.kind === "image") &&
    normalized.customId === undefined &&
    scope.customId
  ) {
    normalized.customId = scope.customId;
  }
  if (scope.kind === "memory_forget" && !Array.isArray(normalized.ids)) {
    if (typeof normalized.id === "string") normalized.ids = [normalized.id];
  }
  if (scope.kind === "image" && typeof normalized.storageId !== "string") {
    throw new MemorySyncPayloadError(
      "legacy image payload has no storageId and cannot be dispatched safely",
    );
  }
  if (scope.kind === "image" && normalized.reason === undefined) {
    normalized.reason = "migration";
  }
  const base = {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: scope.kind,
    providerInput: normalized,
  } as unknown as MemorySyncJobPayload;
  return scope.kind === "conversation_turn"
    ? ({ ...base, ingestionStrategy: CONVERSATION_INGESTION_STRATEGY } as ConversationTurnJobPayload)
    : base;
}

/**
 * Parses the v1 discriminated contract. The legacy branch exists only for
 * durable rows written before this remediation; every producer now emits v1.
 */
export function parseMemorySyncJobPayload(
  value: unknown,
  scope: MemorySyncPayloadScope,
  options: { allowLegacy?: boolean } = {},
): MemorySyncJobPayload {
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

  let normalized: MemorySyncJobPayload;
  if (
    options.allowLegacy === true &&
    envelope.kind === undefined &&
    (envelope.schemaVersion === undefined || envelope.schemaVersion === MEMORY_SYNC_SCHEMA_VERSION)
  ) {
    normalized = legacyEnvelope(envelope, scope);
  } else {
    if (envelope.schemaVersion !== MEMORY_SYNC_SCHEMA_VERSION) {
      throw new MemorySyncPayloadError(
        `unsupported memory sync payload schemaVersion: ${String(envelope.schemaVersion)}`,
      );
    }
    if (envelope.kind !== scope.kind) {
      throw new MemorySyncPayloadError(
        `memory sync payload kind ${String(envelope.kind)} does not match durable job ${scope.kind}`,
      );
    }
    if (
      scope.kind === "conversation_turn" &&
      envelope.ingestionStrategy !== CONVERSATION_INGESTION_STRATEGY
    ) {
      throw new MemorySyncPayloadError(
        "memory sync conversation_turn payload must use delta_turn_v1",
      );
    }
    normalized = envelope as unknown as MemorySyncJobPayload;
  }

  const providerInput = asObject(normalized.providerInput);
  if (!providerInput) {
    throw new MemorySyncPayloadError(
      `memory sync ${scope.kind} payload requires providerInput`,
    );
  }
  validateProviderInput(scope.kind, providerInput, scope);
  return normalized;
}

export function buildConversationTurnJobPayload(
  providerInput: CaptureTurnInput,
): ConversationTurnJobPayload {
  const payload: ConversationTurnJobPayload = {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: "conversation_turn",
    ingestionStrategy: CONVERSATION_INGESTION_STRATEGY,
    providerInput,
  };
  return parseMemorySyncJobPayload(payload, {
    kind: payload.kind,
    containerTag: providerInput.containerTag,
    customId: providerInput.customId,
  }) as ConversationTurnJobPayload;
}

export function buildExplicitMemoryOutboxPayload(
  providerInput: CreateExactMemoryInput,
): ExplicitMemoryOutboxPayload {
  const payload: ExplicitMemoryOutboxPayload = {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: "explicit_memory",
    providerInput,
  };
  return parseMemorySyncJobPayload(payload, {
    kind: payload.kind,
    containerTag: providerInput.containerTag,
  }) as ExplicitMemoryOutboxPayload;
}

export function buildMemoryUpdateOutboxPayload(input: {
  containerTag: string;
  memoryId: string;
  newContent: string;
  metadata?: ProviderMetadata;
}): MemoryUpdateOutboxPayload {
  const payload: MemoryUpdateOutboxPayload = {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: "memory_update",
    providerInput: {
      containerTag: input.containerTag,
      id: input.memoryId,
      newContent: input.newContent,
      metadata: input.metadata,
    },
  };
  return parseMemorySyncJobPayload(payload, {
    kind: payload.kind,
    containerTag: input.containerTag,
  }) as MemoryUpdateOutboxPayload;
}

export function buildMemoryForgetOutboxPayload(input: {
  containerTag: string;
  providerMemoryIds: string[];
  reason?: string;
}): MemoryForgetOutboxPayload {
  const ids = [...new Set(input.providerMemoryIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length < 1) {
    throw new MemorySyncPayloadError("memory sync memory_forget payload requires ids");
  }
  const payload: MemoryForgetOutboxPayload = {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: "memory_forget",
    providerInput: { containerTag: input.containerTag, ids, reason: input.reason },
  };
  return parseMemorySyncJobPayload(payload, {
    kind: payload.kind,
    containerTag: input.containerTag,
  }) as MemoryForgetOutboxPayload;
}

export function buildImageOutboxPayload(
  providerInput: ImageJobInput,
): ImageOutboxPayload {
  const payload: ImageOutboxPayload = {
    schemaVersion: MEMORY_SYNC_SCHEMA_VERSION,
    kind: "image",
    providerInput,
  };
  return parseMemorySyncJobPayload(payload, {
    kind: payload.kind,
    containerTag: providerInput.containerTag,
    customId: providerInput.customId,
  }) as ImageOutboxPayload;
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

function assertNever(value: never): never {
  throw new MemorySyncPayloadError(`unsupported memory sync job kind: ${String(value)}`);
}
