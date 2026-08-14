import {
  getSupermemoryProvider,
  readMemoryProviderConfiguration,
} from "./client.js";
import {
  hydrateMemoryContext,
  recallMemory,
  type MemoryContextInstrumentationHook,
  type MemoryContextResult,
  type MemoryRecallResult,
} from "./context.js";
import {
  SupermemoryOperationTransport,
  applyExactForget,
  createConvexImageAnchorStore,
  createConvexPendingOperationStore,
  createExactMemory,
  createMemoryOperationProvider,
  fetchConvexImageBytes,
  previewForget,
  rememberDurableImage,
  searchMemoryCandidatesForUpdate,
  updateExactMemory,
  type CreateExactMemoryOperationInput,
  type DurableImageReason,
  type ForgetPreview,
  type MemoryOperationDependencies,
} from "./operations.js";
import type {
  DanielMemoryProvider,
  MemoryOwnerContext,
  MemoryProviderConfiguration,
  MemorySearchResult,
} from "./types.js";

export interface SupermemoryServiceOptions {
  owner: MemoryOwnerContext;
  turnId: string;
  provider: Pick<DanielMemoryProvider, "profile" | "search">;
  configuration: MemoryProviderConfiguration;
  operations: MemoryOperationDependencies;
  instrumentation?: MemoryContextInstrumentationHook;
}

/** Thin façade that keeps tool handlers independent from provider plumbing. */
export class SupermemoryService {
  readonly owner: MemoryOwnerContext;
  readonly turnId: string;

  constructor(private readonly options: SupermemoryServiceOptions) {
    this.owner = options.owner;
    this.turnId = options.turnId;
  }

  hydrate(currentUserMessage: string): Promise<MemoryContextResult> {
    return hydrateMemoryContext({
      provider: this.options.provider,
      owner: this.owner,
      currentUserMessage,
      config: this.options.configuration,
      instrumentation: this.options.instrumentation,
    });
  }

  recall(q: string): Promise<MemoryRecallResult> {
    return recallMemory({
      provider: this.options.provider,
      owner: this.owner,
      q,
      config: this.options.configuration,
      instrumentation: this.options.instrumentation,
    });
  }

  rememberExact(
    input: Pick<CreateExactMemoryOperationInput, "content" | "staticKind">,
  ) {
    return createExactMemory(
      {
        ...input,
        ownerKey: this.owner.ownerKey,
        containerTag: this.owner.containerTag,
        conversationKey: this.owner.conversationKey,
        turnId: this.turnId,
      },
      this.options.operations,
    );
  }

  searchUpdateCandidates(input: { query: string; limit?: number }): Promise<MemorySearchResult[]> {
    return searchMemoryCandidatesForUpdate(
      {
        ownerKey: this.owner.ownerKey,
        containerTag: this.owner.containerTag,
        ...input,
      },
      this.options.operations,
    );
  }

  updateExact(input: { memoryId: string; newContent: string }) {
    return updateExactMemory(
      {
        ownerKey: this.owner.ownerKey,
        containerTag: this.owner.containerTag,
        ...input,
      },
      this.options.operations,
    );
  }

  previewForget(input: { query: string; reason?: string; maxForget?: number }): Promise<ForgetPreview> {
    return previewForget(
      {
        ownerKey: this.owner.ownerKey,
        conversationId: this.owner.conversationId,
        containerTag: this.owner.containerTag,
        ...input,
      },
      this.options.operations,
    );
  }

  confirmForget(input: { operationId: string; reason?: string }) {
    return applyExactForget(
      {
        ownerKey: this.owner.ownerKey,
        conversationId: this.owner.conversationId,
        containerTag: this.owner.containerTag,
        ...input,
      },
      this.options.operations,
    );
  }

  rememberImage(input: { storageId: string; reason?: DurableImageReason }) {
    return rememberDurableImage(
      {
        ownerKey: this.owner.ownerKey,
        containerTag: this.owner.containerTag,
        storageId: input.storageId,
        conversationId: this.owner.conversationId,
        turnId: this.turnId,
        reason: input.reason ?? "remember_image_tool",
      },
      this.options.operations,
    );
  }
}

export interface CreateConfiguredSupermemoryServiceInput {
  owner: MemoryOwnerContext;
  turnId: string;
  instrumentation?: MemoryContextInstrumentationHook;
  configuration?: MemoryProviderConfiguration;
  provider?: Pick<DanielMemoryProvider, "profile" | "search"> | null;
  operations?: MemoryOperationDependencies;
  env?: Record<string, string | undefined>;
}

export function createConfiguredSupermemoryService(
  input: CreateConfiguredSupermemoryServiceInput,
): SupermemoryService | null {
  const env = input.env ?? process.env;
  const configuration = input.configuration ?? readMemoryProviderConfiguration(env);
  const apiKey = env.SUPERMEMORY_API_KEY?.trim();
  if (!configuration.apiKeyConfigured || !apiKey) return null;
  const provider = input.provider === undefined ? getSupermemoryProvider() : input.provider;
  if (!provider) return null;
  const operations =
    input.operations ??
    (() => {
      const transport = new SupermemoryOperationTransport({
        apiKey,
        timeoutMs: configuration.timeoutMs,
        // Exact user-approved mutations are not retried after an ambiguous
        // timeout because the provider endpoints do not accept an idempotency
        // key for these operations.
        retries: 0,
      });
      return {
        provider: createMemoryOperationProvider({
          transport,
          search: (request) => provider.search(request),
        }),
        pendingOperations: createConvexPendingOperationStore(),
        imageAnchors: createConvexImageAnchorStore(),
        fetchImageBytes: fetchConvexImageBytes,
      };
    })();
  return new SupermemoryService({
    owner: input.owner,
    turnId: input.turnId,
    provider,
    configuration,
    operations,
    instrumentation: input.instrumentation,
  });
}
