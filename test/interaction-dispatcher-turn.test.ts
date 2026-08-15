import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const endpoints = {
    messages: {
      send: "messages.send",
      recentCompleteTurns: "messages.recentCompleteTurns",
    },
    codingPreferences: {
      getPreference: "codingPreferences.getPreference",
      storePreference: "codingPreferences.storePreference",
    },
    usageRecords: {
      record: "usageRecords.record",
    },
  } as const;
  const runtimeConfig = {
    runtime: "claude" as const,
    model: "claude-fixture",
    billingMode: "api" as const,
  };
  const usage = {
    model: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  const fakeTools = [
    {
      namespace: "fixture-dispatcher",
      name: "fixture_tool",
      description: "Inert dispatcher tool fixture.",
      inputSchema: {},
      jsonSchema: {},
      handle: vi.fn(async () => ({ text: "fixture result" })),
    },
  ];

  return {
    endpoints,
    runtimeConfig,
    usage,
    fakeTools,
    convexMutation: vi.fn(),
    convexQuery: vi.fn(),
    broadcast: vi.fn(),
    continueCodingAgentWithAnswer: vi.fn(),
    finalizeAssistantTurnCapture: vi.fn(),
    readMemoryProviderConfiguration: vi.fn(),
    ensureMemoryIdentityRuntime: vi.fn(),
    deriveMemoryIdentity: vi.fn(),
    createConfiguredSupermemoryService: vi.fn(),
    memoryHydrate: vi.fn(),
    recordProviderRead: vi.fn(),
    listEnabledIntegrations: vi.fn(),
    listConnectedToolkits: vi.fn(),
    getBrowserSettings: vi.fn(),
    getRuntimeConfig: vi.fn(),
    setCodexReasoningEffort: vi.fn(),
    setRuntimeModel: vi.fn(),
    setRuntimeProvider: vi.fn(),
    describeUserNow: vi.fn(),
    setUserTimezone: vi.fn(),
    runAgentRuntime: vi.fn(),
    buildPromptWithImagesOrTextFallback: vi.fn(),
    fetchStoredBytes: vi.fn(),
    createDispatcherTools: vi.fn(),
    dispatcherAllowedTools: vi.fn(),
    resolveSpawnImageRefs: vi.fn(),
  };
});

vi.mock("../convex/_generated/api.js", () => ({ api: fixtures.endpoints }));

vi.mock("../server/convex-client.js", () => ({
  convex: {
    mutation: fixtures.convexMutation,
    query: fixtures.convexQuery,
  },
}));

vi.mock("../server/broadcast.js", () => ({ broadcast: fixtures.broadcast }));

vi.mock("../server/coding-agent.js", () => ({
  continueCodingAgentWithAnswer: fixtures.continueCodingAgentWithAnswer,
}));

vi.mock("../server/memory/supermemory/capture-recovery.js", () => ({
  finalizeAssistantTurnCapture: fixtures.finalizeAssistantTurnCapture,
}));

vi.mock("../server/memory/supermemory/client.js", () => ({
  readMemoryProviderConfiguration: fixtures.readMemoryProviderConfiguration,
}));

vi.mock("../server/memory/supermemory/primary-owner.js", () => ({
  ensureMemoryIdentityRuntime: fixtures.ensureMemoryIdentityRuntime,
}));

vi.mock("../server/memory/supermemory/identity.js", () => ({
  deriveMemoryIdentity: fixtures.deriveMemoryIdentity,
}));

vi.mock("../server/memory/supermemory/service.js", () => ({
  createConfiguredSupermemoryService:
    fixtures.createConfiguredSupermemoryService,
}));

vi.mock("../server/memory/supermemory/provider-observability.js", () => ({
  recordProviderRead: fixtures.recordProviderRead,
}));

vi.mock("../server/integrations/registry.js", () => ({
  listEnabledIntegrations: fixtures.listEnabledIntegrations,
}));

vi.mock("../server/composio.js", () => ({
  displayNameFor: (slug: string) => slug.toUpperCase(),
  listConnectedToolkits: fixtures.listConnectedToolkits,
}));

