import {
  compareShadowRecall,
  emptyMemoryHydration,
  hydrateMemoryContext,
  type MemoryContextError,
  type MemoryContextInstrumentationHook,
  type MemoryContextResult,
  type ShadowRecallComparison,
} from "./supermemory/context.js";
import { formatMemoryContext } from "./supermemory/format-context.js";
import {
  deriveMemoryIdentity,
  memoryIdSaltFingerprint,
} from "./supermemory/identity.js";
import type {
  DanielMemoryProvider,
  MemoryOwnerContext,
  MemoryProviderConfiguration,
  MemorySearchResult,
} from "./supermemory/types.js";

export interface LegacyMemoryResult {
  memoryId: string;
  content: string;
  importance?: number;
  segment?: string;
  tier?: string;
}

export type LegacyRecallMode = "vector" | "substring";

export interface LegacyMemoryRecallResult {
  results: LegacyMemoryResult[];
  mode: LegacyRecallMode;
}

export interface RuntimeMemoryContextDependencies {
  ensureIdentitySaltFingerprint(saltFingerprint: string): Promise<string>;
  recallLegacy(input: {
    conversationId: string;
    query: string;
    limit?: number;
  }): Promise<LegacyMemoryRecallResult>;
  provider: Pick<DanielMemoryProvider, "profile" | "search"> | null;
  providerError?: unknown;
  memoryIdSalt?: string;
  instrumentation?: MemoryContextInstrumentationHook;
  recordHydration?: (input: {
    startedAt: number;
    finishedAt: number;
    error?: unknown;
  }) => Promise<void>;
}

export interface PrepareRuntimeMemoryContextInput {
  conversationId: string;
  memoryOwnerId: string;
  currentUserMessage: string;
  config: MemoryProviderConfiguration;
}

export interface PreparedRuntimeMemoryContext {
  owner?: MemoryOwnerContext;
  promptContext: string;
  source: "none" | "convex" | "supermemory";
  legacyResults: LegacyMemoryResult[];
  legacyMode?: LegacyRecallMode;
  providerResult?: MemoryContextResult;
  shadowComparison?: ShadowRecallComparison;
  fallbackUsed: boolean;
  error?: MemoryContextError;
}

const PROVIDER_FALLBACK_CODES = new Set<MemoryContextError["code"]>([
  "authentication",
  "provider",
  "rate_limit",
  "timeout",
]);

function configurationError(): MemoryContextError {
  return {
    name: "MemoryContextError",
    code: "configuration",
    message: "Supermemory memory context is not configured correctly",
    retryable: false,
  };
}

function providerFailure(error: unknown): Pick<DanielMemoryProvider, "profile" | "search"> {
  const reject = async () => {
    throw error;
  };
  return { profile: reject, search: reject };
}

function asSearchResults(results: readonly LegacyMemoryResult[]): MemorySearchResult[] {
  return results.map((result, index) => ({
    id: result.memoryId,
    content: result.content,
    kind: "memory",
    similarity:
      typeof result.importance === "number" && Number.isFinite(result.importance)
        ? result.importance
        : Math.max(0, 1 - index / Math.max(results.length, 1)),
    metadata: null,
  }));
}

/** Formats legacy results through the same sanitizing, capped prompt boundary. */
export function formatLegacyRuntimeContext(results: readonly LegacyMemoryResult[]): string {
  return formatMemoryContext({
    profile: { static: [], dynamic: [] },
    results: asSearchResults(results),
  });
}

export function shouldUseLegacyProviderFallback(
  result: Pick<MemoryContextResult, "status" | "fallbackEligible" | "error">,
): boolean {
  return Boolean(
    result.status === "failed" &&
      result.fallbackEligible &&
      result.error &&
      PROVIDER_FALLBACK_CODES.has(result.error.code),
  );
}

async function resolveOwner(
  input: PrepareRuntimeMemoryContextInput,
  dependencies: RuntimeMemoryContextDependencies,
): Promise<MemoryOwnerContext> {
  const currentFingerprint = memoryIdSaltFingerprint(dependencies.memoryIdSalt);
  const persistedFingerprint = await dependencies.ensureIdentitySaltFingerprint(
    currentFingerprint,
  );
  return deriveMemoryIdentity(
    {
      conversationId: input.conversationId,
      memoryOwnerId: input.memoryOwnerId,
    },
    {
      salt: dependencies.memoryIdSalt,
      expectedSaltFingerprint: persistedFingerprint,
    },
  );
}

