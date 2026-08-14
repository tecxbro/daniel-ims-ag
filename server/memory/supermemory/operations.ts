import { createHash, randomUUID } from "node:crypto";
import {
  memoryPairingAuthorityProof,
  validateProviderIdentifier,
} from "./identity.js";
import type {
  CreateExactMemoryInput,
  ForgetMemoryInput,
  MemorySearchResult,
  ProviderMemoryResult,
  ProviderMetadata,
  SearchInput,
  UpdateMemoryInput,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.supermemory.ai";
const DEFAULT_TIMEOUT_MS = 1_200;
const DEFAULT_RETRIES = 2;
const MAX_FORGET_IDS = 500;
const STATIC_MEMORY_KINDS = new Set<DurableStaticMemoryKind>([
  "preferred_name",
  "core_identity",
  "long_term_role",
  "home_timezone",
]);

export type DurableStaticMemoryKind =
  | "preferred_name"
  | "core_identity"
  | "long_term_role"
  | "home_timezone";

export type DurableImageReason =
  | "explicit_request"
  | "durable_object"
  | "remember_image_tool";

export interface CreatedMemoriesResult {
  documentId: string | null;
  memories: ProviderMemoryResult[];
}

export interface ForgetCandidate {
  id: string;
  memory: string;
  score: number;
}

export interface ForgetMatchingResult {
  dryRun: boolean;
  count: number;
  forgetBatchId: string | null;
  summary: string;
  candidates: ForgetCandidate[];
  forgotten: ForgetCandidate[];
}

export interface UploadedImageResult {
  id: string;
  status: string;
}

export interface ImageBytes {
  bytes: Uint8Array;
  mediaType: string;
}

export class SupermemoryProviderError extends Error {
  readonly operation: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly code: "configuration" | "timeout" | "authentication" | "rate_limit" | "provider";

  constructor(
    message: string,
    options: {
      operation: string;
      status?: number;
      retryable?: boolean;
      code?: SupermemoryProviderError["code"];
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "SupermemoryProviderError";
    this.operation = options.operation;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.code = options.code ?? "provider";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(record: Record<string, unknown>, key: string, operation: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new SupermemoryProviderError(`Supermemory ${operation} returned an invalid ${key}`, {
      operation,
    });
  }
  return value;
}

function mapProviderMemory(value: unknown, operation: string): ProviderMemoryResult {
  const memory = asRecord(value);
  if (!memory) {
    throw new SupermemoryProviderError(`Supermemory ${operation} returned an invalid memory`, {
      operation,
    });
  }
  return {
    id: requiredString(memory, "id", operation),
    content: requiredString(memory, "memory", operation),
    isStatic: typeof memory.isStatic === "boolean" ? memory.isStatic : undefined,
    createdAt: typeof memory.createdAt === "string" ? memory.createdAt : undefined,
    metadata: asRecord(memory.metadata),
    version: typeof memory.version === "number" ? memory.version : undefined,
    parentMemoryId:
      typeof memory.parentMemoryId === "string" || memory.parentMemoryId === null
        ? memory.parentMemoryId
        : undefined,
    rootMemoryId:
      typeof memory.rootMemoryId === "string" || memory.rootMemoryId === null
        ? memory.rootMemoryId
        : undefined,
    forgetAfter:
      typeof memory.forgetAfter === "string" || memory.forgetAfter === null
        ? memory.forgetAfter
        : undefined,
    forgetReason:
      typeof memory.forgetReason === "string" || memory.forgetReason === null
        ? memory.forgetReason
        : undefined,
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function normalizedFetchError(error: unknown, operation: string): SupermemoryProviderError {
  if (error instanceof SupermemoryProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new SupermemoryProviderError(`Supermemory ${operation} timed out`, {
      operation,
      retryable: true,
      code: "timeout",
      cause: error,
    });
  }
  return new SupermemoryProviderError(`Supermemory ${operation} failed`, {
    operation,
    retryable: error instanceof TypeError,
    cause: error,
  });
}

export interface SupermemoryOperationTransportOptions {
  apiKey: string;
  timeoutMs?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  retries?: number;
}

/** Owns every direct call to the v4 memory-operation endpoints. */
export class SupermemoryOperationTransport {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retries: number;

  constructor(options: SupermemoryOperationTransportOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) {
      throw new SupermemoryProviderError("SUPERMEMORY_API_KEY is required", {
        operation: "configuration",
        code: "configuration",
      });
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.retries = options.retries ?? DEFAULT_RETRIES;
  }

  async createExact(input: CreateExactMemoryInput): Promise<CreatedMemoriesResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    if (input.memories.length < 1 || input.memories.length > 100) {
      throw new SupermemoryProviderError("createExact requires between 1 and 100 memories", {
        operation: "createExact",
        code: "configuration",
      });
    }
    for (const memory of input.memories) {
      if (!memory.content.trim() || memory.content.length > 10_000) {
        throw new SupermemoryProviderError(
          "createExact memory content must be between 1 and 10000 characters",
          { operation: "createExact", code: "configuration" },
        );
      }
    }
    const response = asRecord(
      await this.requestJson("POST", "/v4/memories", input, "createExact"),
    );
    if (!response || !Array.isArray(response.memories)) {
      throw new SupermemoryProviderError("Supermemory createExact returned an invalid response", {
        operation: "createExact",
      });
    }
    return {
      documentId: typeof response.documentId === "string" ? response.documentId : null,
      memories: response.memories.map((memory) => mapProviderMemory(memory, "createExact")),
    };
  }

  async updateExact(input: UpdateMemoryInput): Promise<ProviderMemoryResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    if (!input.id || input.content) {
      throw new SupermemoryProviderError("updateExact requires one exact memory id", {
        operation: "updateExact",
        code: "configuration",
      });
    }
    if (!input.newContent.trim()) {
      throw new SupermemoryProviderError("updateExact requires non-empty newContent", {
        operation: "updateExact",
        code: "configuration",
      });
    }
    return mapProviderMemory(
      await this.requestJson("PATCH", "/v4/memories", input, "updateExact"),
      "updateExact",
    );
  }

  async forgetExact(input: ForgetMemoryInput): Promise<{ id: string; forgotten: boolean }> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    if (!input.id || input.content) {
      throw new SupermemoryProviderError("forgetExact requires one exact memory id", {
        operation: "forgetExact",
        code: "configuration",
      });
    }
    const response = asRecord(
      await this.requestJson("DELETE", "/v4/memories", input, "forgetExact"),
    );
    if (!response || response.forgotten !== true) {
      throw new SupermemoryProviderError("Supermemory forgetExact returned an invalid response", {
        operation: "forgetExact",
      });
    }
    return { id: requiredString(response, "id", "forgetExact"), forgotten: true };
  }

  async previewForget(input: {
    containerTag: string;
    query: string;
    threshold?: number;
    maxForget?: number;
    reason?: string;
  }): Promise<ForgetMatchingResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    if (!input.query.trim() || input.query.length > 2_000) {
      throw new SupermemoryProviderError("previewForget query must be between 1 and 2000 characters", {
        operation: "previewForget",
        code: "configuration",
      });
    }
    return this.forgetMatching({ ...input, dryRun: true }, "previewForget");
  }

  async applyExactForget(input: {
    containerTag: string;
    ids: string[];
    reason?: string;
  }): Promise<ForgetMatchingResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    const ids = uniqueIds(input.ids);
    if (ids.length < 1 || ids.length > MAX_FORGET_IDS) {
      throw new SupermemoryProviderError("applyExactForget requires between 1 and 500 exact ids", {
        operation: "applyExactForget",
        code: "configuration",
      });
    }
    return this.forgetMatching(
      { containerTag: input.containerTag, ids, dryRun: false, reason: input.reason },
      "applyExactForget",
    );
  }

  async uploadImage(input: {
    containerTag: string;
    customId: string;
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
    metadata?: ProviderMetadata;
  }): Promise<UploadedImageResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    validateProviderIdentifier(input.customId, "customId");
    if (!input.mediaType.startsWith("image/") || input.bytes.byteLength === 0) {
      throw new SupermemoryProviderError("uploadImage requires non-empty image bytes", {
        operation: "uploadImage",
        code: "configuration",
      });
    }
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(input.bytes)], { type: input.mediaType }), input.filename);
    form.append("containerTag", input.containerTag);
    form.append("customId", input.customId);
    form.append("fileType", "image");
    form.append("mimeType", input.mediaType);
    form.append("taskType", "memory");
    if (input.metadata) form.append("metadata", JSON.stringify(input.metadata));
    const response = asRecord(
      await this.requestForm("POST", "/v3/documents/file", form, "uploadImage"),
    );
    if (!response) {
      throw new SupermemoryProviderError("Supermemory uploadImage returned an invalid response", {
        operation: "uploadImage",
      });
    }
    return {
      id: requiredString(response, "id", "uploadImage"),
      status: requiredString(response, "status", "uploadImage"),
    };
  }

  async deleteDocument(idOrCustomId: string): Promise<void> {
    validateProviderIdentifier(idOrCustomId, "provider document id or customId");
    await this.requestJson(
      "DELETE",
      `/v3/documents/${encodeURIComponent(idOrCustomId)}`,
      undefined,
      "deleteDocument",
    );
  }

  private async forgetMatching(
    body: Record<string, unknown>,
    operation: string,
  ): Promise<ForgetMatchingResult> {
    const response = asRecord(
      await this.requestJson("POST", "/v4/memories/forget-matching", body, operation),
    );
    if (
      !response ||
      typeof response.dryRun !== "boolean" ||
      typeof response.count !== "number" ||
      typeof response.summary !== "string"
    ) {
      throw new SupermemoryProviderError(`Supermemory ${operation} returned an invalid response`, {
        operation,
      });
    }
    return {
      dryRun: response.dryRun,
      count: response.count,
      forgetBatchId:
        typeof response.forgetBatchId === "string" ? response.forgetBatchId : null,
      summary: response.summary,
      candidates: mapForgetCandidates(response.candidates, operation),
      forgotten: mapForgetCandidates(response.forgotten, operation),
    };
  }

  private requestJson(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    operation: string,
  ): Promise<unknown> {
    return this.request(method, path, operation, {
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private requestForm(
    method: "POST",
    path: string,
    body: FormData,
    operation: string,
  ): Promise<unknown> {
    return this.request(method, path, operation, { body });
  }

  private async request(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    operation: string,
    init: Pick<RequestInit, "headers" | "body">,
  ): Promise<unknown> {
    let lastError: SupermemoryProviderError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(init.headers ?? {}),
          },
          body: init.body,
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { details: text };
          }
        }
        if (response.ok) return parsed;
        const details = asRecord(parsed);
        const message =
          typeof details?.details === "string"
            ? details.details
            : typeof details?.error === "string"
              ? details.error
              : `HTTP ${response.status}`;
        lastError = new SupermemoryProviderError(`Supermemory ${operation} failed: ${message}`, {
          operation,
          status: response.status,
          retryable: retryableStatus(response.status),
          code:
            response.status === 401 || response.status === 403
              ? "authentication"
              : response.status === 429
                ? "rate_limit"
                : "provider",
        });
      } catch (error) {
        lastError = normalizedFetchError(error, operation);
      } finally {
        clearTimeout(timer);
      }
      if (!lastError.retryable || attempt === this.retries) throw lastError;
      await this.sleep(100 * 2 ** attempt);
    }
    throw lastError ?? new SupermemoryProviderError(`Supermemory ${operation} failed`, { operation });
  }
}

