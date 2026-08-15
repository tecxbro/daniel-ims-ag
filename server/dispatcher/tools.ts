import { z } from "zod";
import { createAutomationTools } from "../automation-tools.js";
import {
  spawnCodingAgent,
  type SpawnCodingAgentResult,
} from "../coding-agent.js";
import { createDraftDecisionTools } from "../draft-tools.js";
import { spawnExecutionAgent } from "../execution-agent.js";
import { createMemoryTools } from "../memory/tools.js";
import type { SupermemoryService } from "../memory/supermemory/service.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { defineRuntimeTool } from "../runtimes/tool.js";
import { runtimeText, type RuntimeTool } from "../runtimes/types.js";
import { createSelfTools } from "../self-tools.js";
import type { CodingResponseStyle } from "../coding/response-style.js";
import { validateIntegrationNames } from "../integrations/registry.js";
import { resolveSpawnIntegrations } from "./gates.js";
import { codingStyleInstruction } from "./policy.js";
import type { DispatcherToolFamily } from "./scope.js";

const MODEL_ROUTED_SELF_TOOLS = new Set([
  // Complex scheduling turns may still need current timezone/config context.
  "get_config",
  // Catalog and capability questions require arguments/details that are not
  // safe to infer with the deterministic exact-message gates.
  "search_composio_catalog",
  "inspect_toolkit",
]);

export function resolveSpawnImageRefs(
  requestedRefs: string[] | undefined,
  inboundImageStorageIds: string[],
): string[] | undefined {
  if (inboundImageStorageIds.length === 0) return undefined;
  const selected = requestedRefs?.filter((id) =>
    inboundImageStorageIds.includes(id),
  );
  return selected && selected.length > 0 ? selected : inboundImageStorageIds;
}

function formatCodingToolResult(
  result: SpawnCodingAgentResult,
  style: CodingResponseStyle,
): string {
  return [
    `[coding ${result.projectId} ${result.status}]`,
    codingStyleInstruction(style),
    "",
    result.result,
  ].join("\n");
}

export interface CreateDispatcherToolsInput {
  conversationId: string;
  content: string;
  kind?: "user" | "proactive";
  integrations: string[];
  inboundImageStorageIds: string[];
  spawnableImageStorageIds: string[];
  memoryService: SupermemoryService | null;
  runtimeConfig: RuntimeConfig;
  codingResponseStyle: CodingResponseStyle;
  toolFamilies: readonly DispatcherToolFamily[];
  sendAcknowledgement?: (message: string) => Promise<void>;
  persistAcknowledgement: (message: string) => Promise<void>;
  log: (message: string) => void;
}

export interface DispatcherToolsResult {
  tools: RuntimeTool[];
  lastCodingResult: { current: SpawnCodingAgentResult | null };
}

