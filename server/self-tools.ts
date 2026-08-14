import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import {
  CURATED_TOOLKITS,
  listConnectedToolkits,
  listToolkitMeta,
  listToolsForToolkit,
} from "./composio.js";
import { readMemoryProviderConfiguration } from "./memory/supermemory/client.js";
import { ensureMemoryIdentityRuntime } from "./memory/supermemory/primary-owner.js";
import type { MemoryProviderConfiguration } from "./memory/supermemory/types.js";
import { listEnabledIntegrations } from "./integrations/registry.js";
import { createClaudeMcpServer } from "./runtimes/claude.js";
import { defineRuntimeTool } from "./runtimes/tool.js";
import { runtimeText, type RuntimeReasoningEffort, type RuntimeTool } from "./runtimes/types.js";
import {
  CODEX_MODEL_ALIASES,
  KNOWN_CODEX_MODELS,
  KNOWN_MODELS,
  MODEL_ALIASES,
  RUNTIME_ALIASES,
  getRuntimeConfig,
  getBrowserSettings,
  resolveModelInput,
  resolveRuntimeInput,
  setCodexReasoningEffort,
  setRuntimeModel,
  setRuntimeProvider,
} from "./runtime-config.js";
import {
  describeUserNow,
  resolveTimezoneInput,
  setUserTimezone,
} from "./timezone-config.js";

const NAMESPACE = "daniel-self";

const reasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

type MemoryProviderHealth =
  | "unconfigured"
  | "recovery_required"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown";

interface MemoryProviderDeploymentState {
  healthStatus: Exclude<MemoryProviderHealth, "unknown"> | null;
  lastSuccessfulSubmissionAt: number | null;
  lastFailedSubmissionAt: number | null;
  hasError: boolean;
  lastWorkerActivityAt: number | null;
  updatedAt: number | null;
}

export interface MemorySyncBacklogStatus {
  pending: number;
  processing: number;
  submitted: number;
  completed: number;
  failed: number;
  deadLetter: number;
  active: number;
  total: number;
  truncated: boolean;
}

export interface MemoryProviderOperationalStatus {
  providerState: MemoryProviderDeploymentState | null;
  syncBacklog: MemorySyncBacklogStatus | null;
  providerStateAvailable: boolean;
  syncBacklogAvailable: boolean;
}

interface MemoryStatusClient {
  query(reference: unknown, args: Record<string, never>): Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  const nested = asRecord(value);
  const count = typeof value === "number" ? value : nested?.count;
  return typeof count === "number" && Number.isFinite(count)
    ? Math.max(0, Math.floor(count))
    : 0;
}

function normalizeProviderState(value: unknown): MemoryProviderDeploymentState | null {
  const state = asRecord(value);
  if (!state) return null;
  const rawHealth = state.healthStatus;
  const healthStatus =
    rawHealth === "unconfigured" ||
    rawHealth === "recovery_required" ||
    rawHealth === "healthy" ||
    rawHealth === "degraded" ||
    rawHealth === "unavailable"
      ? rawHealth
      : null;
  return {
    healthStatus,
    lastSuccessfulSubmissionAt: numberOrNull(state.lastSuccessfulSubmissionAt),
    lastFailedSubmissionAt: numberOrNull(state.lastFailedSubmissionAt),
    hasError: state.hasError === true,
    lastWorkerActivityAt: numberOrNull(state.lastWorkerActivityAt),
    updatedAt: numberOrNull(state.updatedAt),
  };
}

function normalizeSyncBacklog(value: unknown): MemorySyncBacklogStatus | null {
  const backlog = asRecord(value);
  if (!backlog) return null;
  const counts = asRecord(backlog.counts) ?? backlog;
  const pending = nonNegativeCount(counts, "pending");
  const processing = nonNegativeCount(counts, "processing");
  const submitted = nonNegativeCount(counts, "submitted");
  const completed = nonNegativeCount(counts, "completed");
  const failed = nonNegativeCount(counts, "failed");
  const deadLetter = Math.max(
    nonNegativeCount(counts, "deadLetter"),
    nonNegativeCount(counts, "dead_letter"),
  );
  return {
    pending,
    processing,
    submitted,
    completed,
    failed,
    deadLetter,
    active:
      numberOrNull(backlog.active) ?? pending + processing + submitted + failed,
    total:
      numberOrNull(backlog.total) ??
      pending + processing + submitted + completed + failed + deadLetter,
    truncated: backlog.truncated === true,
  };
}