function mapForgetCandidates(value: unknown, operation: string): ForgetCandidate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SupermemoryProviderError(`Supermemory ${operation} returned invalid candidates`, {
      operation,
    });
  }
  return value.map((candidate) => {
    const record = asRecord(candidate);
    if (!record || typeof record.score !== "number") {
      throw new SupermemoryProviderError(`Supermemory ${operation} returned an invalid candidate`, {
        operation,
      });
    }
    return {
      id: requiredString(record, "id", operation),
      memory: requiredString(record, "memory", operation),
      score: record.score,
    };
  });
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function assertOwnerContainerScope(ownerKey: string, containerTag: string): void {
  validateProviderIdentifier(containerTag, "containerTag");
  if (containerTag !== `daniel-user-${ownerKey}`) {
    throw new Error("containerTag does not match the memory owner");
  }
}

export interface PendingOperation {
  operationId: string;
  ownerKey: string;
  conversationId: string;
  type: "forget" | "update";
  providerMemoryIds: string[];
  preview: string;
  status: "pending" | "confirmed" | "completed" | "cancelled" | "expired";
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
}

export type PendingOperationTransitionResult =
  | { ok: true; operation: PendingOperation }
  | { ok: false; reason: "not_found" | "expired" | "cancelled" | "completed" | "invalid_status" };