export function createDispatcherTools(
  input: CreateDispatcherToolsInput,
): DispatcherToolsResult {
  const hasFamily = (family: DispatcherToolFamily): boolean =>
    input.toolFamilies.includes(family);
  const lastCodingResult: { current: SpawnCodingAgentResult | null } = {
    current: null,
  };
  const sendAck = async (message: string): Promise<void> => {
    const text = message.trim();
    if (!text) return;
    if (input.conversationId.startsWith("sms:") && input.kind !== "proactive") {
      await input.sendAcknowledgement?.(text);
    }
    await input.persistAcknowledgement(text);
    input.log(`→ ack: ${text}`);
  };

  const tools: RuntimeTool[] = [
    ...(hasFamily("memory") && input.memoryService
      ? createMemoryTools({
          service: input.memoryService,
          imageStorageIds: input.inboundImageStorageIds,
        })
      : []),
    ...(hasFamily("automation")
      ? createAutomationTools(input.conversationId)
      : []),
    ...(hasFamily("draft")
      ? createDraftDecisionTools(input.conversationId, input.runtimeConfig)
      : []),
    ...(hasFamily("self")
      ? createSelfTools().filter((tool) =>
          MODEL_ROUTED_SELF_TOOLS.has(tool.name),
        )
      : []),
    ...(hasFamily("spawn")
      ? [
          defineRuntimeTool(
            "daniel-ack",
            "send_ack",
            `Send a short acknowledgment message to the user IMMEDIATELY, before a slow operation. Use this BEFORE spawn_agent so the user knows you heard them and are working on it. Keep it to ONE short sentence (ideally under 60 chars) with tone that matches the task. Examples: "On it — one sec.", "Checking now.", "Drafting that.", "Let me check your calendar."`,
            {
              message: z
                .string()
                .describe(
                  "1 short sentence ack. No markdown. Emojis only if the user used emojis recently.",
                ),
            },
            async (args) => {
              const text = args.message.trim();
              if (!text) return runtimeText("Empty ack skipped.");
              await sendAck(text);
              return runtimeText("Ack sent to user.");
            },
          ),
        ]
      : []),
    ...(hasFamily("coding")
      ? [
          defineRuntimeTool(
            "daniel-coding",
            "spawn_coding_agent",
            "Spawn Daniel's full Codex coding bridge for software work: build apps, edit/debug code, generate files, connect repos, run tests, deploy, create PRs, build landing pages/backends/databases, or build Photon/Spectrum/iMessage agents. Do not use for normal non-coding personal-assistant tasks.",
            {
              task: z
                .string()
                .describe(
                  "Specific coding task to plan, build, edit, debug, test, or deploy.",
                ),
              projectHint: z
                .string()
                .optional()
                .describe("Short project/app name if the user provided one."),
              repoUrl: z
                .string()
                .optional()
                .describe(
                  "Git repository URL to clone or continue from, if provided.",
                ),
              mode: z
                .enum(["auto", "plan", "build", "debug"])
                .optional()
                .describe(
                  "auto is default. Use plan for new apps/major features, debug for bug fixes, build for small direct edits.",
                ),
              attachments: z
                .array(z.string())
                .optional()
                .describe(
                  "Attachment identifiers or names relevant to the coding task.",
                ),
            },
            async (args) => {
              const res = await spawnCodingAgent({
                task: args.task,
                conversationId: input.conversationId,
                projectHint: args.projectHint,
                repoUrl: args.repoUrl,
                mode: args.mode ?? "auto",
                runtimeConfig: input.runtimeConfig,
              });
              lastCodingResult.current = res;
              return runtimeText(
                formatCodingToolResult(res, input.codingResponseStyle),
              );
            },
          ),
        ]
      : []),
    ...(hasFamily("spawn")
      ? [
          defineRuntimeTool(
            "daniel-spawn",
            "spawn_agent",
            "Spawn a focused sub-agent to do real work using external tools. Returns the agent's final answer. Use for integrations, world actions, file/system access, or lookups that need live/current information. Do not spawn for questions answerable from knowledge unless the answer would go stale without a fresh lookup. If the current user message includes images and the sub-agent's task depends on them, pass the relevant storage IDs in imageRefs. On image turns, Daniel attaches all current-turn images by default; a non-empty imageRefs list can narrow to a subset.",
            {
              task: z
                .string()
                .describe(
                  "Crisp task description — what to find/draft/do, not the raw user message.",
                ),
              integrations: z
                .array(z.string())
                .describe(
                  `Which integrations to give the agent. Available: ${input.integrations.join(", ") || "(none)"}`,
                ),
              name: z
                .string()
                .optional()
                .describe("Short label for the agent."),
              imageRefs: z
                .array(z.string())
                .optional()
                .describe(
                  "Convex storage IDs from the user's current message. Available in this turn: " +
                    (input.spawnableImageStorageIds.length > 0
                      ? input.spawnableImageStorageIds.join(", ")
                      : "(none)"),
                ),
            },
            async (args) => {
              const imageStorageIds = resolveSpawnImageRefs(
                args.imageRefs,
                input.spawnableImageStorageIds,
              );
              let requestedIntegrations: string[];
              try {
                requestedIntegrations = validateIntegrationNames(
                  args.integrations,
                  input.integrations,
                );
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : "Invalid integration selection.";
                return runtimeText(`Worker not started: ${message}`, false);
              }
              const selectedIntegrations = resolveSpawnIntegrations(
                requestedIntegrations,
                input.integrations,
                input.content,
              );
              const browserForced =
                selectedIntegrations.length === 1 &&
                selectedIntegrations[0] === "browser" &&
                !requestedIntegrations.includes("browser");
              if (browserForced) {
                input.log(
                  `forcing browser integration for explicit browser request (model requested: ${requestedIntegrations.join(",") || "none"})`,
                );
              }
              const res = await spawnExecutionAgent({
                task: args.task,
                integrations: selectedIntegrations,
                conversationId: input.conversationId,
                name: args.name,
                runtimeConfig: input.runtimeConfig,
                imageStorageIds,
              });
              return runtimeText(
                `[agent ${res.agentId} ${res.status}]\n\n${res.result}`,
              );
            },
          ),
        ]
      : []),
  ];

  return { tools, lastCodingResult };
}

export function dispatcherAllowedTools(
  tools: readonly RuntimeTool[],
): string[] {
  return tools.map((tool) => `mcp__${tool.namespace}__${tool.name}`);
}