vi.mock("../server/runtime-config.js", () => ({
  CODEX_MODEL_ALIASES: {
    mini: "gpt-5.4-mini",
    "gpt-5.4-mini": "gpt-5.4-mini",
  },
  KNOWN_CODEX_MODELS: new Set(["gpt-5.4-mini"]),
  KNOWN_MODELS: new Set(["claude-opus-4-7", "claude-sonnet-4-6"]),
  MODEL_ALIASES: {
    opus: "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
  },
  getBrowserSettings: fixtures.getBrowserSettings,
  getRuntimeConfig: fixtures.getRuntimeConfig,
  resolveModelInput: (value: string, runtime: "claude" | "codex") => {
    const normalized = value.toLowerCase();
    if (runtime === "codex") {
      return normalized === "mini" || normalized === "gpt-5.4-mini"
        ? "gpt-5.4-mini"
        : null;
    }
    return normalized === "opus" || normalized === "claude-opus-4-7"
      ? "claude-opus-4-7"
      : normalized === "sonnet" || normalized === "claude-sonnet-4-6"
        ? "claude-sonnet-4-6"
        : null;
  },
  resolveReasoningEffortInput: (value: string) => value.toLowerCase(),
  setCodexReasoningEffort: fixtures.setCodexReasoningEffort,
  setRuntimeModel: fixtures.setRuntimeModel,
  setRuntimeProvider: fixtures.setRuntimeProvider,
  resolveRuntimeInput: (value: string) => {
    const normalized = value.toLowerCase();
    return normalized.includes("claude") || normalized.includes("anthropic")
      ? "claude"
      : "codex";
  },
}));

vi.mock("../server/timezone-config.js", () => ({
  describeUserNow: fixtures.describeUserNow,
  resolveTimezoneInput: (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === "pacific time" || normalized === "pt") {
      return "America/Los_Angeles";
    }
    if (normalized === "dallas") return "America/Chicago";
    return null;
  },
  setUserTimezone: fixtures.setUserTimezone,
}));

vi.mock("../server/runtimes/index.js", () => ({
  runAgentRuntime: fixtures.runAgentRuntime,
}));

vi.mock("../server/images/content-blocks.js", () => ({
  buildPromptWithImagesOrTextFallback:
    fixtures.buildPromptWithImagesOrTextFallback,
  fetchStoredBytes: fixtures.fetchStoredBytes,
}));

vi.mock("../server/dispatcher/tools.js", () => ({
  createDispatcherTools: fixtures.createDispatcherTools,
  dispatcherAllowedTools: fixtures.dispatcherAllowedTools,
  resolveSpawnImageRefs: fixtures.resolveSpawnImageRefs,
}));

import { handleUserMessage } from "../server/interaction-agent.js";
import {
  DISPATCHER_DISALLOWED_TOOLS,
  buildInteractionSystemPrompt,
} from "../server/dispatcher/policy.js";