export interface PendingOperationStore {
  create(input: Omit<PendingOperation, "status" | "createdAt" | "completedAt"> & { now: number }): Promise<PendingOperation>;
  confirm(input: { operationId: string; ownerKey: string; conversationId: string; now: number }): Promise<PendingOperationTransitionResult>;
  complete(input: { operationId: string; ownerKey: string; conversationId: string; now: number }): Promise<PendingOperationTransitionResult>;
  cancel(input: { operationId: string; ownerKey: string; conversationId: string; now: number }): Promise<PendingOperationTransitionResult>;
  expire(input: { operationId: string; ownerKey: string; conversationId: string; now: number }): Promise<PendingOperationTransitionResult>;
}

export interface ImageAnchor {
  storageId: string;
  ownerKey: string;
  conversationId?: string;
  turnId?: string;
  customId: string;
  providerDocumentId?: string;
  status: "pending" | "active" | "released";
  reason: string;
  createdAt: number;
  releasedAt?: number;
}

export interface ImageAnchorStore {
  createPending(input: Omit<ImageAnchor, "providerDocumentId" | "status" | "createdAt" | "releasedAt">): Promise<ImageAnchor>;
  activate(input: { customId: string; ownerKey: string; providerDocumentId: string }): Promise<ImageAnchor>;
  loadActiveByCustomId(input: { customId: string; ownerKey: string }): Promise<ImageAnchor | null>;
  releaseAfterProviderDeletion(input: {
    customId: string;
    ownerKey: string;
    providerDocumentId: string;
    providerDeletionConfirmed: true;
    now: number;
  }): Promise<ImageAnchor>;
}

