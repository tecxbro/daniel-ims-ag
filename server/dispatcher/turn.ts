import { api } from "../../convex/_generated/api.js";
import { broadcast } from "../broadcast.js";
import { continueCodingAgentWithAnswer } from "../coding-agent.js";
import {
  CODING_RESPONSE_STYLE_KEY,
  resolveCodingResponseStyle,
  type CodingResponseStyle,
} from "../coding/response-style.js";
import { convex } from "../convex-client.js";
import { finalizeAssistantTurnCapture } from "../memory/supermemory/capture-recovery.js";
import { readMemoryProviderConfiguration } from "../memory/supermemory/client.js";
import type { MemoryContextInstrumentationEvent } from "../memory/supermemory/context.js";
import { deriveMemoryIdentity } from "../memory/supermemory/identity.js";
import { ensureMemoryIdentityRuntime } from "../memory/supermemory/primary-owner.js";
import {
  createConfiguredSupermemoryService,
  type SupermemoryService,
} from "../memory/supermemory/service.js";
import type {
  HandleOpts as MemoryHandleOpts,
  MemoryProviderConfiguration,
} from "../memory/supermemory/types.js";
import { recordProviderRead } from "../memory/supermemory/provider-observability.js";
import { listEnabledIntegrations } from "../integrations/registry.js";
import {
  getBrowserSettings,
  getRuntimeConfig,
  type RuntimeConfig,
} from "../runtime-config.js";
import { runAgentRuntime } from "../runtimes/index.js";
import { EMPTY_USAGE, type UsageTotals } from "../usage.js";
import {
  buildPromptWithImagesOrTextFallback,
  fetchStoredBytes,
} from "../images/content-blocks.js";
import { explicitlyRequestsBrowser, proactiveNoticeReply } from "./gates.js";
import {
  buildConversationPrompt,
  buildHistoryBlock,
  buildTurnUserText,
  composePreloadedMemoryPrompt,
  type DispatcherHistoryTurn,
} from "./history.js";
import {
  buildInteractionSystemPrompt,
  DISPATCHER_DISALLOWED_TOOLS,
} from "./policy.js";
import { handleDeterministicConfiguration } from "./deterministic.js";
import { resolveDispatcherToolScope } from "./scope.js";
import { createDispatcherTools, dispatcherAllowedTools } from "./tools.js";

