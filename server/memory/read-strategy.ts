import {
  recallMemory,
  type MemoryContextErrorCode,
  type MemoryContextInstrumentationHook,
  type MemoryRecallResult,
} from "./supermemory/context.js";
import type {
  DanielMemoryProvider,
  MemoryOwnerContext,
  MemoryProviderConfiguration,
} from "./supermemory/types.js";
import type { MemorySegment, MemoryTier } from "./types.js";

const LEGACY_PROVIDER_FALLBACK_CODES = new Set<MemoryContextErrorCode>([
  "authentication",
  "provider",
  "rate_limit",
  "timeout",
]);

export interface LegacyMemoryResult {
  memoryId: string;
  content: string;
  tier: MemoryTier;
  segment: MemorySegment;
  importance: number;
}

export interface LegacyMemoryRecall {
  results: LegacyMemoryResult[];
  mode: "vector" | "substring";
}

export type LegacyRecallFunction = (input: {
  conversationId: string;
  query: string;
  limit?: number;
  bookkeeping?: "disabled" | "best_effort";
}) => Promise<LegacyMemoryRecall>;

export type MemoryReadResult =
  | { source: "legacy"; recall: LegacyMemoryRecall }
  | { source: "supermemory"; results: MemoryRecallResult["results"] }
  | { source: "failure"; action: string; error?: unknown };

export interface MemoryReadStrategy {
  readonly mode: MemoryProviderConfiguration["readMode"];
  readonly providerAvailable: boolean;
  recall(input: { query: string; limit: number }): Promise<MemoryReadResult>;
}

export function createMemoryReadStrategy(options: {
  owner: MemoryOwnerContext | null;
  conversationId: string;
  config: Pick<
    MemoryProviderConfiguration,
    "readMode" | "timeoutMs" | "threshold" | "searchLimit" | "legacyFallback"
  >;
  provider: Pick<DanielMemoryProvider, "profile" | "search"> | null;
  providerConfigurationError?: unknown;
  instrumentation?: MemoryContextInstrumentationHook;
  legacyRecall: LegacyRecallFunction;
}): MemoryReadStrategy {
  const {
    owner,
    conversationId,
    config,
    provider,
    providerConfigurationError,
    instrumentation,
    legacyRecall,
  } = options;
  const runLegacy = (query: string, limit: number) =>
    legacyRecall({ conversationId, query, limit });

  return {
    mode: config.readMode,
    providerAvailable: provider !== null,
    async recall({ query, limit }) {
      if (config.readMode === "convex") {
        try {
          return { source: "legacy", recall: await runLegacy(query, limit) };
        } catch (error) {
          return { source: "failure", action: "recall legacy memory", error };
        }
      }

      if (!owner) {
        if (config.readMode === "shadow") {
          try {
            return { source: "legacy", recall: await runLegacy(query, limit) };
          } catch (error) {
            return { source: "failure", action: "recall legacy memory", error };
          }
        }
        return {
          source: "failure",
          action: "recall memory",
          error: providerConfigurationError,
        };
      }

      if (config.readMode === "shadow") {
        const legacyPromise = runLegacy(query, limit);
        if (provider) {
          const shadowRecall = recallMemory({
            provider,
            owner,
            q: query,
            mode: "shadow",
            config: {
              timeoutMs: config.timeoutMs,
              threshold: config.threshold,
              searchLimit: Math.min(limit, config.searchLimit),
              legacyFallback: config.legacyFallback,
            },
            instrumentation,
          });
          const [legacyResult] = await Promise.allSettled([legacyPromise, shadowRecall]);
          return legacyResult.status === "fulfilled"
            ? { source: "legacy", recall: legacyResult.value }
            : {
                source: "failure",
                action: "recall legacy memory",
                error: legacyResult.reason,
              };
        }
        try {
          return { source: "legacy", recall: await legacyPromise };
        } catch (error) {
          return { source: "failure", action: "recall legacy memory", error };
        }
      }

      if (!provider) {
        return {
          source: "failure",
          action: "recall memory",
          error: providerConfigurationError,
        };
      }

      const recalled = await recallMemory({
        provider,
        owner,
        q: query,
        mode: "supermemory",
        config: {
          timeoutMs: config.timeoutMs,
          threshold: config.threshold,
          searchLimit: Math.min(limit, config.searchLimit),
          legacyFallback: config.legacyFallback,
        },
        instrumentation,
      });
      if (recalled.status !== "failed") {
        return { source: "supermemory", results: recalled.results };
      }
      if (
        recalled.fallbackEligible &&
        recalled.error &&
        LEGACY_PROVIDER_FALLBACK_CODES.has(recalled.error.code)
      ) {
        try {
          return { source: "legacy", recall: await runLegacy(query, limit) };
        } catch (error) {
          return { source: "failure", action: "recall memory", error };
        }
      }
      return { source: "failure", action: "recall memory", error: recalled.error };
    },
  };
}