export interface MemoryOperationProvider {
  search(input: SearchInput): Promise<MemorySearchResult[]>;
  createExact(input: CreateExactMemoryInput): Promise<CreatedMemoriesResult>;
  updateExact(input: UpdateMemoryInput): Promise<ProviderMemoryResult>;
  forgetExact(input: ForgetMemoryInput): Promise<{ id: string; forgotten: boolean }>;
  previewForget(input: {
    containerTag: string;
    query: string;
    threshold?: number;
    maxForget?: number;
    reason?: string;
  }): Promise<ForgetMatchingResult>;
  applyExactForget(input: {
    containerTag: string;
    ids: string[];
    reason?: string;
  }): Promise<ForgetMatchingResult>;
  uploadImage(input: {
    containerTag: string;
    customId: string;
    bytes: Uint8Array;
    mediaType: string;
    filename: string;
    metadata?: ProviderMetadata;
  }): Promise<UploadedImageResult>;
  deleteDocument(idOrCustomId: string): Promise<void>;
}

export interface MemoryOperationDependencies {
  provider: MemoryOperationProvider;
  pendingOperations: PendingOperationStore;
  imageAnchors: ImageAnchorStore;
  fetchImageBytes: (storageId: string) => Promise<ImageBytes>;
  now?: () => number;
  createOperationId?: () => string;
  log?: Pick<Console, "info">;
}

export interface CreateExactMemoryOperationInput {
  ownerKey: string;
  containerTag: string;
  conversationKey: string;
  turnId: string;
  content: string;
  staticKind?: DurableStaticMemoryKind;
}

export async function createExactMemory(
  input: CreateExactMemoryOperationInput,
  dependencies: MemoryOperationDependencies,
): Promise<CreatedMemoriesResult & { isStatic: boolean }> {
  assertOwnerContainerScope(input.ownerKey, input.containerTag);
  const content = input.content.trim();
  if (!content) throw new Error("Explicit memory content must not be empty");
  const isStatic = input.staticKind !== undefined && STATIC_MEMORY_KINDS.has(input.staticKind);
  const providerInput: CreateExactMemoryInput = {
    containerTag: input.containerTag,
    memories: [
      {
        content,
        isStatic,
        metadata: {
          source: "daniel_explicit",
          conversationKey: input.conversationKey,
          turnId: input.turnId,
          schemaVersion: 1,
        },
      },
    ],
  };
  const created = await dependencies.provider.createExact(providerInput);
  return {
    ...created,
    isStatic,
  };
}

