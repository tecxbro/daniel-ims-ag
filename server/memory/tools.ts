import { z } from "zod";
import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { embed, embeddingsAvailable } from "../embeddings.js";
import { createClaudeMcpServer } from "../runtimes/claude.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool, type RuntimeToolResult } from "../runtimes/types.js";
import {
  getSupermemoryProvider,
  readMemoryProviderConfiguration,
} from "./supermemory/client.js";
import {
  recallMemory,
  type MemoryContextErrorCode,
  type MemoryContextInstrumentationHook,
} from "./supermemory/context.js";
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
  type DurableStaticMemoryKind,
  type MemoryOperationDependencies,
} from "./supermemory/operations.js";
import type {
  DanielMemoryProvider,
  MemoryOwnerContext,
  MemoryProviderConfiguration,
} from "./supermemory/types.js";
import {
  DEFAULT_DECAY,
  SEGMENT_PREFERRED_TIER,
  makeMemoryId,
  type MemoryRecord,
  type MemorySegment,
  type MemoryTier,
} from "./types.js";

const NAMESPACE = "daniel-memory";
const DEFAULT_TOOL_SEARCH_LIMIT = 8;
const LEGACY_PROVIDER_FALLBACK_CODES = new Set<MemoryContextErrorCode>([
  "authentication",
  "provider",
  "rate_limit",
  "timeout",
]);

const tierEnum = z.enum(["short", "long", "permanent"]);
const segmentEnum = z.enum([
  "identity",
  "preference",
  "relationship",
  "project",
  "knowledge",
  "context",
]);
const staticKindEnum = z.enum([
  "preferred_name",
  "core_identity",
  "long_term_role",
  "home_timezone",
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

type MemoryToolConfig = Pick<
  MemoryProviderConfiguration,
  | "readMode"
  | "writeMode"
  | "timeoutMs"
  | "threshold"
  | "searchLimit"
  | "legacyFallback"
>;

export interface CreateMemoryToolsOptions {
  owner: MemoryOwnerContext;
  turnId: string;
  /** Exact current-turn images the dispatcher is allowed to make durable. */
  imageStorageIds?: readonly string[];
  config?: MemoryToolConfig;
  provider?: Pick<DanielMemoryProvider, "profile" | "search"> | null;
  operationDependencies?: MemoryOperationDependencies | null;
  instrumentation?: MemoryContextInstrumentationHook;
  legacyRecall?: typeof recallLegacyMemory;
  legacyWrite?: typeof writeLegacyMemory;
}

interface ResolvedMemoryToolContext {
  owner: MemoryOwnerContext | null;
  turnId: string;
  config: MemoryToolConfig;
  legacyRecall: typeof recallLegacyMemory;
  legacyWrite: typeof writeLegacyMemory;
}

function asLegacyMemoryResult(value: unknown): LegacyMemoryResult | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<MemoryRecord>;
  if (
    typeof record.memoryId !== "string" ||
    typeof record.content !== "string" ||
    typeof record.tier !== "string" ||
    typeof record.segment !== "string" ||
    typeof record.importance !== "number"
  ) {
    return null;
  }
  return {
    memoryId: record.memoryId,
    content: record.content,
    tier: record.tier,
    segment: record.segment,
    importance: record.importance,
  };
}

/**
 * The one legacy recall boundary used by both automatic shadow hydration and
 * the optional recall tool. It intentionally retains the old vector-first,
 * substring-fallback behavior and its access/event bookkeeping.
 */
export async function recallLegacyMemory(input: {
  conversationId: string;
  query: string;
  limit?: number;
}): Promise<LegacyMemoryRecall> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? DEFAULT_TOOL_SEARCH_LIMIT)));
  let results: LegacyMemoryResult[] = [];
  let mode: LegacyMemoryRecall["mode"] = "substring";

  if (embeddingsAvailable()) {
    const queryVector = await embed(input.query);
    if (queryVector) {
      const hits = (await convex.action(api.memoryRecords.vectorSearch, {
        embedding: queryVector,
        limit,
      })) as Array<{ record?: unknown }>;
      results = hits
        .map((hit) => asLegacyMemoryResult(hit.record))
        .filter((result): result is LegacyMemoryResult => result !== null);
      mode = "vector";
    }
  }
  if (results.length === 0) {
    const matches = (await convex.query(api.memoryRecords.search, {
      query: input.query,
      limit,
    })) as unknown[];
    results = matches
      .map(asLegacyMemoryResult)
      .filter((result): result is LegacyMemoryResult => result !== null);
    mode = "substring";
  }

  await Promise.all(
    results.map((result) =>
      convex.mutation(api.memoryRecords.markAccessed, { memoryId: result.memoryId }),
    ),
  );
  await convex.mutation(api.memoryEvents.emit, {
    eventType: "memory.recalled",
    conversationId: input.conversationId,
    data: JSON.stringify({ query: input.query, hits: results.length, mode }),
  });
  return { results, mode };
}