export interface HandleOpts extends MemoryHandleOpts {
  turnTag?: string;
  onThinking?: (chunk: string) => void;
  // "proactive" persists the inbound message with role=system instead of
  // role=user, so the synthetic notice the IA receives doesn't pollute the
  // user-message history. Defaults to "user".
  kind?: "user" | "proactive";
  // The iMessage/proactive callers persist the delivered final message after
  // transport succeeds. Local chat callers still need the assistant turn in
  // Convex so conversation views reflect the full exchange.
  persistAssistantReply?: boolean;
  images?: Array<{ storageId: string; mediaType: string }>;
  mediaError?: string;
  /** Inbound transports use this to keep acknowledgements on the same Space. */
  sendAcknowledgement?: (message: string) => Promise<void>;
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readTurnMemoryConfiguration(): {
  config: MemoryProviderConfiguration;
  error?: unknown;
} {
  try {
    return { config: readMemoryProviderConfiguration() };
  } catch (error) {
    return {
      config: {
        timeoutMs: 1_200,
        threshold: 0.6,
        searchLimit: 8,
        dreaming: "dynamic",
        apiKeyConfigured: false,
      },
      error,
    };
  }
}

async function resolveCodingResponseStyleForTurn(
  conversationId: string,
  content: string,
): Promise<CodingResponseStyle> {
  let storedValue: string | null = null;
  try {
    const stored = await convex.query(api.codingPreferences.getPreference, {
      conversationId,
      key: CODING_RESPONSE_STYLE_KEY,
    });
    storedValue = typeof stored?.value === "string" ? stored.value : null;
  } catch (err) {
    console.warn("[interaction] coding response style lookup failed", err);
  }

  const resolved = resolveCodingResponseStyle({ storedValue, content });
  if (resolved.durableUpdate) {
    try {
      await convex.mutation(api.codingPreferences.storePreference, {
        conversationId,
        key: CODING_RESPONSE_STYLE_KEY,
        value: resolved.durableUpdate,
      });
    } catch (err) {
      console.warn("[interaction] coding response style store failed", err);
    }
  }
  return resolved.style;
}

async function recordDispatcherUsage(args: {
  conversationId: string;
  turnId: string;
  runtimeConfig: RuntimeConfig;
  usage: UsageTotals;
  durationMs: number;
  log: (msg: string) => void;
}): Promise<void> {
  if (args.usage.costUsd === 0 && args.usage.inputTokens === 0) return;
  args.log(
    `cost: in/out ${args.usage.inputTokens}/${args.usage.outputTokens}, cache r/w ${args.usage.cacheReadTokens}/${args.usage.cacheCreationTokens}, $${args.usage.costUsd.toFixed(4)}`,
  );
  await convex.mutation(api.usageRecords.record, {
    source: "dispatcher",
    conversationId: args.conversationId,
    turnId: args.turnId,
    runtime: args.runtimeConfig.runtime,
    billingMode: args.runtimeConfig.billingMode,
    model: args.usage.model,
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    cacheReadTokens: args.usage.cacheReadTokens,
    cacheCreationTokens: args.usage.cacheCreationTokens,
    costUsd: args.usage.costUsd,
    durationMs: args.durationMs,
  });
}

export async function handleUserMessage(opts: HandleOpts): Promise<string> {
  const turnId = opts.turnId ?? randomId("turn");
  const tag = opts.turnTag ?? turnId.slice(-6);
  const log = (msg: string) => console.log(`[turn ${tag}] ${msg}`);
  const inboundRole = opts.kind === "proactive" ? "system" : "user";
  const inboundImageStorageIds = (opts.images ?? []).map((i) => i.storageId);
  const inboundMessageId = await convex.mutation(api.messages.send, {
    conversationId: opts.conversationId,
    role: inboundRole,
    content: opts.content,
    turnId,
    // TODO(codegen): drop cast once schema push regenerates Convex API.
    imageStorageIds:
      inboundImageStorageIds.length > 0
        ? (inboundImageStorageIds as never)
        : undefined,
    mediaError: opts.mediaError,
  });
  broadcast(opts.kind === "proactive" ? "proactive_notice" : "user_message", {
    conversationId: opts.conversationId,
    content: opts.content,
  });

  const finalizeTurnMemory = async (assistantReply: string): Promise<void> => {
    if (opts.kind === "proactive") return;
    // Local callers atomically persist the assistant row and outbox job here.
    // iMessage defers this same operation until its caller confirms delivery.
    if (opts.persistAssistantReply) {
      await finalizeAssistantTurnCapture({
        conversationId: opts.conversationId,
        memoryOwnerId: opts.memoryOwnerId,
        turnId,
        userMessage: opts.content,
        assistantReply,
        imageStorageIds: inboundImageStorageIds,
        kind: opts.kind,
        channel: "local",
      });
    }
  };
  const finishDeterministicRoute = async (
    reply: string,
    route: string,
  ): Promise<string> => {
    log(`deterministic route: ${route}`);
    broadcast("assistant_message", {
      conversationId: opts.conversationId,
      content: reply,
    });
    await finalizeTurnMemory(reply);
    return reply;
  };

  // Trusted proactive callers already supply a concise user-facing summary.
  // Deliver it directly so synthetic notices never load conversation state or
  // reach memory, tools, images, or a model.
  if (opts.kind === "proactive") {
    return finishDeterministicRoute(
      proactiveNoticeReply(opts.content),
      "proactive_notice",
    );
  }

  // A pending coding question owns the next user message, even when that
  // answer looks like a runtime/model setting (for example, "Codex").
  const codingResult = await continueCodingAgentWithAnswer({
    conversationId: opts.conversationId,
    content: opts.content,
  });
  if (codingResult !== null) {
    const codingReply =
      codingResult.result.trim() ||
      (codingResult.status === "failed"
        ? "I hit an error on that coding run."
        : codingResult.status === "waiting_for_user"
          ? "I still need one decision before I can continue."
          : "Done — the coding run finished.");
    return finishDeterministicRoute(codingReply, "pending_coding_answer");
  }

  const directConfiguration = await handleDeterministicConfiguration({
    conversationId: opts.conversationId,
    content: opts.content,
  });
  if (directConfiguration) {
    return finishDeterministicRoute(
      directConfiguration.reply,
      directConfiguration.route,
    );
  }

  if (explicitlyRequestsBrowser(opts.content)) {
    const browser = await getBrowserSettings();
    if (!browser.enabled) {
      return finishDeterministicRoute(
        "Local browser use is off right now. Turn it on in Settings → Local browser use, then resend this and I can use Chrome on your machine.",
        "browser_disabled",
      );
    }
  }

  // Everything below is the model-routed path. Deterministic turns must return
  // above before these history, memory, prompt, tool, and runtime costs begin.
  const memoryInstrumentation = (
    event: MemoryContextInstrumentationEvent,
  ): void => {
    log(
      `${event.name}: ${JSON.stringify({
        operation: event.operation,
        status: event.status,
        latencyMs: event.latencyMs,
        resultCount: event.resultCount,
        profileFactCount: event.profileFactCount,
        errorCode: event.errorCode,
      })}`,
    );
  };
  const loadMemoryContext = async (): Promise<{
    memoryService: SupermemoryService | null;
    formattedContext?: string;
  }> => {
    const memoryConfiguration = readTurnMemoryConfiguration();
    let memoryService: SupermemoryService | null = null;
    if (
      !memoryConfiguration.error &&
      memoryConfiguration.config.apiKeyConfigured
    ) {
      try {
        const identityState = await ensureMemoryIdentityRuntime();
        if (
          identityState.status !== "ready" ||
          !identityState.saltFingerprint
        ) {
          throw new Error(`memory identity ${identityState.status}`);
        }
        const owner = deriveMemoryIdentity(
          {
            conversationId: opts.conversationId,
            memoryOwnerId: opts.memoryOwnerId,
          },
          { expectedSaltFingerprint: identityState.saltFingerprint },
        );
        memoryService = createConfiguredSupermemoryService({
          owner,
          turnId,
          configuration: memoryConfiguration.config,
          instrumentation: memoryInstrumentation,
        });
      } catch (error) {
        log(
          `memory unavailable: ${JSON.stringify({
            errorName: error instanceof Error ? error.name : "UnknownError",
          })}`,
        );
      }
    }
    const hydrationStartedAt = Date.now();
    const runtimeMemory = memoryService
      ? await memoryService.hydrate(opts.content)
      : undefined;
    if (memoryService) {
      await recordProviderRead({
        operation: "hydration",
        startedAt: hydrationStartedAt,
        error: runtimeMemory?.error,
      });
    }
    return {
      memoryService,
      formattedContext: runtimeMemory?.formattedContext,
    };
  };

  const [
    history,
    memoryContext,
    runtimeConfig,
    enabledIntegrations,
    codingResponseStyle,
  ] = await Promise.all([
    convex.query(api.messages.recentCompleteTurns, {
      conversationId: opts.conversationId,
      beforeMessageId: inboundMessageId,
    }),
    loadMemoryContext(),
    getRuntimeConfig(),
    listEnabledIntegrations(),
    resolveCodingResponseStyleForTurn(opts.conversationId, opts.content),
  ]);
  const integrations = enabledIntegrations.map(
    (integration) => integration.name,
  );
  const toolScope = resolveDispatcherToolScope(opts.content, integrations);
  if (toolScope.fallback) {
    log(`tool scope: full fallback (${toolScope.families.join(",")})`);
  } else {
    log(`tool scope: ${toolScope.families.join(",") || "none"}`);
  }
  const memoryService = memoryContext.memoryService;
  const historyBlock = buildHistoryBlock(
    history as readonly DispatcherHistoryTurn[],
  );

  const userText = buildTurnUserText(opts.content, opts.mediaError);
  const conversationPrompt = buildConversationPrompt({
    kind: "user",
    historyBlock,
    userText,
  });
  const promptText = composePreloadedMemoryPrompt(
    conversationPrompt,
    memoryContext.formattedContext,
  );
  const turnStart = Date.now();
  const systemPrompt = buildInteractionSystemPrompt({
    integrations,
    codingResponseStyle,
    memoryEnabled: memoryService !== null,
    toolFamilies: toolScope.families,
  });

  const promptBuild = await buildPromptWithImagesOrTextFallback({
    text: promptText,
    imageStorageIds: inboundImageStorageIds,
    fetchBytes: fetchStoredBytes,
  });
  if (promptBuild.imageError) {
    log(`image fetch fallback: ${promptBuild.imageError}`);
  }

  const { tools, lastCodingResult } = createDispatcherTools({
    conversationId: opts.conversationId,
    content: opts.content,
    kind: opts.kind,
    integrations,
    inboundImageStorageIds,
    spawnableImageStorageIds: promptBuild.imageStorageIds,
    memoryService,
    runtimeConfig,
    codingResponseStyle,
    toolFamilies: toolScope.families,
    sendAcknowledgement: opts.sendAcknowledgement,
    persistAcknowledgement: async (text) => {
      await convex.mutation(api.messages.send, {
        conversationId: opts.conversationId,
        role: "assistant",
        content: text,
      });
      broadcast("assistant_ack", {
        conversationId: opts.conversationId,
        content: text,
      });
    },
    log,
  });
  let reply = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  try {
    const result = await runAgentRuntime(runtimeConfig, {
      prompt: promptBuild.prompt,
      systemPrompt,
      tools,
      mode: "dispatcher",
      allowedTools: dispatcherAllowedTools(tools),
      // Belt-and-suspenders: even with bypassPermissions the SDK can leak
      // its built-ins if we only whitelist. Explicitly block them on the
      // dispatcher so it MUST spawn a sub-agent for external work.
      disallowedTools: DISPATCHER_DISALLOWED_TOOLS,
      onText: (chunk) => opts.onThinking?.(chunk),
      onToolUse: (toolName, input) => {
        const name = toolName.replace(/^mcp__daniel-[a-z-]+__/, "");
        const inputPreview = JSON.stringify(input);
        log(
          `tool: ${name}(${
            inputPreview.length > 90
              ? inputPreview.slice(0, 90) + "…"
              : inputPreview
          })`,
        );
      },
    });
    reply = result.text;
    usage = result.usage;
  } catch (err) {
    console.error(`[turn ${tag}] query failed`, err);
    reply = "Sorry — I hit an error processing that. Try again in a moment.";
  }
  if (codingResponseStyle === "raw_codex" && lastCodingResult.current) {
    reply = lastCodingResult.current.result;
  }

  // Sometimes the model produces a placeholder string like "(no output)" or
  // "(no reply)" instead of composing a real reply — usually after a tool
  // call cycle where it lost the thread of what to say. Treat those as
  // empty so the user gets a real fallback they can act on.
  reply = reply.trim();
  // Match "(no output)" / "no reply." / "(No Response)" etc. Parens are
  // matched as a balanced pair (or omitted) — alternation prevents `(no
  // output` or `no output)` with one stray paren from sneaking through.
  const placeholder =
    /^(?:\(\s*no (?:output|reply|response|content)\s*\)|no (?:output|reply|response|content))\.?$/i;
  if (!reply || placeholder.test(reply)) {
    console.warn(
      `[turn ${tag}] empty/placeholder reply (${JSON.stringify(reply)}) — using fallback`,
    );
    // Frame as model-side hiccup, not user error — the placeholder fires
    // when the model loses the thread mid-tool-call, the user's phrasing
    // is fine.
    reply = "Hmm — got tangled up there. Want to try that again?";
  }

  await recordDispatcherUsage({
    conversationId: opts.conversationId,
    turnId,
    runtimeConfig,
    usage,
    durationMs: Date.now() - turnStart,
    log,
  });

  broadcast("assistant_message", {
    conversationId: opts.conversationId,
    content: reply,
  });

  // Synthetic proactive notices skip durable capture, so email-derived
  // content cannot become user memory.
  await finalizeTurnMemory(reply);

  return reply;
}