export async function searchMemoryCandidatesForUpdate(
  input: { ownerKey: string; containerTag: string; query: string; limit?: number },
  dependencies: MemoryOperationDependencies,
): Promise<MemorySearchResult[]> {
  assertOwnerContainerScope(input.ownerKey, input.containerTag);
  const results = await dependencies.provider.search({
    containerTag: input.containerTag,
    q: input.query,
    limit: input.limit ?? 8,
    searchMode: "memories",
  });
  return results.filter((result) => result.kind === "memory");
}

export async function updateExactMemory(
  input: {
    ownerKey: string;
    containerTag: string;
    memoryId: string;
    newContent: string;
    metadata?: ProviderMetadata;
  },
  dependencies: MemoryOperationDependencies,
): Promise<{
  oldMemoryId: string;
  newMemoryId: string;
  version?: number;
  parentMemoryId?: string | null;
  rootMemoryId?: string | null;
  oldIsLatest: false;
  newIsLatest: true;
  confirmation: string;
}> {
  assertOwnerContainerScope(input.ownerKey, input.containerTag);
  const updated = await dependencies.provider.updateExact({
    containerTag: input.containerTag,
    id: input.memoryId,
    newContent: input.newContent,
    metadata: input.metadata,
  });
  (dependencies.log ?? console).info(
    `[supermemory] versioned update old=${input.memoryId} new=${updated.id} version=${updated.version ?? "unknown"}`,
  );
  return {
    oldMemoryId: input.memoryId,
    newMemoryId: updated.id,
    version: updated.version,
    parentMemoryId: updated.parentMemoryId,
    rootMemoryId: updated.rootMemoryId,
    oldIsLatest: false,
    newIsLatest: true,
    confirmation: `Updated memory ${input.memoryId} as version ${updated.version ?? "new"} (${updated.id}).`,
  };
}

export interface ForgetPreview {
  operationId: string | null;
  preview: string;
  candidates: ForgetCandidate[];
  expiresAt: number | null;
}

export async function previewForget(
  input: {
    ownerKey: string;
    conversationId: string;
    containerTag: string;
    query: string;
    reason?: string;
    threshold?: number;
    maxForget?: number;
    expiresInMs?: number;
  },
  dependencies: MemoryOperationDependencies,
): Promise<ForgetPreview> {
  assertOwnerContainerScope(input.ownerKey, input.containerTag);
  const result = await dependencies.provider.previewForget({
    containerTag: input.containerTag,
    query: input.query,
    reason: input.reason,
    threshold: input.threshold,
    maxForget: input.maxForget,
  });
  const candidates = result.candidates;
  if (candidates.length === 0) {
    return { operationId: null, preview: "No matching memories found.", candidates: [], expiresAt: null };
  }
  const now = (dependencies.now ?? Date.now)();
  const operationId = dependencies.createOperationId?.() ?? `memory-op-${randomUUID()}`;
  const expiresAt = now + (input.expiresInMs ?? 15 * 60 * 1_000);
  const preview = conciseForgetPreview(candidates);
  await dependencies.pendingOperations.create({
    operationId,
    ownerKey: input.ownerKey,
    conversationId: input.conversationId,
    type: "forget",
    providerMemoryIds: candidates.map((candidate) => candidate.id),
    preview,
    expiresAt,
    now,
  });
  return { operationId, preview, candidates, expiresAt };
}