/** Legacy write path retained only for convex/dual rollback coverage. */
export async function writeLegacyMemory(
  input: LegacyMemoryWriteInput,
): Promise<LegacyMemoryWriteResult> {
  const tier = input.tier ?? SEGMENT_PREFERRED_TIER[input.segment];
  const memoryId = makeMemoryId();
  const embedding = (await embed(input.content)) ?? undefined;
  await convex.mutation(api.memoryRecords.upsert, {
    memoryId,
    content: input.content,
    tier,
    segment: input.segment,
    importance: input.importance,
    decayRate: DEFAULT_DECAY[tier],
    supersedes: input.supersedes,
    embedding,
  });
  await convex.mutation(api.memoryEvents.emit, {
    eventType: "memory.written",
    conversationId: input.conversationId,
    memoryId,
    data: JSON.stringify({ tier, segment: input.segment, importance: input.importance }),
  });
  return { memoryId, tier, segment: input.segment };
}

function formatLegacyRecall(recall: LegacyMemoryRecall): RuntimeToolResult {
  if (recall.results.length === 0) return runtimeText("No memories matched.");
  return runtimeText(
    recall.results
      .map(
        (result) =>
          `• [${result.tier}/${result.segment} importance=${result.importance.toFixed(2)}] ${result.memoryId}: ${result.content}`,
      )
      .join("\n"),
  );
}

function formatProviderRecall(
  results: Awaited<ReturnType<typeof recallMemory>>["results"],
): RuntimeToolResult {
  if (results.length === 0) return runtimeText("No memories matched.");
  return runtimeText(
    results
      .map(
        (result) =>
          `• [supermemory relevance=${result.similarity.toFixed(2)}] ${result.id}: ${result.content}`,
      )
      .join("\n"),
  );
}

function safeConfiguration(): {
  config: MemoryToolConfig;
  error?: unknown;
} {
  try {
    return { config: readMemoryProviderConfiguration() };
  } catch (error) {
    const rawReadMode = process.env.DANIEL_MEMORY_READ_MODE?.trim().toLowerCase();
    const readMode =
      rawReadMode === "convex" || rawReadMode === "shadow" || rawReadMode === "supermemory"
        ? rawReadMode
        : rawReadMode
          ? "supermemory"
          : "convex";
    const rawWriteMode = process.env.DANIEL_MEMORY_WRITE_MODE?.trim().toLowerCase();
    const writeMode =
      rawWriteMode === "convex" || rawWriteMode === "dual" || rawWriteMode === "supermemory"
        ? rawWriteMode
        : rawWriteMode
          ? "supermemory"
          : "convex";
    return {
      config: {
        readMode,
        writeMode,
        timeoutMs: 1_200,
        threshold: 0.6,
        searchLimit: DEFAULT_TOOL_SEARCH_LIMIT,
        legacyFallback: false,
      },
      error,
    };
  }
}

function providerFailure(action: string, error?: unknown): RuntimeToolResult {
  const errorCode =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "provider")
      : "provider";
  console.warn(`[memory.tools] ${action} failed`, { errorCode });
  return runtimeText(
    `The memory provider could not ${action}. Continue the conversation without claiming the memory changed.`,
    false,
  );
}