/** Reads the durable provider-state and outbox modules without calling Supermemory. */
export async function readMemoryProviderOperationalStatus(
  client?: MemoryStatusClient,
): Promise<MemoryProviderOperationalStatus> {
  const queries = client
    ? [
        client.query(api.memoryProviderState.getDeploymentState, {}),
        client.query(api.memorySyncJobs.backlog, {}),
      ]
    : await import("./convex-client.js").then(({ convex }) => [
        convex.query(api.memoryProviderState.getDeploymentState, {}),
        convex.query(api.memorySyncJobs.backlog, {}),
      ]);
  const [providerStateResult, syncBacklogResult] = await Promise.allSettled(queries);
  return {
    providerState:
      providerStateResult.status === "fulfilled"
        ? normalizeProviderState(providerStateResult.value)
        : null,
    syncBacklog:
      syncBacklogResult.status === "fulfilled"
        ? normalizeSyncBacklog(syncBacklogResult.value)
        : null,
    providerStateAvailable: providerStateResult.status === "fulfilled",
    syncBacklogAvailable: syncBacklogResult.status === "fulfilled",
  };
}

export function buildMemoryRuntimeStatus(
  memory: MemoryProviderConfiguration,
  operational: MemoryProviderOperationalStatus,
  identityStatus?: "ready" | "unconfigured" | "recovery_required" | "unknown",
) {
  const memoryProviderHealth: MemoryProviderHealth =
    !memory.apiKeyConfigured
      ? "unconfigured"
      : identityStatus === "recovery_required" || identityStatus === "unconfigured"
        ? identityStatus
        : (operational.providerState?.healthStatus ?? "unknown");
  const identityReady =
    identityStatus === undefined || identityStatus === "ready";
  const captureConfigured =
    memory.apiKeyConfigured &&
    identityReady &&
    memoryProviderHealth !== "recovery_required" &&
    memoryProviderHealth !== "unconfigured";

  return {
    memoryProvider: "supermemory" as const,
    memoryProviderHealth,
    memoryCaptureKind: captureConfigured ? "conversation_turn" : null,
    memorySyncBacklog: operational.syncBacklog,
    memoryLastProviderSuccessAt:
      operational.providerState?.lastSuccessfulSubmissionAt ?? null,
    memoryLastProviderFailureAt:
      operational.providerState?.lastFailedSubmissionAt ?? null,
    memoryProviderHasError: operational.providerState?.hasError ?? false,
    memoryLastWorkerActivityAt:
      operational.providerState?.lastWorkerActivityAt ?? null,
    memoryProviderStateUpdatedAt: operational.providerState?.updatedAt ?? null,
    memoryProviderStateAvailable: operational.providerStateAvailable,
    memorySyncBacklogAvailable: operational.syncBacklogAvailable,
    supermemoryConfigured: memory.apiKeyConfigured,
  };
}

