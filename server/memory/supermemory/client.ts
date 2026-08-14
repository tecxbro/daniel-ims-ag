import Supermemory, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  type ClientOptions,
} from "supermemory";
import { validateProviderIdentifier } from "./identity.js";
import {
  SupermemoryOperationTransport,
  SupermemoryProviderError,
} from "./operations.js";
export { SupermemoryProviderError } from "./operations.js";
import type {
  CaptureTurnInput,
  CreateExactMemoryInput,
  DanielMemoryProvider,
  ForgetMemoryInput,
  MemoryHydrationResult,
  MemoryProviderConfiguration,
  MemorySearchResult,
  MemoryVersionHistoryItem,
  ListDocumentsInput,
  ListMemoryEntriesInput,
  ProfileInput,
  ProviderDocumentPage,
  ProviderDocumentResult,
  ProviderMemoryEntry,
  ProviderMemoryEntryPage,
  ProviderMemoryResult,
  SearchInput,
  UpdateMemoryInput,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.supermemory.ai";
const DEFAULT_TIMEOUT_MS = 1_200;
const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_SEARCH_LIMIT = 8;
// Durable outbox attempts own write retries and their exact backoff schedule.
// Retrying inside the SDK would create untracked provider calls per attempt.
const OUTBOX_WRITE_RETRIES = 0;
const USER_PATH_RETRIES = 0;

type Environment = Record<string, string | undefined>;

interface SdkAddResponse {
  id: string;
  status: string;
}

interface SdkProfileResponse {
  profile: { static: string[]; dynamic: string[] };
  searchResults?: { results: unknown[]; total: number; timing: number };
}

interface SdkSearchResponse {
  results: unknown[];
  total: number;
  timing: number;
}

interface SdkDocumentListResponse {
  memories: Array<{
    id: string;
    status: string;
    customId?: string | null;
    title?: string | null;
    summary?: string | null;
    type?: string;
    metadata?: unknown;
    createdAt?: string;
    updatedAt?: string;
  }>;
  pagination: {
    currentPage: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface SupermemorySdkClient {
  add(input: CaptureTurnInput, options?: { timeout?: number; maxRetries?: number }): PromiseLike<SdkAddResponse>;
  profile(input: ProfileInput, options?: { timeout?: number; maxRetries?: number }): PromiseLike<SdkProfileResponse>;
  search(input: SearchInput, options?: { timeout?: number; maxRetries?: number }): PromiseLike<SdkSearchResponse>;
  documents?: {
    list(
      input: {
        containerTags: string[];
        page: number;
        limit: number;
        order: "desc";
        sort: "updatedAt";
        includeContent: false;
      },
      options?: { timeout?: number; maxRetries?: number },
    ): PromiseLike<SdkDocumentListResponse>;
  };
}

export type SupermemorySdkFactory = (options: ClientOptions) => SupermemorySdkClient;

export interface ContainerTagSettings {
  containerTag: string;
  name: string | null;
  entityContext: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SupermemoryContainerSettingsClient {
  getContainerSettings(containerTag: string): Promise<ContainerTagSettings | null>;
  updateContainerSettings(containerTag: string, entityContext: string): Promise<ContainerTagSettings>;
}

export interface SupermemoryAdapterOptions {
  apiKey: string;
  timeoutMs?: number;
  defaultThreshold?: number;
  defaultSearchLimit?: number;
  baseUrl?: string;
  sdkFactory?: SupermemorySdkFactory;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function parseNumber(
  env: Environment,
  key: string,
  fallback: number,
  validate: (value: number) => boolean,
  description: string,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !validate(value)) {
    throw new SupermemoryProviderError(`${key} must be ${description}`, {
      operation: "configuration",
      code: "configuration",
    });
  }
  return value;
}

export function readMemoryProviderConfiguration(
  env: Environment = process.env,
): MemoryProviderConfiguration {
  return {
    timeoutMs: parseNumber(
      env,
      "DANIEL_SUPERMEMORY_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      (value) => Number.isInteger(value) && value > 0,
      "a positive integer",
    ),
    threshold: parseNumber(
      env,
      "DANIEL_SUPERMEMORY_THRESHOLD",
      DEFAULT_THRESHOLD,
      (value) => value >= 0 && value <= 1,
      "between 0 and 1",
    ),
    searchLimit: parseNumber(
      env,
      "DANIEL_SUPERMEMORY_SEARCH_LIMIT",
      DEFAULT_SEARCH_LIMIT,
      (value) => Number.isInteger(value) && value >= 1 && value <= 100,
      "an integer between 1 and 100",
    ),
    dreaming: env.DANIEL_SUPERMEMORY_DREAMING?.trim() || "dynamic",
    apiKeyConfigured: Boolean(env.SUPERMEMORY_API_KEY?.trim()),
  };
}

export function shouldInitializeSupermemoryClient(
  config: Pick<MemoryProviderConfiguration, "apiKeyConfigured">,
): boolean {
  return config.apiKeyConfigured;
}

function assertServerRuntime(): void {
  if (typeof window !== "undefined") {
    throw new SupermemoryProviderError("Supermemory client initialization is server-only", {
      operation: "configuration",
      code: "configuration",
    });
  }
}

function normalizeProviderError(error: unknown, operation: string): SupermemoryProviderError {
  if (error instanceof SupermemoryProviderError) return error;
  if (error instanceof APIConnectionTimeoutError || (error instanceof Error && error.name === "AbortError")) {
    return new SupermemoryProviderError(`Supermemory ${operation} timed out`, {
      operation,
      retryable: true,
      code: "timeout",
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new SupermemoryProviderError(`Supermemory ${operation} connection failed`, {
      operation,
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    const status = error.status;
    const authentication = status === 401 || status === 403;
    const rateLimited = status === 429;
    return new SupermemoryProviderError(`Supermemory ${operation} failed${status ? ` (${status})` : ""}`, {
      operation,
      status,
      retryable: rateLimited || (typeof status === "number" && status >= 500),
      code: authentication ? "authentication" : rateLimited ? "rate_limit" : "provider",
      cause: error,
    });
  }
  return new SupermemoryProviderError(`Supermemory ${operation} failed`, {
    operation,
    retryable: error instanceof TypeError,
    cause: error,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapSearchResult(value: unknown): MemorySearchResult | null {
  const result = asRecord(value);
  if (!result || typeof result.id !== "string" || typeof result.similarity !== "number") return null;
  const memory = typeof result.memory === "string" ? result.memory : undefined;
  const chunk = typeof result.chunk === "string" ? result.chunk : undefined;
  const content = memory ?? chunk;
  if (!content) return null;
  return {
    id: result.id,
    content,
    kind: memory ? "memory" : "chunk",
    similarity: result.similarity,
    metadata: asRecord(result.metadata),
    updatedAt: typeof result.updatedAt === "string" ? result.updatedAt : undefined,
    version: typeof result.version === "number" || result.version === null ? result.version : undefined,
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapMemoryHistoryItem(value: unknown): MemoryVersionHistoryItem | null {
  const item = asRecord(value);
  if (
    !item ||
    typeof item.id !== "string" ||
    typeof item.memory !== "string" ||
    typeof item.version !== "number" ||
    typeof item.isLatest !== "boolean" ||
    typeof item.isForgotten !== "boolean"
  ) {
    return null;
  }
  return {
    id: item.id,
    content: item.memory,
    version: item.version,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
    parentMemoryId: nullableString(item.parentMemoryId),
    rootMemoryId: nullableString(item.rootMemoryId),
    isLatest: item.isLatest,
    isForgotten: item.isForgotten,
  };
}

function mapMemoryEntry(value: unknown): ProviderMemoryEntry | null {
  const entry = asRecord(value);
  const base = mapMemoryHistoryItem(value);
  if (!entry || !base) return null;
  return {
    ...base,
    isStatic: entry.isStatic === true,
    isInference: entry.isInference === true,
    sourceCount:
      typeof entry.sourceCount === "number" && Number.isFinite(entry.sourceCount)
        ? Math.max(0, Math.floor(entry.sourceCount))
        : 0,
    forgetAfter: nullableString(entry.forgetAfter),
    forgetReason: nullableString(entry.forgetReason),
    metadata: asRecord(entry.metadata),
    history: Array.isArray(entry.history)
      ? entry.history
          .map(mapMemoryHistoryItem)
          .filter((item): item is MemoryVersionHistoryItem => item !== null)
      : [],
    documentIds: Array.isArray(entry.documentIds)
      ? entry.documentIds.filter((id): id is string => typeof id === "string")
      : [],
  };
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

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class SupermemoryAdapter
  implements DanielMemoryProvider, SupermemoryContainerSettingsClient
{
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly defaultThreshold: number;
  private readonly defaultSearchLimit: number;
  private readonly baseUrl: string;
  private readonly sdk: SupermemorySdkClient;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly operationTransport: SupermemoryOperationTransport;

  constructor(options: SupermemoryAdapterOptions) {
    assertServerRuntime();
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new SupermemoryProviderError("SUPERMEMORY_API_KEY is required when Supermemory is enabled", {
        operation: "configuration",
        code: "configuration",
      });
    }
    this.apiKey = apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultThreshold = options.defaultThreshold ?? DEFAULT_THRESHOLD;
    this.defaultSearchLimit = options.defaultSearchLimit ?? DEFAULT_SEARCH_LIMIT;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.operationTransport = new SupermemoryOperationTransport({
      apiKey,
      timeoutMs: this.timeoutMs,
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      retries: USER_PATH_RETRIES,
    });
    const sdkFactory = options.sdkFactory ?? ((clientOptions) => new Supermemory(clientOptions));
    this.sdk = sdkFactory({
      apiKey,
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      maxRetries: USER_PATH_RETRIES,
    });
  }

  async add(input: CaptureTurnInput): Promise<ProviderDocumentResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    validateProviderIdentifier(input.customId, "customId");
    try {
      return await this.sdk.add(input, {
        timeout: this.timeoutMs,
        maxRetries: OUTBOX_WRITE_RETRIES,
      });
    } catch (error) {
      throw normalizeProviderError(error, "add");
    }
  }

  captureTurn(input: CaptureTurnInput): Promise<ProviderDocumentResult> {
    return this.add(input);
  }

  async profile(input: ProfileInput): Promise<MemoryHydrationResult> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    const startedAt = Date.now();
    try {
      const response = await this.sdk.profile(
        { ...input, threshold: input.threshold ?? this.defaultThreshold },
        {
          timeout: this.timeoutMs,
          maxRetries: USER_PATH_RETRIES,
        },
      );
      return {
        provider: "supermemory",
        profile: {
          static: Array.isArray(response.profile.static) ? response.profile.static : [],
          dynamic: Array.isArray(response.profile.dynamic) ? response.profile.dynamic : [],
        },
        results: (response.searchResults?.results ?? [])
          .map(mapSearchResult)
          .filter((result): result is MemorySearchResult => result !== null),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw normalizeProviderError(error, "profile");
    }
  }

  async search(input: SearchInput): Promise<MemorySearchResult[]> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    try {
      const response = await this.sdk.search(
        {
          ...input,
          threshold: input.threshold ?? this.defaultThreshold,
          limit: input.limit ?? this.defaultSearchLimit,
          searchMode: input.searchMode ?? "memories",
        },
        {
          timeout: this.timeoutMs,
          maxRetries: USER_PATH_RETRIES,
        },
      );
      return response.results
        .map(mapSearchResult)
        .filter((result): result is MemorySearchResult => result !== null);
    } catch (error) {
      throw normalizeProviderError(error, "search");
    }
  }

  async listDocuments(input: ListDocumentsInput): Promise<ProviderDocumentPage> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    if (!Number.isInteger(page) || page < 1) {
      throw new SupermemoryProviderError("document page must be a positive integer", {
        operation: "listDocuments",
        code: "configuration",
      });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SupermemoryProviderError("document limit must be between 1 and 100", {
        operation: "listDocuments",
        code: "configuration",
      });
    }
    if (!this.sdk.documents) {
      throw new SupermemoryProviderError(
        "The configured Supermemory SDK does not support document listing",
        { operation: "listDocuments", code: "configuration" },
      );
    }
    try {
      const response = await this.sdk.documents.list(
        {
          containerTags: [input.containerTag],
          page,
          limit,
          order: "desc",
          sort: "updatedAt",
          includeContent: false,
        },
        { timeout: this.timeoutMs, maxRetries: USER_PATH_RETRIES },
      );
      const pagination = asRecord(response.pagination);
      return {
        documents: (Array.isArray(response.memories) ? response.memories : []).flatMap(
          (document) => {
            if (
              typeof document?.id !== "string" ||
              typeof document.status !== "string"
            ) {
              return [];
            }
            return [
              {
                id: document.id,
                status: document.status,
                customId:
                  typeof document.customId === "string" || document.customId === null
                    ? document.customId
                    : undefined,
                title:
                  typeof document.title === "string" || document.title === null
                    ? document.title
                    : undefined,
                summary:
                  typeof document.summary === "string" || document.summary === null
                    ? document.summary
                    : undefined,
                type: typeof document.type === "string" ? document.type : undefined,
                metadata: asRecord(document.metadata),
                createdAt:
                  typeof document.createdAt === "string" ? document.createdAt : undefined,
                updatedAt:
                  typeof document.updatedAt === "string" ? document.updatedAt : undefined,
              },
            ];
          },
        ),
        page:
          typeof pagination?.currentPage === "number"
            ? pagination.currentPage
            : page,
        totalItems:
          typeof pagination?.totalItems === "number" ? pagination.totalItems : 0,
        totalPages:
          typeof pagination?.totalPages === "number" ? pagination.totalPages : 0,
      };
    } catch (error) {
      throw normalizeProviderError(error, "listDocuments");
    }
  }

  async listMemories(input: ListMemoryEntriesInput): Promise<ProviderMemoryEntryPage> {
    validateProviderIdentifier(input.containerTag, "containerTag");
    const page = input.page ?? 1;
    const limit = input.limit ?? 20;
    const order = input.order ?? "desc";
    const sort = input.sort ?? "updatedAt";
    if (!Number.isInteger(page) || page < 1) {
      throw new SupermemoryProviderError("memory entry page must be a positive integer", {
        operation: "listMemories",
        code: "configuration",
      });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new SupermemoryProviderError("memory entry limit must be between 1 and 100", {
        operation: "listMemories",
        code: "configuration",
      });
    }
    const response = asRecord(
      await this.requestJson(
        "POST",
        "/v4/memories/list",
        { containerTags: [input.containerTag], page, limit, order, sort },
        "listMemories",
      ),
    );
    const pagination = asRecord(response?.pagination);
    if (!response || !Array.isArray(response.memoryEntries) || !pagination) {
      throw new SupermemoryProviderError(
        "Supermemory listMemories returned an invalid response",
        { operation: "listMemories" },
      );
    }
    return {
      entries: response.memoryEntries
        .map(mapMemoryEntry)
        .filter((entry): entry is ProviderMemoryEntry => entry !== null),
      page:
        typeof pagination.currentPage === "number" ? pagination.currentPage : page,
      limit: typeof pagination.limit === "number" ? pagination.limit : limit,
      totalItems:
        typeof pagination.totalItems === "number" ? pagination.totalItems : 0,
      totalPages:
        typeof pagination.totalPages === "number" ? pagination.totalPages : 0,
    };
  }

  async createExact(input: CreateExactMemoryInput): Promise<ProviderMemoryResult[]> {
    return (await this.operationTransport.createExact(input)).memories;
  }

  async update(input: UpdateMemoryInput): Promise<ProviderMemoryResult> {
    return await this.operationTransport.updateExact(input);
  }

  async forget(input: ForgetMemoryInput): Promise<void> {
    await this.operationTransport.forgetExact(input);
  }

  async getContainerSettings(containerTag: string): Promise<ContainerTagSettings | null> {
    validateProviderIdentifier(containerTag, "containerTag");
    try {
      const response = await this.requestJson(
        "GET",
        `/v3/container-tags/${encodeURIComponent(containerTag)}`,
        undefined,
        "getContainerSettings",
      );
      return this.mapContainerSettings(response, "getContainerSettings");
    } catch (error) {
      const normalized = normalizeProviderError(error, "getContainerSettings");
      if (normalized.status === 404) return null;
      throw normalized;
    }
  }

  async updateContainerSettings(
    containerTag: string,
    entityContext: string,
  ): Promise<ContainerTagSettings> {
    validateProviderIdentifier(containerTag, "containerTag");
    if (!entityContext || entityContext.length > 1_500) {
      throw new SupermemoryProviderError("entityContext must be between 1 and 1500 characters", {
        operation: "updateContainerSettings",
        code: "configuration",
      });
    }
    const response = await this.requestJson(
      "PATCH",
      `/v3/container-tags/${encodeURIComponent(containerTag)}`,
      { entityContext },
      "updateContainerSettings",
    );
    return this.mapContainerSettings(response, "updateContainerSettings");
  }

  private mapContainerSettings(value: unknown, operation: string): ContainerTagSettings {
    const settings = asRecord(value);
    if (!settings) {
      throw new SupermemoryProviderError(`Supermemory ${operation} returned an invalid response`, {
        operation,
      });
    }
    return {
      containerTag: requiredString(settings, "containerTag", operation),
      name: typeof settings.name === "string" || settings.name === null ? settings.name : null,
      entityContext:
        typeof settings.entityContext === "string" || settings.entityContext === null
          ? settings.entityContext
          : null,
      createdAt: typeof settings.createdAt === "string" ? settings.createdAt : undefined,
      updatedAt: typeof settings.updatedAt === "string" ? settings.updatedAt : undefined,
    };
  }

  private async requestJson(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    operation: string,
  ): Promise<unknown> {
    let lastError: SupermemoryProviderError | undefined;
    for (let attempt = 0; attempt <= OUTBOX_WRITE_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
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
        lastError = normalizeProviderError(error, operation);
      } finally {
        clearTimeout(timer);
      }

      if (!lastError.retryable || attempt === OUTBOX_WRITE_RETRIES) throw lastError;
      await this.sleep(100 * 2 ** attempt);
    }
    throw lastError ?? new SupermemoryProviderError(`Supermemory ${operation} failed`, { operation });
  }
}

export function createSupermemoryAdapter(options: SupermemoryAdapterOptions): SupermemoryAdapter {
  return new SupermemoryAdapter(options);
}

export interface CreateConfiguredProviderOptions {
  env?: Environment;
  sdkFactory?: SupermemorySdkFactory;
  fetchImpl?: typeof fetch;
}

export function createConfiguredSupermemoryProvider(
  options: CreateConfiguredProviderOptions = {},
): SupermemoryAdapter | null {
  const env = options.env ?? process.env;
  const config = readMemoryProviderConfiguration(env);
  if (!shouldInitializeSupermemoryClient(config)) return null;
  const apiKey = env.SUPERMEMORY_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  return createSupermemoryAdapter({
    apiKey,
    timeoutMs: config.timeoutMs,
    defaultThreshold: config.threshold,
    defaultSearchLimit: config.searchLimit,
    sdkFactory: options.sdkFactory,
    fetchImpl: options.fetchImpl,
  });
}

let configuredProvider: SupermemoryAdapter | null | undefined;

export function getSupermemoryProvider(): SupermemoryAdapter | null {
  if (configuredProvider === undefined) {
    configuredProvider = createConfiguredSupermemoryProvider();
  }
  return configuredProvider;
}

export function resetSupermemoryProviderForTests(): void {
  configuredProvider = undefined;
}