/**
 * The string overload is a temporary compatibility path for legacy-only
 * callers. Supermemory reads and operations require the full owner context.
 */
export function createMemoryTools(conversationId: string): RuntimeTool[];
export function createMemoryTools(options: CreateMemoryToolsOptions): RuntimeTool[];
export function createMemoryTools(
  input: string | CreateMemoryToolsOptions,
): RuntimeTool[] {
  const fallbackConfiguration = safeConfiguration();
  const legacy: ResolvedMemoryToolContext =
    typeof input === "string"
      ? {
          owner: null,
          turnId: `legacy-${makeMemoryId()}`,
          config: fallbackConfiguration.config,
          legacyRecall: recallLegacyMemory,
          legacyWrite: writeLegacyMemory,
        }
      : {
          owner: input.owner,
          turnId: input.turnId,
          config: input.config ?? fallbackConfiguration.config,
          legacyRecall: input.legacyRecall ?? recallLegacyMemory,
          legacyWrite: input.legacyWrite ?? writeLegacyMemory,
        };
  const conversationId =
    typeof input === "string" ? input : input.owner.conversationId;
  const instrumentation = typeof input === "string" ? undefined : input.instrumentation;
  const eligibleImageStorageIds = new Set(
    typeof input === "string" ? [] : (input.imageStorageIds ?? []),
  );
  const eligibleImageDescription =
    eligibleImageStorageIds.size > 0
      ? [...eligibleImageStorageIds].join(", ")
      : "(no current-turn images)";
  const injectedProvider = typeof input === "string" ? undefined : input.provider;
  const injectedOperationDependencies =
    typeof input === "string" ? undefined : input.operationDependencies;
  let resolvedProvider:
    | Pick<DanielMemoryProvider, "profile" | "search">
    | null
    | undefined = injectedProvider;
  let resolvedOperationDependencies: MemoryOperationDependencies | null | undefined =
    injectedOperationDependencies;

  function provider(): Pick<DanielMemoryProvider, "profile" | "search"> | null {
    if (resolvedProvider !== undefined) return resolvedProvider;
    try {
      resolvedProvider = getSupermemoryProvider();
    } catch (error) {
      console.warn("[memory.tools] provider initialization failed", {
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "configuration")
            : "configuration",
      });
      resolvedProvider = null;
    }
    return resolvedProvider;
  }

  function operationDependencies(): MemoryOperationDependencies | null {
    if (resolvedOperationDependencies !== undefined) return resolvedOperationDependencies;
    const configuredProvider = provider();
    const apiKey = process.env.SUPERMEMORY_API_KEY?.trim();
    if (!configuredProvider || !apiKey || !legacy.owner) {
      resolvedOperationDependencies = null;
      return null;
    }
    const transport = new SupermemoryOperationTransport({
      apiKey,
      timeoutMs: legacy.config.timeoutMs,
    });
    resolvedOperationDependencies = {
      provider: createMemoryOperationProvider({
        transport,
        search: (request) => configuredProvider.search(request),
      }),
      pendingOperations: createConvexPendingOperationStore(),
      imageAnchors: createConvexImageAnchorStore(),
      fetchImageBytes: fetchConvexImageBytes,
    };
    return resolvedOperationDependencies;
  }

  async function runLegacyRecall(query: string, limit: number): Promise<LegacyMemoryRecall> {
    return await legacy.legacyRecall({ conversationId, query, limit });
  }

  return [
    defineRuntimeTool(
      NAMESPACE,
      "write_memory",
      "Persist one exact durable fact for future turns. In dual mode Daniel also writes the Convex rollback copy. Use only for durable identity, preferences, projects, relationships, or knowledge, not transient conversational state.",
      {
        content: z.string().min(1).max(10_000).describe("The exact fact to remember, in one clear sentence."),
        segment: segmentEnum.describe(
          "identity: core facts about who they are. preference: how they like things done. relationship: people they know. project: ongoing work. knowledge: facts about their world. context: current situation.",
        ),
        importance: z.number().min(0).max(1).describe("0-1; how critical the rollback copy is to retain."),
        tier: tierEnum.optional().describe("Convex rollback tier override; ignored by Supermemory."),
        supersedes: z
          .array(z.string())
          .optional()
          .describe("Legacy memory IDs superseded in the Convex rollback copy."),
        staticKind: staticKindEnum
          .optional()
          .describe("Only for an explicitly durable preferred name, identity, long-term role, or home timezone."),
      },
      async (args) => {
        const legacyWrite = () =>
          legacy.legacyWrite({
            conversationId,
            content: args.content,
            segment: args.segment,
            importance: args.importance,
            tier: args.tier,
            supersedes: args.supersedes,
          });

        if (legacy.config.writeMode === "convex") {
          try {
            const stored = await legacyWrite();
            return runtimeText(
              `Stored ${stored.memoryId} (tier=${stored.tier}, segment=${stored.segment}).`,
            );
          } catch (error) {
            return providerFailure("store the legacy memory", error);
          }
        }

        if (!legacy.owner) {
          if (legacy.config.writeMode === "dual") {
            try {
              const stored = await legacyWrite();
              return runtimeText(
                `Stored Convex rollback ${stored.memoryId}, but the Supermemory exact write was unavailable.`,
                false,
              );
            } catch (error) {
              return providerFailure("create the exact memory", error);
            }
          }
          return providerFailure("create the exact memory", fallbackConfiguration.error);
        }

        const dependencies = operationDependencies();
        if (!dependencies) {
          if (legacy.config.writeMode === "dual") {
            try {
              const stored = await legacyWrite();
              return runtimeText(
                `Stored Convex rollback ${stored.memoryId}, but the Supermemory exact write was unavailable.`,
                false,
              );
            } catch (error) {
              return providerFailure("create the exact memory", error);
            }
          }
          return providerFailure("create the exact memory", fallbackConfiguration.error);
        }
        const providerWrite = createExactMemory(
          {
            ownerKey: legacy.owner.ownerKey,
            containerTag: legacy.owner.containerTag,
            conversationKey: legacy.owner.conversationKey,
            turnId: legacy.turnId,
            content: args.content,
            staticKind: args.staticKind as DurableStaticMemoryKind | undefined,
          },
          dependencies,
        );

        if (legacy.config.writeMode === "supermemory") {
          try {
            const created = await providerWrite;
            const ids = created.memories.map((memory) => memory.id).join(", ");
            return runtimeText(`Stored exact Supermemory ${ids || "memory"}.`);
          } catch (error) {
            return providerFailure("create the exact memory", error);
          }
        }

        const [providerResult, legacyResult] = await Promise.allSettled([
          providerWrite,
          legacyWrite(),
        ]);
        if (providerResult.status === "fulfilled" && legacyResult.status === "fulfilled") {
          const ids = providerResult.value.memories.map((memory) => memory.id).join(", ");
          return runtimeText(
            `Stored exact Supermemory ${ids || "memory"} and Convex rollback ${legacyResult.value.memoryId}.`,
          );
        }
        if (providerResult.status === "fulfilled") {
          return runtimeText(
            "Stored the exact Supermemory memory, but the Convex rollback copy failed.",
            false,
          );
        }
        if (legacyResult.status === "fulfilled") {
          return runtimeText(
            `Stored Convex rollback ${legacyResult.value.memoryId}, but the Supermemory exact write failed.`,
            false,
          );
        }
        return providerFailure("create the exact memory", providerResult.reason);
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "recall",
      "Run an optional narrow memory query. Memory context is already preloaded; use this only when the current question needs a more specific search.",
      {
        query: z.string().min(1).describe("A specific topic or fact to search for."),
        limit: z.number().int().min(1).max(20).optional().default(DEFAULT_TOOL_SEARCH_LIMIT),
      },
      async (args) => {
        if (legacy.config.readMode === "convex") {
          try {
            return formatLegacyRecall(await runLegacyRecall(args.query, args.limit));
          } catch (error) {
            return providerFailure("recall legacy memory", error);
          }
        }

        if (!legacy.owner) {
          if (legacy.config.readMode === "shadow") {
            try {
              return formatLegacyRecall(await runLegacyRecall(args.query, args.limit));
            } catch (error) {
              return providerFailure("recall legacy memory", error);
            }
          }
          return providerFailure("recall memory", fallbackConfiguration.error);
        }

        const configuredProvider = provider();
        if (legacy.config.readMode === "shadow") {
          const legacyPromise = runLegacyRecall(args.query, args.limit);
          if (configuredProvider) {
            const shadowRecall = recallMemory({
              provider: configuredProvider,
              owner: legacy.owner,
              q: args.query,
              mode: "shadow",
              config: {
                timeoutMs: legacy.config.timeoutMs,
                threshold: legacy.config.threshold,
                searchLimit: Math.min(args.limit, legacy.config.searchLimit),
                legacyFallback: legacy.config.legacyFallback,
              },
              instrumentation,
            });
            const [legacyResult] = await Promise.allSettled([legacyPromise, shadowRecall]);
            if (legacyResult.status === "fulfilled") {
              return formatLegacyRecall(legacyResult.value);
            }
            return providerFailure("recall legacy memory", legacyResult.reason);
          }
          try {
            return formatLegacyRecall(await legacyPromise);
          } catch (error) {
            return providerFailure("recall legacy memory", error);
          }
        }

        if (!configuredProvider) {
          return providerFailure("recall memory", fallbackConfiguration.error);
        }

        const recalled = await recallMemory({
          provider: configuredProvider,
          owner: legacy.owner,
          q: args.query,
          mode: "supermemory",
          config: {
            timeoutMs: legacy.config.timeoutMs,
            threshold: legacy.config.threshold,
            searchLimit: Math.min(args.limit, legacy.config.searchLimit),
            legacyFallback: legacy.config.legacyFallback,
          },
          instrumentation,
        });
        if (recalled.status !== "failed") return formatProviderRecall(recalled.results);
        if (
          recalled.fallbackEligible &&
          recalled.error &&
          LEGACY_PROVIDER_FALLBACK_CODES.has(recalled.error.code)
        ) {
          try {
            return formatLegacyRecall(await runLegacyRecall(args.query, args.limit));
          } catch (error) {
            return providerFailure("recall memory", error);
          }
        }
        return providerFailure("recall memory", recalled.error);
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "update_memory",
      "Find candidate Supermemory entries or update one selected exact provider memory ID as a new version. Search first when the exact ID is not already known.",
      {
        query: z.string().min(1).optional().describe("Search text used only to list update candidates."),
        memoryId: z.string().min(1).optional().describe("The exact provider memory ID selected for update."),
        newContent: z.string().min(1).max(10_000).optional().describe("The corrected complete memory content."),
        limit: z.number().int().min(1).max(8).optional().default(DEFAULT_TOOL_SEARCH_LIMIT),
      },
      async (args) => {
        if (legacy.config.writeMode === "convex" || !legacy.owner) {
          return runtimeText("Versioned memory updates require Supermemory write mode.", false);
        }
        const dependencies = operationDependencies();
        if (!dependencies) return providerFailure("update memory", fallbackConfiguration.error);
        try {
          if (!args.memoryId) {
            if (!args.query || args.newContent) {
              return runtimeText(
                "Provide only query to list candidates, then call update_memory with memoryId and newContent.",
                false,
              );
            }
            const candidates = await searchMemoryCandidatesForUpdate(
              {
                ownerKey: legacy.owner.ownerKey,
                containerTag: legacy.owner.containerTag,
                query: args.query,
                limit: args.limit,
              },
              dependencies,
            );
            if (candidates.length === 0) return runtimeText("No update candidates matched.");
            return runtimeText(
              candidates
                .map(
                  (candidate) =>
                    `• [relevance=${candidate.similarity.toFixed(2)}] ${candidate.id}: ${candidate.content}`,
                )
                .join("\n"),
            );
          }
          if (!args.newContent || args.query) {
            return runtimeText(
              "An exact update requires memoryId and newContent, without a semantic query.",
              false,
            );
          }
          const result = await updateExactMemory(
            {
              ownerKey: legacy.owner.ownerKey,
              containerTag: legacy.owner.containerTag,
              memoryId: args.memoryId,
              newContent: args.newContent,
              metadata: {
                source: "daniel_explicit_update",
                conversationKey: legacy.owner.conversationKey,
                turnId: legacy.turnId,
                schemaVersion: 1,
              },
            },
            dependencies,
          );
          return runtimeText(result.confirmation);
        } catch (error) {
          return providerFailure("update memory", error);
        }
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "forget_memory",
      "Preview memories matching a forget request, then apply only the exact IDs stored in that preview after confirmation. Never confirm without showing the preview to the user.",
      {
        query: z.string().min(1).optional().describe("Stage 1 semantic forget request."),
        operationId: z.string().min(1).optional().describe("Stage 2 pending operation ID returned by the preview."),
        confirm: z.boolean().optional().default(false).describe("True only after the user explicitly confirms the preview."),
        reason: z.string().max(1_000).optional(),
        maxForget: z.number().int().min(1).max(100).optional().default(25),
      },
      async (args) => {
        if (legacy.config.writeMode === "convex" || !legacy.owner) {
          return runtimeText("Exact memory forgetting requires Supermemory write mode.", false);
        }
        const dependencies = operationDependencies();
        if (!dependencies) return providerFailure("forget memory", fallbackConfiguration.error);
        try {
          if (args.confirm) {
            if (!args.operationId || args.query) {
              return runtimeText(
                "Confirmation requires only the stored operationId; the semantic query must not be rerun.",
                false,
              );
            }
            const result = await applyExactForget(
              {
                operationId: args.operationId,
                ownerKey: legacy.owner.ownerKey,
                conversationId,
                containerTag: legacy.owner.containerTag,
                reason: args.reason,
              },
              dependencies,
            );
            return runtimeText(result.confirmation);
          }
          if (!args.query || args.operationId) {
            return runtimeText(
              "Start with query to create a forget preview, or confirm a prior operationId.",
              false,
            );
          }
          const result = await previewForget(
            {
              ownerKey: legacy.owner.ownerKey,
              conversationId,
              containerTag: legacy.owner.containerTag,
              query: args.query,
              reason: args.reason,
              maxForget: args.maxForget,
            },
            dependencies,
          );
          if (!result.operationId) return runtimeText(result.preview);
          return runtimeText(
            `${result.preview}\n\nPending operation: ${result.operationId}\nExpires: ${new Date(result.expiresAt!).toISOString()}`,
          );
        } catch (error) {
          return providerFailure("forget memory", error);
        }
      },
    ),

    defineRuntimeTool(
      NAMESPACE,
      "remember_image",
      "Make one explicitly selected Convex image durable in Supermemory. Use only when the user asks to remember the image or identifies it as a durable object.",
      {
        storageId: z
          .string()
          .min(1)
          .describe(`Exact current-turn Convex image storage ID. Available: ${eligibleImageDescription}`),
      },
      async (args) => {
        if (legacy.config.writeMode === "convex" || !legacy.owner) {
          return runtimeText("Durable image memory requires Supermemory write mode.", false);
        }
        if (!eligibleImageStorageIds.has(args.storageId)) {
          return runtimeText(
            "That image is not attached to the current user turn, so it cannot be made durable.",
            false,
          );
        }
        const dependencies = operationDependencies();
        if (!dependencies) return providerFailure("remember the image", fallbackConfiguration.error);
        try {
          const result = await rememberDurableImage(
            {
              ownerKey: legacy.owner.ownerKey,
              containerTag: legacy.owner.containerTag,
              storageId: args.storageId,
              conversationId,
              turnId: legacy.turnId,
              reason: "remember_image_tool",
            },
            dependencies,
          );
          return runtimeText(
            `Remembered durable image ${result.anchor.customId} (provider document ${result.providerDocumentId}).`,
          );
        } catch (error) {
          return providerFailure("remember the image", error);
        }
      },
    ),
  ];
}

export function createMemoryMcp(input: string | CreateMemoryToolsOptions) {
  return createClaudeMcpServer(
    NAMESPACE,
    typeof input === "string" ? createMemoryTools(input) : createMemoryTools(input),
  );
}