export function createSelfTools(): RuntimeTool[] {
  return [
    defineRuntimeTool(
      NAMESPACE,
      "get_config",
      "Return Daniel's runtime configuration: active provider, model, billing mode, user's timezone, current local time, loaded integrations, and basic env info. Use when the user asks what model/provider/runtime Daniel is using, what time it is, what timezone is active, or anything about the agent itself.",
      {},
      async () => {
        const integrations = (await listEnabledIntegrations()).map((i) => i.name);
        const tzInfo = await describeUserNow();
        const runtime = await getRuntimeConfig();
        const browser = await getBrowserSettings();
        const memory = readMemoryProviderConfiguration();
        const identityStatus = memory.apiKeyConfigured
          ? await ensureMemoryIdentityRuntime()
              .then((result) => result.status)
              .catch(() => "unknown" as const)
          : ("unconfigured" as const);
        const memoryStatus = buildMemoryRuntimeStatus(
          memory,
          await readMemoryProviderOperationalStatus(),
          identityStatus,
        );
        const config = {
          runtime: runtime.runtime,
          model: runtime.model,
          reasoningEffort: runtime.reasoningEffort ?? null,
          billingMode: runtime.billingMode,
          claudeEnvDefault: process.env.DANIEL_MODEL ?? "claude-sonnet-4-6",
          codexEnvDefault: process.env.DANIEL_CODEX_MODEL ?? "gpt-5.5",
          availableClaudeModels: [...KNOWN_MODELS],
          availableCodexModels: [...KNOWN_CODEX_MODELS],
          userTimezone: tzInfo.isExplicit ? tzInfo.timezone : null,
          timezoneFallback: tzInfo.isExplicit ? null : tzInfo.timezone,
          currentLocalTime: tzInfo.now,
          integrationsLoaded: integrations,
          integrationCount: integrations.length,
          browser: {
            enabled: browser.enabled,
            showUi: browser.showUi,
            loginHandoffEnabled: browser.loginHandoffEnabled,
            profileDir: browser.profileDir,
            startUrl: browser.startUrl || null,
            channel: browser.channel,
            executablePath: browser.executablePath || null,
            extraArgs: browser.extraArgs,
          },
          composioEnabled: Boolean(process.env.COMPOSIO_API_KEY),
          ...memoryStatus,
          photonEnabled: Boolean(process.env.PHOTON_PROJECT_ID && process.env.PHOTON_PROJECT_SECRET),
        };
        return runtimeText(JSON.stringify(config, null, 2));
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_timezone",
      `Save the user's timezone so Daniel can reason about deadlines, "today", "9am tomorrow", and other local-time references correctly. Accepts an IANA timezone ID (e.g. "America/Chicago", "Europe/London") or a friendly alias ("central", "PT", "Dallas", "Tokyo", "UTC", etc.).

Use when the user tells you their timezone or location ("I'm in Dallas", "use central time", "I'm in London"), or proactively after asking when get_config returns a null userTimezone and you need local-time context for the user's request. Don't guess from prior messages — if you're unsure, just ask once.`,
      {
        timezone: z
          .string()
          .describe(
            'Timezone the user just told you. IANA format like "America/New_York" or alias like "eastern" / "Dallas".',
          ),
      },
      async ({ timezone }) => {
        const resolved = resolveTimezoneInput(timezone);
        if (!resolved) {
          return runtimeText(
            `"${timezone}" isn't a recognized timezone or alias. Pass a canonical IANA ID like "America/Chicago" / "Europe/London" / "Asia/Tokyo", or a friendly name like "central" / "pacific" / "London" / "Tokyo". Ask the user to clarify if needed.`,
            false,
          );
        }
        await setUserTimezone(resolved);
        const tzInfo = await describeUserNow();
        return runtimeText(
          `User timezone set to ${resolved}. Local time there is now ${tzInfo.now}. This will be used for all future date/time reasoning.`,
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_runtime",
      `Switch Daniel's provider/runtime for future turns. The change applies to the next top-level turn. Accepts aliases: ${Object.keys(RUNTIME_ALIASES)
        .map((k) => `"${k}"`)
        .join(", ")}. Use "claude" for the Anthropic Claude Agent SDK provider and "codex" for the local Codex app-server provider backed by the user's ChatGPT/Codex subscription.`,
      { runtime: z.string().describe('Runtime/provider to use, e.g. "claude" or "codex".') },
      async ({ runtime }) => {
        const resolved = resolveRuntimeInput(runtime);
        if (!resolved) {
          return runtimeText(
            `Unknown runtime "${runtime}". Try one of: ${Object.keys(RUNTIME_ALIASES).join(", ")}.`,
            false,
          );
        }
        await setRuntimeProvider(resolved);
        return runtimeText(
          `Runtime set to ${resolved}. Next top-level turn will use ${resolved}; this current turn keeps the provider it started with.`,
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_model",
      `Switch the model for the currently active runtime. The change applies to the next top-level turn; this turn keeps the model it started with.

Claude aliases: ${Object.keys(MODEL_ALIASES).map((k) => `"${k}"`).join(", ")}
Claude canonical: ${[...KNOWN_MODELS].map((k) => `"${k}"`).join(", ")}
Codex aliases: ${Object.keys(CODEX_MODEL_ALIASES).map((k) => `"${k}"`).join(", ")}
Codex canonical: ${[...KNOWN_CODEX_MODELS].map((k) => `"${k}"`).join(", ")}

Use when the user says "use opus", "switch to sonnet", "use Codex mini", "make it faster", etc.`,
      {
        model: z
          .string()
          .describe('Model to use. Canonical ID like "claude-opus-4-7" or "gpt-5.4-mini", or an alias.'),
      },
      async ({ model }) => {
        const runtime = (await getRuntimeConfig()).runtime;
        const resolved = resolveModelInput(model, runtime);
        if (!resolved) {
          const known = runtime === "codex" ? [...KNOWN_CODEX_MODELS] : [...KNOWN_MODELS];
          const aliases = runtime === "codex" ? CODEX_MODEL_ALIASES : MODEL_ALIASES;
          return runtimeText(
            `Unknown ${runtime} model "${model}". Try one of: ${known.join(", ")} or aliases ${Object.keys(aliases).join(", ")}.`,
            false,
          );
        }
        await setRuntimeModel(resolved, runtime);
        return runtimeText(
          `${runtime} model override set to ${resolved}. Next top-level turn will use it; this current turn keeps the previous model.`,
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "set_codex_reasoning_effort",
      "Set Codex reasoning effort for future Codex turns. Use low for speed, medium for default work, high/xhigh for deeper work.",
      { effort: reasoningEffortSchema },
      async ({ effort }) => {
        await setCodexReasoningEffort(effort as RuntimeReasoningEffort);
        return runtimeText(`Codex reasoning effort set to ${effort}. Next Codex turn will use it.`);
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "list_integrations",
      "List the user's currently connected integrations (Gmail, Slack, etc.) with the actual account behind each connection. Use when the user asks 'what tools do I have connected?' or 'which Gmail account?' or 'what integrations are set up?'.",
      {},
      async () => {
        const connected = await listConnectedToolkits();
        const summary = connected.map((c) => ({
          slug: c.slug,
          status: c.status,
          account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
          connectionId: c.connectionId,
        }));
        return runtimeText(
          summary.length === 0
            ? "No integrations are currently connected. The user can connect new ones from the Connections panel in the debug UI."
            : JSON.stringify(summary, null, 2),
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "search_composio_catalog",
      "Search Composio's full toolkit catalog (1000+ services) by keyword. Returns matching toolkit slugs and descriptions. Use when the user asks 'is there a tool for X?', 'can you connect to Y?', or 'is Z available?' — e.g. 'is there a Notion integration?', 'can you talk to Zendesk?'.",
      {
        query: z
          .string()
          .describe("Keyword to match against toolkit slug, name, or description (case-insensitive)."),
        limit: z.number().int().min(1).max(50).optional().default(15),
      },
      async ({ query, limit }) => {
        const meta = await listToolkitMeta();
        const q = query.trim().toLowerCase();
        const matches: Array<{ slug: string; name: string; description?: string; toolsCount?: number }> = [];
        for (const t of meta.values()) {
          const haystack = `${t.slug} ${t.name} ${t.description ?? ""}`.toLowerCase();
          if (haystack.includes(q)) {
            matches.push({
              slug: t.slug,
              name: t.name,
              description: t.description,
              toolsCount: t.toolsCount,
            });
          }
          if (matches.length >= limit) break;
        }
        return runtimeText(
          matches.length === 0
            ? `No toolkits in Composio's catalog match "${query}".`
            : JSON.stringify(matches, null, 2),
        );
      },
    ),
    defineRuntimeTool(
      NAMESPACE,
      "inspect_toolkit",
      "Look up a specific Composio toolkit by exact slug. Returns whether it exists, whether it's currently connected, and (if requested) the list of tools it exposes. Use when the user asks 'what can the Slack tool do?' or 'is Notion connected?'.",
      {
        slug: z
          .string()
          .describe("Exact toolkit slug, e.g. 'gmail', 'slack', 'notion', 'linear'. Lowercase."),
        includeTools: z
          .boolean()
          .optional()
          .default(false)
          .describe("If true, also fetch the toolkit's tool list (slower)."),
      },
      async ({ slug, includeTools }) => {
        const lower = slug.trim().toLowerCase();
        const meta = await listToolkitMeta();
        const toolkit = meta.get(lower);
        if (!toolkit) {
          return runtimeText(
            `Toolkit "${lower}" is not in Composio's catalog. Try search_composio_catalog with a keyword to find similar ones.`,
            false,
          );
        }
        const connected = (await listConnectedToolkits()).filter((c) => c.slug === lower);
        const curated = CURATED_TOOLKITS.find((t) => t.slug === lower);
        const result: {
          slug: string;
          name: string;
          description?: string;
          toolsCount?: number;
          inCuratedList: boolean;
          authMode?: string;
          connections: Array<{ status: string; account: string; id: string }>;
          availableForSpawn: boolean;
          tools?: Array<{ slug: string; name: string; description?: string }>;
        } = {
          slug: toolkit.slug,
          name: toolkit.name,
          description: toolkit.description,
          toolsCount: toolkit.toolsCount,
          inCuratedList: Boolean(curated),
          authMode: curated?.authMode,
          connections: connected.map((c) => ({
            status: c.status,
            account: c.accountLabel ?? c.accountEmail ?? c.alias ?? "(unknown)",
            id: c.connectionId,
          })),
          availableForSpawn: (await listEnabledIntegrations()).some((i) => i.name === lower),
        };
        if (includeTools) {
          result.tools = await listToolsForToolkit(lower);
        }
        return runtimeText(JSON.stringify(result, null, 2));
      },
    ),
  ];
}

export function createSelfMcp() {
  return createClaudeMcpServer(NAMESPACE, createSelfTools());
}