export async function applyExactForget(
  input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    containerTag: string;
    reason?: string;
  },
  dependencies: MemoryOperationDependencies,
): Promise<{
  operationId: string;
  forgottenIds: string[];
  confirmation: string;
}> {
  assertOwnerContainerScope(input.ownerKey, input.containerTag);
  const now = (dependencies.now ?? Date.now)();
  const confirmed = await dependencies.pendingOperations.confirm({
    operationId: input.operationId,
    ownerKey: input.ownerKey,
    conversationId: input.conversationId,
    now,
  });
  if (!confirmed.ok) throw new Error(`Pending memory operation unavailable: ${confirmed.reason}`);
  if (confirmed.operation.type !== "forget") throw new Error("Pending operation is not a forget operation");
  const expectedIds = uniqueIds(confirmed.operation.providerMemoryIds);
  const result = await dependencies.provider.applyExactForget({
    containerTag: input.containerTag,
    ids: expectedIds,
    reason: input.reason,
  });
  const forgottenIds = uniqueIds(result.forgotten.map((memory) => memory.id));
  if (forgottenIds.length !== expectedIds.length || expectedIds.some((id) => !forgottenIds.includes(id))) {
    throw new SupermemoryProviderError("Supermemory forgot a different set of memories than confirmed", {
      operation: "applyExactForget",
    });
  }
  const completed = await dependencies.pendingOperations.complete({
    operationId: input.operationId,
    ownerKey: input.ownerKey,
    conversationId: input.conversationId,
    now: (dependencies.now ?? Date.now)(),
  });
  if (!completed.ok) throw new Error(`Could not complete pending operation: ${completed.reason}`);
  return {
    operationId: input.operationId,
    forgottenIds,
    confirmation: `Forgot ${forgottenIds.length} confirmed ${forgottenIds.length === 1 ? "memory" : "memories"}.`,
  };
}

export function shouldRememberImageDurably(input: {
  explicitRequest?: boolean;
  durableObject?: "pet" | "home" | "vehicle" | "project" | "document" | "person" | "design_reference";
  rememberImageToolCalled?: boolean;
}): boolean {
  return input.explicitRequest === true || input.durableObject !== undefined || input.rememberImageToolCalled === true;
}

export function stableImageCustomId(ownerKey: string, storageId: string): string {
  const digest = createHash("sha256").update(`${ownerKey}:${storageId}`, "utf8").digest("hex").slice(0, 32);
  return validateProviderIdentifier(`daniel-image-${digest}`, "image customId");
}

export async function rememberDurableImage(
  input: {
    ownerKey: string;
    containerTag: string;
    storageId: string;
    conversationId?: string;
    turnId?: string;
    reason: DurableImageReason;
    customId?: string;
  },
  dependencies: MemoryOperationDependencies,
): Promise<{
  anchor: ImageAnchor;
  providerDocumentId: string;
}> {
  assertOwnerContainerScope(input.ownerKey, input.containerTag);
  const customId = input.customId ?? stableImageCustomId(input.ownerKey, input.storageId);
  validateProviderIdentifier(customId, "image customId");
  const pending = await dependencies.imageAnchors.createPending({
    storageId: input.storageId,
    ownerKey: input.ownerKey,
    conversationId: input.conversationId,
    turnId: input.turnId,
    customId,
    reason: input.reason,
  });
  if (pending.status === "active") {
    if (!pending.providerDocumentId) throw new Error("Active image anchor is missing providerDocumentId");
    return {
      anchor: pending,
      providerDocumentId: pending.providerDocumentId,
    };
  }
  const image = await dependencies.fetchImageBytes(input.storageId);
  const extension = image.mediaType.split("/")[1]?.replace("jpeg", "jpg") || "img";
  const uploaded = await dependencies.provider.uploadImage({
    containerTag: input.containerTag,
    customId,
    bytes: image.bytes,
    mediaType: image.mediaType,
    filename: `${customId}.${extension}`,
    metadata: {
      source: "daniel_durable_image",
      reason: input.reason,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      schemaVersion: 1,
    },
  });
  const anchor = await dependencies.imageAnchors.activate({
    customId,
    ownerKey: input.ownerKey,
    providerDocumentId: uploaded.id,
  });
  return {
    anchor,
    providerDocumentId: uploaded.id,
  };
}