async function safeLegacyRecall(
  input: PrepareRuntimeMemoryContextInput,
  dependencies: RuntimeMemoryContextDependencies,
): Promise<LegacyMemoryRecallResult> {
  try {
    return await dependencies.recallLegacy({
      conversationId: input.conversationId,
      query: input.currentUserMessage,
      limit: input.config.searchLimit,
    });
  } catch (error) {
    console.warn("[memory] legacy recall failed open", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return { results: [], mode: "substring" };
  }
}

/**
 * Selects the user-facing pre-dispatch memory source for each migration mode.
 * Shadow reads always keep Convex user-facing. Supermemory mode falls back to
 * Convex only for provider failures during the explicitly enabled burn-in.
 */
export async function prepareRuntimeMemoryContext(
  input: PrepareRuntimeMemoryContextInput,
  dependencies: RuntimeMemoryContextDependencies,
): Promise<PreparedRuntimeMemoryContext> {
  const { config } = input;
  const needsLegacy = config.readMode === "convex" || config.readMode === "shadow";
  const legacyPromise = needsLegacy
    ? safeLegacyRecall(input, dependencies)
    : Promise.resolve<LegacyMemoryRecallResult>({ results: [], mode: "substring" });

  if (config.readMode === "convex" && config.writeMode === "convex") {
    const legacy = await legacyPromise;
    return {
      promptContext: formatLegacyRuntimeContext(legacy.results),
      source: legacy.results.length > 0 ? "convex" : "none",
      legacyResults: legacy.results,
      legacyMode: legacy.mode,
      fallbackUsed: false,
    };
  }

  let owner: MemoryOwnerContext;
  try {
    owner = await resolveOwner(input, dependencies);
  } catch {
    const legacy = await legacyPromise;
    const error = configurationError();
    return {
      promptContext:
        config.readMode === "shadow" ? formatLegacyRuntimeContext(legacy.results) : "",
      source:
        config.readMode === "shadow" && legacy.results.length > 0 ? "convex" : "none",
      legacyResults: legacy.results,
      legacyMode: needsLegacy ? legacy.mode : undefined,
      fallbackUsed: false,
      error,
      ...(config.readMode === "shadow"
        ? {
            shadowComparison: compareShadowRecall({
              legacyResults: legacy.results,
              supermemory: emptyMemoryHydration(),
              error,
            }),
          }
        : {}),
    };
  }

  if (config.readMode === "convex") {
    const legacy = await legacyPromise;
    return {
      owner,
      promptContext: formatLegacyRuntimeContext(legacy.results),
      source: legacy.results.length > 0 ? "convex" : "none",
      legacyResults: legacy.results,
      legacyMode: legacy.mode,
      fallbackUsed: false,
    };
  }

  const provider = dependencies.provider ?? providerFailure(
    dependencies.providerError ?? new Error("Supermemory provider is unavailable"),
  );
  const hydrationStartedAt = Date.now();
  const providerResultPromise = hydrateMemoryContext({
    provider,
    owner,
    currentUserMessage: input.currentUserMessage,
    mode: config.readMode,
    config: {
      timeoutMs: config.timeoutMs,
      threshold: config.threshold,
      searchLimit: config.searchLimit,
      legacyFallback: config.legacyFallback,
    },
    instrumentation: dependencies.instrumentation,
  });
  const [legacy, providerResult] = await Promise.all([
    legacyPromise,
    providerResultPromise,
  ]);
  await dependencies.recordHydration?.({
    startedAt: hydrationStartedAt,
    finishedAt: Date.now(),
    error: providerResult.error,
  });

  if (config.readMode === "shadow") {
    return {
      owner,
      promptContext: formatLegacyRuntimeContext(legacy.results),
      source: legacy.results.length > 0 ? "convex" : "none",
      legacyResults: legacy.results,
      legacyMode: legacy.mode,
      providerResult,
      shadowComparison: compareShadowRecall({
        legacyResults: legacy.results,
        supermemory: providerResult.hydration,
        error: providerResult.error,
      }),
      fallbackUsed: false,
      error: providerResult.error,
    };
  }

  if (shouldUseLegacyProviderFallback(providerResult)) {
    const fallback = await safeLegacyRecall(input, dependencies);
    return {
      owner,
      promptContext: formatLegacyRuntimeContext(fallback.results),
      source: fallback.results.length > 0 ? "convex" : "none",
      legacyResults: fallback.results,
      legacyMode: fallback.mode,
      providerResult,
      fallbackUsed: true,
      error: providerResult.error,
    };
  }

  return {
    owner,
    promptContext: providerResult.formattedContext,
    source: providerResult.formattedContext ? "supermemory" : "none",
    legacyResults: [],
    providerResult,
    fallbackUsed: false,
    error: providerResult.error,
  };
}