function resetMocks(): void {
  for (const mock of [
    fixtures.convexMutation,
    fixtures.convexQuery,
    fixtures.broadcast,
    fixtures.continueCodingAgentWithAnswer,
    fixtures.finalizeAssistantTurnCapture,
    fixtures.readMemoryProviderConfiguration,
    fixtures.ensureMemoryIdentityRuntime,
    fixtures.deriveMemoryIdentity,
    fixtures.createConfiguredSupermemoryService,
    fixtures.memoryHydrate,
    fixtures.recordProviderRead,
    fixtures.listEnabledIntegrations,
    fixtures.listConnectedToolkits,
    fixtures.getBrowserSettings,
    fixtures.getRuntimeConfig,
    fixtures.setCodexReasoningEffort,
    fixtures.setRuntimeModel,
    fixtures.setRuntimeProvider,
    fixtures.describeUserNow,
    fixtures.setUserTimezone,
    fixtures.runAgentRuntime,
    fixtures.buildPromptWithImagesOrTextFallback,
    fixtures.fetchStoredBytes,
    fixtures.createDispatcherTools,
    fixtures.dispatcherAllowedTools,
    fixtures.resolveSpawnImageRefs,
  ]) {
    mock.mockReset();
  }

  fixtures.convexMutation.mockResolvedValue("message-current");
  fixtures.convexQuery.mockImplementation(async (endpoint: string) => {
    if (endpoint === fixtures.endpoints.messages.recentCompleteTurns) {
      return [
        {
          turnId: "turn-earlier",
          user: { content: "Earlier question", truncated: false },
          assistant: { content: "Earlier answer", truncated: false },
        },
      ];
    }
    return null;
  });
  fixtures.continueCodingAgentWithAnswer.mockResolvedValue(null);
  fixtures.finalizeAssistantTurnCapture.mockResolvedValue(undefined);
  fixtures.readMemoryProviderConfiguration.mockReturnValue({
    timeoutMs: 1_200,
    threshold: 0.6,
    searchLimit: 8,
    dreaming: "dynamic",
    apiKeyConfigured: false,
  });
  fixtures.ensureMemoryIdentityRuntime.mockResolvedValue({
    status: "ready",
    saltFingerprint: "fixture-fingerprint",
  });
  fixtures.deriveMemoryIdentity.mockReturnValue({
    ownerId: "fixture-owner",
    containerTag: "fixture-container",
  });
  fixtures.memoryHydrate.mockResolvedValue({
    formattedContext: "Remembered fixture context",
  });
  fixtures.createConfiguredSupermemoryService.mockReturnValue({
    hydrate: fixtures.memoryHydrate,
  });
  fixtures.listEnabledIntegrations.mockResolvedValue([
    { name: "gmail" },
    { name: "slack" },
  ]);
  fixtures.listConnectedToolkits.mockResolvedValue([]);
  fixtures.getBrowserSettings.mockResolvedValue({ enabled: false });
  fixtures.getRuntimeConfig.mockResolvedValue(fixtures.runtimeConfig);
  fixtures.setCodexReasoningEffort.mockResolvedValue(undefined);
  fixtures.setRuntimeModel.mockResolvedValue(undefined);
  fixtures.setRuntimeProvider.mockResolvedValue(undefined);
  fixtures.describeUserNow.mockResolvedValue({
    timezone: "America/Los_Angeles",
    isExplicit: true,
    now: "Aug 14, 2026, 4:00 PM PDT",
  });
  fixtures.setUserTimezone.mockResolvedValue(undefined);
  fixtures.runAgentRuntime.mockResolvedValue({
    text: " Dispatcher reply ",
    usage: fixtures.usage,
  });
  fixtures.buildPromptWithImagesOrTextFallback.mockImplementation(
    async ({ text, imageStorageIds }) => ({
      prompt: text,
      imageStorageIds,
    }),
  );
  fixtures.createDispatcherTools.mockImplementation(() => ({
    tools: fixtures.fakeTools,
    lastCodingResult: { current: null },
  }));
  fixtures.dispatcherAllowedTools.mockReturnValue([
    "mcp__fixture-dispatcher__fixture_tool",
  ]);
}