export async function forgetDurableImageSource(
  input: { ownerKey: string; customId: string },
  dependencies: MemoryOperationDependencies,
): Promise<{ customId: string; released: true }> {
  const anchor = await dependencies.imageAnchors.loadActiveByCustomId(input);
  if (!anchor?.providerDocumentId) throw new Error("Active durable image source not found");
  await dependencies.provider.deleteDocument(anchor.providerDocumentId);
  await dependencies.imageAnchors.releaseAfterProviderDeletion({
    customId: anchor.customId,
    ownerKey: input.ownerKey,
    providerDocumentId: anchor.providerDocumentId,
    providerDeletionConfirmed: true,
    now: (dependencies.now ?? Date.now)(),
  });
  return { customId: anchor.customId, released: true };
}

export function cancelPendingOperation(
  input: { operationId: string; ownerKey: string; conversationId: string },
  dependencies: MemoryOperationDependencies,
): Promise<PendingOperationTransitionResult> {
  return dependencies.pendingOperations.cancel({
    ...input,
    now: (dependencies.now ?? Date.now)(),
  });
}

export function expirePendingOperation(
  input: { operationId: string; ownerKey: string; conversationId: string },
  dependencies: MemoryOperationDependencies,
): Promise<PendingOperationTransitionResult> {
  return dependencies.pendingOperations.expire({
    ...input,
    now: (dependencies.now ?? Date.now)(),
  });
}

function conciseForgetPreview(candidates: ForgetCandidate[]): string {
  const lines = candidates.slice(0, 10).map((candidate, index) => {
    const memory = candidate.memory.replace(/\s+/g, " ").trim();
    return `${index + 1}. ${memory.length > 120 ? `${memory.slice(0, 117)}...` : memory}`;
  });
  if (candidates.length > lines.length) lines.push(`...and ${candidates.length - lines.length} more.`);
  return `Confirm forgetting these ${candidates.length} memories:\n${lines.join("\n")}`;
}

export function createMemoryOperationProvider(input: {
  transport: SupermemoryOperationTransport;
  search: (input: SearchInput) => Promise<MemorySearchResult[]>;
}): MemoryOperationProvider {
  return {
    search: input.search,
    createExact: (request) => input.transport.createExact(request),
    updateExact: (request) => input.transport.updateExact(request),
    forgetExact: (request) => input.transport.forgetExact(request),
    previewForget: (request) => input.transport.previewForget(request),
    applyExactForget: (request) => input.transport.applyExactForget(request),
    uploadImage: (request) => input.transport.uploadImage(request),
    deleteDocument: (idOrCustomId) => input.transport.deleteDocument(idOrCustomId),
  };
}

/** Convex adapters are loaded lazily so the provider transport remains server-only and independently testable. */
export function createConvexPendingOperationStore(): PendingOperationStore {
  return {
    async create(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryPendingOperations.createPending, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as PendingOperation;
    },
    async confirm(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryPendingOperations.confirm, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as PendingOperationTransitionResult;
    },
    async complete(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryPendingOperations.complete, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as PendingOperationTransitionResult;
    },
    async cancel(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryPendingOperations.cancel, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as PendingOperationTransitionResult;
    },
    async expire(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryPendingOperations.expire, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as PendingOperationTransitionResult;
    },
  };
}

export function createConvexImageAnchorStore(): ImageAnchorStore {
  return {
    async createPending(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryImageAnchors.createPending, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as ImageAnchor;
    },
    async activate(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(api.memoryImageAnchors.activate, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as ImageAnchor;
    },
    async loadActiveByCustomId(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.query(api.memoryImageAnchors.loadActiveByCustomId, {
        ...input,
        pairingAuthorityProof: memoryPairingAuthorityProof(),
      } as never)) as ImageAnchor | null;
    },
    async releaseAfterProviderDeletion(input) {
      const [{ convex }, { api }] = await Promise.all([
        import("../../convex-client.js"),
        import("../../../convex/_generated/api.js"),
      ]);
      return (await convex.mutation(
        api.memoryImageAnchors.releaseAfterProviderDeletion,
        {
          ...input,
          pairingAuthorityProof: memoryPairingAuthorityProof(),
        } as never,
      )) as ImageAnchor;
    },
  };
}

export async function fetchConvexImageBytes(storageId: string): Promise<ImageBytes> {
  const { fetchStoredBytes } = await import("../../images/content-blocks.js");
  return await fetchStoredBytes(storageId);
}
