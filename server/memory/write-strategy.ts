import {
  applyExactForget,
  createExactMemory,
  previewForget,
  rememberDurableImage,
  searchMemoryCandidatesForUpdate,
  updateExactMemory,
  type DurableStaticMemoryKind,
  type MemoryOperationDependencies,
} from "./supermemory/operations.js";
import type {
  MemoryOwnerContext,
  MemoryProviderConfiguration,
} from "./supermemory/types.js";
import type { MemorySegment, MemoryTier } from "./types.js";

export interface LegacyMemoryWriteInput {
  conversationId: string;
  content: string;
  segment: Exclude<MemorySegment, "correction">;
  importance: number;
  tier?: MemoryTier;
  supersedes?: string[];
}

export interface LegacyMemoryWriteResult {
  memoryId: string;
  tier: MemoryTier;
  segment: Exclude<MemorySegment, "correction">;
}

export type LegacyWriteFunction = (
  input: LegacyMemoryWriteInput,
) => Promise<LegacyMemoryWriteResult>;

type ExactProviderResult = Awaited<ReturnType<typeof createExactMemory>>;

export type ExactMemoryWriteResult =
  | { kind: "legacy"; legacy: LegacyMemoryWriteResult }
  | { kind: "supermemory"; provider: ExactProviderResult }
  | {
      kind: "dual";
      provider: PromiseSettledResult<ExactProviderResult>;
      legacy: PromiseSettledResult<LegacyMemoryWriteResult>;
    };

export interface MemoryWriteStrategy {
  readonly mode: MemoryProviderConfiguration["writeMode"];
  readonly providerOperationsAvailable: boolean;
  writeExact(input: {
    content: string;
    segment: Exclude<MemorySegment, "correction">;
    importance: number;
    tier?: MemoryTier;
    supersedes?: string[];
    staticKind?: DurableStaticMemoryKind;
  }): Promise<ExactMemoryWriteResult>;
  searchUpdateCandidates(input: { query: string; limit: number }): ReturnType<
    typeof searchMemoryCandidatesForUpdate
  >;
  updateExact(input: { memoryId: string; newContent: string }): ReturnType<
    typeof updateExactMemory
  >;
  previewForget(input: { query: string; reason?: string; maxForget: number }): ReturnType<
    typeof previewForget
  >;
  applyForget(input: { operationId: string; reason?: string }): ReturnType<
    typeof applyExactForget
  >;
  rememberImage(input: { storageId: string }): ReturnType<typeof rememberDurableImage>;
}

export function createMemoryWriteStrategy(options: {
  owner: MemoryOwnerContext | null;
  conversationId: string;
  turnId: string;
  mode: MemoryProviderConfiguration["writeMode"];
  dependencies: MemoryOperationDependencies | null;
  providerConfigurationError?: unknown;
  legacyWrite: LegacyWriteFunction;
}): MemoryWriteStrategy {
  const {
    owner,
    conversationId,
    turnId,
    mode,
    dependencies,
    providerConfigurationError,
    legacyWrite,
  } = options;

  function unavailableError() {
    return providerConfigurationError instanceof Error
      ? providerConfigurationError
      : new Error("Supermemory provider operations are unavailable.");
  }

  function requireProviderOperations() {
    if (mode === "convex" || !owner || !dependencies) throw unavailableError();
    return { owner, dependencies };
  }

  return {
    mode,
    providerOperationsAvailable: mode !== "convex" && owner !== null && dependencies !== null,

    async writeExact(input) {
      const runLegacy = () => legacyWrite({ conversationId, ...input });
      if (mode === "convex") {
        return { kind: "legacy", legacy: await runLegacy() };
      }

      if (!owner || !dependencies) {
        if (mode === "dual") {
          const legacyResult = await Promise.allSettled([runLegacy()]);
          return {
            kind: "dual",
            provider: { status: "rejected", reason: unavailableError() },
            legacy: legacyResult[0],
          };
        }
        throw unavailableError();
      }

      const providerWrite = createExactMemory(
        {
          ownerKey: owner.ownerKey,
          containerTag: owner.containerTag,
          conversationKey: owner.conversationKey,
          turnId,
          content: input.content,
          staticKind: input.staticKind,
        },
        dependencies,
      );
      if (mode === "supermemory") {
        return { kind: "supermemory", provider: await providerWrite };
      }
      const [providerResult, legacyResult] = await Promise.allSettled([
        providerWrite,
        runLegacy(),
      ]);
      return { kind: "dual", provider: providerResult, legacy: legacyResult };
    },

    searchUpdateCandidates({ query, limit }) {
      const resolved = requireProviderOperations();
      return searchMemoryCandidatesForUpdate(
        {
          ownerKey: resolved.owner.ownerKey,
          containerTag: resolved.owner.containerTag,
          query,
          limit,
        },
        resolved.dependencies,
      );
    },

    updateExact({ memoryId, newContent }) {
      const resolved = requireProviderOperations();
      return updateExactMemory(
        {
          ownerKey: resolved.owner.ownerKey,
          containerTag: resolved.owner.containerTag,
          memoryId,
          newContent,
          metadata: {
            source: "daniel_explicit_update",
            conversationKey: resolved.owner.conversationKey,
            turnId,
            schemaVersion: 1,
          },
        },
        resolved.dependencies,
      );
    },

    previewForget({ query, reason, maxForget }) {
      const resolved = requireProviderOperations();
      return previewForget(
        {
          ownerKey: resolved.owner.ownerKey,
          conversationId,
          containerTag: resolved.owner.containerTag,
          query,
          reason,
          maxForget,
        },
        resolved.dependencies,
      );
    },

    applyForget({ operationId, reason }) {
      const resolved = requireProviderOperations();
      return applyExactForget(
        {
          operationId,
          ownerKey: resolved.owner.ownerKey,
          conversationId,
          containerTag: resolved.owner.containerTag,
          reason,
        },
        resolved.dependencies,
      );
    },

    rememberImage({ storageId }) {
      const resolved = requireProviderOperations();
      return rememberDurableImage(
        {
          ownerKey: resolved.owner.ownerKey,
          containerTag: resolved.owner.containerTag,
          storageId,
          conversationId,
          turnId,
          reason: "remember_image_tool",
        },
        resolved.dependencies,
      );
    },
  };
}