function expectNoNormalPathWork(): void {
  expect(fixtures.convexQuery).not.toHaveBeenCalledWith(
    fixtures.endpoints.messages.recentCompleteTurns,
    expect.anything(),
  );
  expect(fixtures.convexQuery).not.toHaveBeenCalledWith(
    fixtures.endpoints.codingPreferences.getPreference,
    expect.anything(),
  );
  expect(fixtures.readMemoryProviderConfiguration).not.toHaveBeenCalled();
  expect(fixtures.ensureMemoryIdentityRuntime).not.toHaveBeenCalled();
  expect(fixtures.deriveMemoryIdentity).not.toHaveBeenCalled();
  expect(fixtures.createConfiguredSupermemoryService).not.toHaveBeenCalled();
  expect(fixtures.memoryHydrate).not.toHaveBeenCalled();
  expect(fixtures.recordProviderRead).not.toHaveBeenCalled();
  expect(fixtures.listEnabledIntegrations).not.toHaveBeenCalled();
  expect(fixtures.buildPromptWithImagesOrTextFallback).not.toHaveBeenCalled();
  expect(fixtures.fetchStoredBytes).not.toHaveBeenCalled();
  expect(fixtures.createDispatcherTools).not.toHaveBeenCalled();
  expect(fixtures.runAgentRuntime).not.toHaveBeenCalled();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(resetMocks);

describe("handleUserMessage dispatcher characterization", () => {
  it("preserves ordinary user persistence, history, runtime policy, and capture", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Current message",
      turnId: "turn-fixture",
      persistAssistantReply: true,
      images: [{ storageId: "image-fixture", mediaType: "image/png" }],
    });

    expect(reply).toBe("Dispatcher reply");
    expect(fixtures.convexMutation).toHaveBeenCalledOnce();
    expect(fixtures.convexMutation).toHaveBeenCalledWith(
      fixtures.endpoints.messages.send,
      {
        conversationId: "conversation-fixture",
        role: "user",
        content: "Current message",
        turnId: "turn-fixture",
        imageStorageIds: ["image-fixture"],
        mediaError: undefined,
      },
    );
    expect(fixtures.convexQuery).toHaveBeenNthCalledWith(
      1,
      fixtures.endpoints.messages.recentCompleteTurns,
      {
        conversationId: "conversation-fixture",
        beforeMessageId: "message-current",
      },
    );
    expect(fixtures.convexQuery).toHaveBeenNthCalledWith(
      2,
      fixtures.endpoints.codingPreferences.getPreference,
      {
        conversationId: "conversation-fixture",
        key: "coding_response_style",
      },
    );
    expect(fixtures.buildPromptWithImagesOrTextFallback).toHaveBeenCalledWith({
      text: "Prior turns:\nUSER: Earlier question\nASSISTANT: Earlier answer\n\nCurrent message:\nCurrent message",
      imageStorageIds: ["image-fixture"],
      fetchBytes: fixtures.fetchStoredBytes,
    });
    expect(fixtures.createDispatcherTools).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation-fixture",
        content: "Current message",
        kind: undefined,
        integrations: ["gmail", "slack"],
        inboundImageStorageIds: ["image-fixture"],
        spawnableImageStorageIds: ["image-fixture"],
        memoryService: null,
        runtimeConfig: fixtures.runtimeConfig,
        codingResponseStyle: "daniel_summary",
        toolFamilies: [],
      }),
    );
    expect(fixtures.runAgentRuntime).toHaveBeenCalledWith(
      fixtures.runtimeConfig,
      {
        prompt:
          "Prior turns:\nUSER: Earlier question\nASSISTANT: Earlier answer\n\nCurrent message:\nCurrent message",
        systemPrompt: buildInteractionSystemPrompt({
          integrations: ["gmail", "slack"],
          codingResponseStyle: "daniel_summary",
          memoryEnabled: false,
          toolFamilies: [],
        }),
        tools: fixtures.fakeTools,
        mode: "dispatcher",
        allowedTools: ["mcp__fixture-dispatcher__fixture_tool"],
        disallowedTools: DISPATCHER_DISALLOWED_TOOLS,
        onText: expect.any(Function),
        onToolUse: expect.any(Function),
      },
    );
    expect(fixtures.broadcast.mock.calls).toEqual([
      [
        "user_message",
        {
          conversationId: "conversation-fixture",
          content: "Current message",
        },
      ],
      [
        "assistant_message",
        {
          conversationId: "conversation-fixture",
          content: "Dispatcher reply",
        },
      ],
    ]);
    expect(fixtures.finalizeAssistantTurnCapture).toHaveBeenCalledWith({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      turnId: "turn-fixture",
      userMessage: "Current message",
      assistantReply: "Dispatcher reply",
      imageStorageIds: ["image-fixture"],
      kind: undefined,
      channel: "local",
    });
  });

  it("keeps history, hydration, images, tools, and one model call on the normal path", async () => {
    fixtures.readMemoryProviderConfiguration.mockReturnValue({
      timeoutMs: 1_200,
      threshold: 0.6,
      searchLimit: 8,
      dreaming: "dynamic",
      apiKeyConfigured: true,
    });

    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Explain how DNS caching works",
      turnId: "turn-normal-memory",
      persistAssistantReply: true,
      images: [{ storageId: "image-fixture", mediaType: "image/png" }],
    });

    expect(reply).toBe("Dispatcher reply");
    expect(fixtures.convexQuery).toHaveBeenCalledWith(
      fixtures.endpoints.messages.recentCompleteTurns,
      {
        conversationId: "conversation-fixture",
        beforeMessageId: "message-current",
      },
    );
    expect(fixtures.ensureMemoryIdentityRuntime).toHaveBeenCalledOnce();
    expect(fixtures.createConfiguredSupermemoryService).toHaveBeenCalledOnce();
    expect(fixtures.memoryHydrate).toHaveBeenCalledWith(
      "Explain how DNS caching works",
    );
    expect(fixtures.recordProviderRead).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "hydration" }),
    );
    expect(fixtures.buildPromptWithImagesOrTextFallback).toHaveBeenCalledOnce();
    expect(fixtures.createDispatcherTools).toHaveBeenCalledOnce();
    expect(fixtures.runAgentRuntime).toHaveBeenCalledOnce();
  });

  it("starts history, memory, runtime, and integration preparation in parallel", async () => {
    const history = deferred<
      Array<{
        turnId: string;
        user: { content: string; truncated: boolean };
        assistant: { content: string; truncated: boolean };
      }>
    >();
    const identity = deferred<{
      status: "ready";
      saltFingerprint: string;
    }>();
    const runtime = deferred<typeof fixtures.runtimeConfig>();
    const integrations = deferred<Array<{ name: string }>>();

    fixtures.readMemoryProviderConfiguration.mockReturnValue({
      timeoutMs: 1_200,
      threshold: 0.6,
      searchLimit: 8,
      dreaming: "dynamic",
      apiKeyConfigured: true,
    });
    fixtures.convexQuery.mockImplementation(async (endpoint: string) => {
      if (endpoint === fixtures.endpoints.messages.recentCompleteTurns) {
        return history.promise;
      }
      return null;
    });
    fixtures.ensureMemoryIdentityRuntime.mockReturnValue(identity.promise);
    fixtures.getRuntimeConfig.mockReturnValue(runtime.promise);
    fixtures.listEnabledIntegrations.mockReturnValue(integrations.promise);

    const pendingReply = handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Prepare this turn concurrently",
      turnId: "turn-parallel",
      persistAssistantReply: true,
    });

    await vi.waitFor(() => {
      expect(fixtures.convexQuery).toHaveBeenCalledWith(
        fixtures.endpoints.messages.recentCompleteTurns,
        {
          conversationId: "conversation-fixture",
          beforeMessageId: "message-current",
        },
      );
      expect(fixtures.ensureMemoryIdentityRuntime).toHaveBeenCalledOnce();
      expect(fixtures.getRuntimeConfig).toHaveBeenCalledOnce();
      expect(fixtures.listEnabledIntegrations).toHaveBeenCalledOnce();
    });
    expect(fixtures.runAgentRuntime).not.toHaveBeenCalled();

    history.resolve([]);
    identity.resolve({
      status: "ready",
      saltFingerprint: "fixture-fingerprint",
    });
    runtime.resolve(fixtures.runtimeConfig);
    integrations.resolve([{ name: "gmail" }]);

    await expect(pendingReply).resolves.toBe("Dispatcher reply");
    expect(fixtures.memoryHydrate).toHaveBeenCalledWith(
      "Prepare this turn concurrently",
    );
    expect(fixtures.runAgentRuntime).toHaveBeenCalledOnce();
  });

  it("isolates proactive notices from history, tools, images, and durable capture", async () => {
    const reply = await handleUserMessage({
      conversationId: "proactive-fixture",
      memoryOwnerId: "owner-fixture",
      content: "[proactive notice] Flight delayed by 20 minutes",
      turnId: "turn-proactive",
      kind: "proactive",
      persistAssistantReply: true,
      images: [{ storageId: "ignored-image", mediaType: "image/png" }],
    });

    expect(reply).toBe("Flight delayed by 20 minutes");
    expect(fixtures.convexMutation).toHaveBeenCalledWith(
      fixtures.endpoints.messages.send,
      {
        conversationId: "proactive-fixture",
        role: "system",
        content: "[proactive notice] Flight delayed by 20 minutes",
        turnId: "turn-proactive",
        imageStorageIds: ["ignored-image"],
        mediaError: undefined,
      },
    );
    expectNoNormalPathWork();
    expect(fixtures.continueCodingAgentWithAnswer).not.toHaveBeenCalled();
    expect(fixtures.finalizeAssistantTurnCapture).not.toHaveBeenCalled();
    expect(fixtures.broadcast.mock.calls).toEqual([
      [
        "proactive_notice",
        {
          conversationId: "proactive-fixture",
          content: "[proactive notice] Flight delayed by 20 minutes",
        },
      ],
      [
        "assistant_message",
        {
          conversationId: "proactive-fixture",
          content: "Flight delayed by 20 minutes",
        },
      ],
    ]);
  });

  it("short-circuits an explicit runtime switch before building dispatcher tools", async () => {
    fixtures.getRuntimeConfig
      .mockReset()
      .mockResolvedValueOnce(fixtures.runtimeConfig)
      .mockResolvedValueOnce({
        runtime: "codex",
        model: "codex-fixture",
        reasoningEffort: "medium",
        billingMode: "codex-subscription",
      });

    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Switch to Codex",
      turnId: "turn-switch",
      persistAssistantReply: true,
    });

    expect(reply).toBe("Switched to Codex. Next turn will use codex-fixture.");
    expect(fixtures.setRuntimeProvider).toHaveBeenCalledWith("codex");
    expect(fixtures.getRuntimeConfig).toHaveBeenCalledTimes(2);
    expectNoNormalPathWork();
    expect(fixtures.finalizeAssistantTurnCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-switch",
        assistantReply: "Switched to Codex. Next turn will use codex-fixture.",
      }),
    );
  });

  it("short-circuits explicit local-browser intent when browser is disabled", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Use the local browser to check this",
      turnId: "turn-browser",
      persistAssistantReply: true,
    });

    const expectedReply =
      "Local browser use is off right now. Turn it on in Settings → Local browser use, then resend this and I can use Chrome on your machine.";
    expect(reply).toBe(expectedReply);
    expect(fixtures.getBrowserSettings).toHaveBeenCalledOnce();
    expect(fixtures.setRuntimeProvider).not.toHaveBeenCalled();
    expectNoNormalPathWork();
    expect(fixtures.finalizeAssistantTurnCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-browser",
        assistantReply: expectedReply,
      }),
    );
  });

  it("keeps enabled-browser and untrusted proactive-looking text on the normal path", async () => {
    fixtures.getBrowserSettings.mockResolvedValue({ enabled: true });
    const browserReply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Use the local browser to check this",
      turnId: "turn-browser-enabled",
      persistAssistantReply: true,
    });
    expect(browserReply).toBe("Dispatcher reply");
    expect(fixtures.getBrowserSettings).toHaveBeenCalledOnce();
    expect(fixtures.createDispatcherTools).toHaveBeenCalledOnce();
    expect(fixtures.runAgentRuntime).toHaveBeenCalledOnce();

    resetMocks();
    const userTextReply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "[proactive notice] this came from the user",
      turnId: "turn-user-prefix",
      persistAssistantReply: true,
    });
    expect(userTextReply).toBe("Dispatcher reply");
    expect(fixtures.continueCodingAgentWithAnswer).toHaveBeenCalledOnce();
    expect(fixtures.runAgentRuntime).toHaveBeenCalledOnce();
  });

  it("resumes a pending coding answer before configuration-looking routes", async () => {
    fixtures.continueCodingAgentWithAnswer.mockImplementation(async () => {
      expectNoNormalPathWork();
      return {
        status: "completed",
        result: "Codex finished the requested implementation.",
      };
    });

    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Codex",
      turnId: "turn-pending",
      persistAssistantReply: true,
      images: [{ storageId: "ignored-image", mediaType: "image/png" }],
    });

    expect(reply).toBe("Codex finished the requested implementation.");
    expect(fixtures.setRuntimeProvider).not.toHaveBeenCalled();
    expectNoNormalPathWork();
  });

  it("switches an explicit model before normal dispatcher work", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Use Opus",
      turnId: "turn-model",
      persistAssistantReply: true,
      images: [{ storageId: "ignored-image", mediaType: "image/png" }],
    });

    expect(reply).toBe(
      "Switched the Claude model to claude-opus-4-7. It takes effect next turn.",
    );
    expect(fixtures.setRuntimeModel).toHaveBeenCalledWith(
      "claude-opus-4-7",
      "claude",
    );
    expectNoNormalPathWork();
  });

  it("handles an explicit runtime-qualified model as one code route", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Use Codex mini",
      turnId: "turn-codex-model",
      persistAssistantReply: true,
    });

    expect(reply).toBe(
      "Switched to Codex with model gpt-5.4-mini. It takes effect next turn.",
    );
    expect(fixtures.setRuntimeModel).toHaveBeenCalledWith(
      "gpt-5.4-mini",
      "codex",
    );
    expect(fixtures.setRuntimeProvider).toHaveBeenCalledWith("codex");
    expectNoNormalPathWork();
  });

  it("sets an explicit timezone before normal dispatcher work", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Use Pacific time",
      turnId: "turn-timezone",
      persistAssistantReply: true,
      images: [{ storageId: "ignored-image", mediaType: "image/png" }],
    });

    expect(reply).toBe(
      "Timezone set to America/Los_Angeles. Local time there is Aug 14, 2026, 4:00 PM PDT.",
    );
    expect(fixtures.setUserTimezone).toHaveBeenCalledWith(
      "America/Los_Angeles",
    );
    expectNoNormalPathWork();
  });

  it("returns coded clarification for explicit invalid model and timezone settings", async () => {
    const modelReply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Set model to banana-v9",
      turnId: "turn-invalid-model",
      persistAssistantReply: true,
    });
    expect(modelReply).toBe("“banana-v9” isn’t a recognized Claude model.");
    expect(fixtures.setRuntimeModel).not.toHaveBeenCalled();
    expectNoNormalPathWork();

    resetMocks();
    const timezoneReply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Set my timezone to Mars/Phobos",
      turnId: "turn-invalid-timezone",
      persistAssistantReply: true,
    });
    expect(timezoneReply).toContain(
      "“Mars/Phobos” isn’t a recognized timezone.",
    );
    expect(fixtures.setUserTimezone).not.toHaveBeenCalled();
    expectNoNormalPathWork();
  });

  it("handles simple reasoning and coding-style configuration in code", async () => {
    const reasoningReply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Set Codex reasoning effort to high",
      turnId: "turn-reasoning",
      persistAssistantReply: true,
    });
    expect(reasoningReply).toBe(
      "Codex reasoning effort set to high. It takes effect on the next Codex turn.",
    );
    expect(fixtures.setCodexReasoningEffort).toHaveBeenCalledWith("high");
    expectNoNormalPathWork();

    resetMocks();
    const styleReply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "From now on give me raw Codex output",
      turnId: "turn-style",
      persistAssistantReply: true,
    });
    expect(styleReply).toBe(
      "Coding replies will use raw Codex output by default.",
    );
    expect(fixtures.convexMutation).toHaveBeenCalledWith(
      fixtures.endpoints.codingPreferences.storePreference,
      {
        conversationId: "conversation-fixture",
        key: "coding_response_style",
        value: "raw_codex",
      },
    );
    expectNoNormalPathWork();
  });

  it("answers a simple current-model request without history or a model call", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "What model are you using?",
      turnId: "turn-config-read",
      persistAssistantReply: true,
    });

    expect(reply).toBe("I’m using claude-fixture on Claude.");
    expect(fixtures.getRuntimeConfig).toHaveBeenCalledOnce();
    expectNoNormalPathWork();
  });

  it("lets compound and contextual configuration language use the normal path", async () => {
    const reply = await handleUserMessage({
      conversationId: "conversation-fixture",
      memoryOwnerId: "owner-fixture",
      content: "Use Opus and fix the failing test",
      turnId: "turn-compound",
      persistAssistantReply: true,
    });

    expect(reply).toBe("Dispatcher reply");
    expect(fixtures.setRuntimeModel).not.toHaveBeenCalled();
    expect(fixtures.convexQuery).toHaveBeenCalledWith(
      fixtures.endpoints.messages.recentCompleteTurns,
      {
        conversationId: "conversation-fixture",
        beforeMessageId: "message-current",
      },
    );
    expect(fixtures.runAgentRuntime).toHaveBeenCalledOnce();
  });
});
