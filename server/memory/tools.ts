import { z } from "zod";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool, type RuntimeToolResult } from "../runtimes/types.js";
import { SupermemoryService } from "./supermemory/service.js";

const NAMESPACE = "daniel-memory";
const DEFAULT_TOOL_SEARCH_LIMIT = 8;
const staticKindEnum = z.enum([
  "preferred_name",
  "core_identity",
  "long_term_role",
  "home_timezone",
]);

export interface CreateMemoryToolsOptions {
  service: SupermemoryService;
  /** Exact current-turn images the dispatcher may make durable. */
  imageStorageIds?: readonly string[];
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

export function createMemoryTools(options: CreateMemoryToolsOptions): RuntimeTool[] {
  const eligibleImageStorageIds = new Set(options.imageStorageIds ?? []);
  const eligibleImageDescription =
    eligibleImageStorageIds.size > 0
      ? [...eligibleImageStorageIds].join(", ")
      : "(no current-turn images)";

  return [
    defineRuntimeTool(
      NAMESPACE,
      "remember_memory",
      "Persist one exact durable fact in Supermemory for future turns. Use for durable identity, preferences, projects, relationships, or knowledge, not transient conversation state.",
      {
        content: z
          .string()
          .min(1)
          .max(10_000)
          .describe("The exact fact to remember, in one clear sentence."),
        staticKind: staticKindEnum
          .optional()
          .describe(
            "Only for an explicitly durable preferred name, identity, long-term role, or home timezone.",
          ),
      },
      async (args) => {
        try {
          const result = await options.service.rememberExact(args);
          const ids = result.memories.map((memory) => memory.id).join(", ");
          return runtimeText(`Remembered exact Supermemory ${ids || "memory"}.`);
        } catch (error) {
          return providerFailure("remember that fact", error);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "recall",
      "Run an optional narrow Supermemory query. Context is already preloaded; use this only for a specific follow-up search.",
      {
        query: z.string().min(1).describe("A specific topic or fact to search for."),
        limit: z.number().int().min(1).max(20).optional().default(DEFAULT_TOOL_SEARCH_LIMIT),
      },
      async (args) => {
        const result = await options.service.recall(args.query);
        if (result.status === "failed") return providerFailure("recall memory", result.error);
        if (result.results.length === 0) return runtimeText("No memories matched.");
        return runtimeText(
          result.results
            .slice(0, args.limit)
            .map(
              (memory) =>
                `• [relevance=${memory.similarity.toFixed(2)}] ${memory.id}: ${memory.content}`,
            )
            .join("\n"),
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "update_memory",
      "Search for candidate Supermemory entries or update one selected exact memory ID as a new version.",
      {
        query: z.string().min(1).optional().describe("Search text used only to list candidates."),
        memoryId: z.string().min(1).optional().describe("The exact memory ID selected for update."),
        newContent: z.string().min(1).max(10_000).optional().describe("The corrected complete memory content."),
        limit: z.number().int().min(1).max(8).optional().default(DEFAULT_TOOL_SEARCH_LIMIT),
      },
      async (args) => {
        try {
          if (!args.memoryId) {
            if (!args.query || args.newContent) {
              return runtimeText(
                "Provide only query to list candidates, then call update_memory with memoryId and newContent.",
                false,
              );
            }
            const candidates = await options.service.searchUpdateCandidates({
              query: args.query,
              limit: args.limit,
            });
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
          const result = await options.service.updateExact({
            memoryId: args.memoryId,
            newContent: args.newContent,
          });
          return runtimeText(result.confirmation);
        } catch (error) {
          return providerFailure("update memory", error);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "forget_memory",
      "Preview matching memories, then forget only the exact IDs stored in that preview after user confirmation.",
      {
        query: z.string().min(1).optional().describe("Stage 1 semantic forget request."),
        operationId: z.string().min(1).optional().describe("Stage 2 pending operation ID."),
        confirm: z.boolean().optional().default(false).describe("True only after explicit confirmation."),
        reason: z.string().max(1_000).optional(),
        maxForget: z.number().int().min(1).max(100).optional().default(25),
      },
      async (args) => {
        try {
          if (args.confirm) {
            if (!args.operationId || args.query) {
              return runtimeText(
                "Confirmation requires only the stored operationId; the semantic query must not be rerun.",
                false,
              );
            }
            const result = await options.service.confirmForget({
              operationId: args.operationId,
              reason: args.reason,
            });
            return runtimeText(result.confirmation);
          }
          if (!args.query || args.operationId) {
            return runtimeText(
              "Start with query to create a forget preview, or confirm a prior operationId.",
              false,
            );
          }
          const result = await options.service.previewForget({
            query: args.query,
            reason: args.reason,
            maxForget: args.maxForget,
          });
          if (!result.operationId) return runtimeText(result.preview);
          return runtimeText(
            `${result.preview}\n\nPending operation: ${result.operationId}\nExpires: ${
              result.expiresAt ? new Date(result.expiresAt).toISOString() : "unavailable"
            }`,
          );
        } catch (error) {
          return providerFailure("forget memory", error);
        }
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "remember_image",
      "Make one explicitly selected current-turn image durable in Supermemory.",
      {
        storageId: z
          .string()
          .min(1)
          .describe(`Exact current-turn image storage ID. Available: ${eligibleImageDescription}`),
      },
      async (args) => {
        if (!eligibleImageStorageIds.has(args.storageId)) {
          return runtimeText(
            "That image is not attached to the current user turn, so it cannot be made durable.",
            false,
          );
        }
        try {
          const result = await options.service.rememberImage({ storageId: args.storageId });
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
