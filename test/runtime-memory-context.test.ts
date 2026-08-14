import { describe, expect, it, vi } from "vitest";
import { composePreloadedMemoryPrompt } from "../server/interaction-agent.js";
import {
  prepareRuntimeMemoryContext,
  shouldUseLegacyProviderFallback,
  type LegacyMemoryResult,
  type RuntimeMemoryContextDependencies,
} from "../server/memory/runtime-context.js";
import {
  SupermemoryProviderError,
} from "../server/memory/supermemory/client.js";
import { memoryIdSaltFingerprint } from "../server/memory/supermemory/identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
  MemoryProviderConfiguration,
} from "../server/memory/supermemory/types.js";

const TEST_SALT = "test-only-runtime-salt-0123456789abcdef";

function configuration(
  overrides: Partial<MemoryProviderConfiguration> = {},
): MemoryProviderConfiguration {
  return {
    readMode: "shadow",
    writeMode: "dual",
    timeoutMs: 1_200,
    threshold: 0.6,
    searchLimit: 8,
    dreaming: "dynamic",
    historyBackfillDays: 0,
    legacyFallback: true,
    apiKeyConfigured: true,
    ...overrides,
  };
}

function legacy(content = "The user prefers concise answers"): LegacyMemoryResult {
  return {
    memoryId: "legacy-1",
    content,
    importance: 0.9,
    segment: "preference",
    tier: "permanent",
  };
}

function hydration(content = "The user prefers concise answers"): MemoryHydrationResult {
  return {
    provider: "supermemory",
    profile: { static: [content], dynamic: [] },
    results: [],
    latencyMs: 4,
  };
}

function dependencies(
  overrides: Partial<RuntimeMemoryContextDependencies> = {},
): RuntimeMemoryContextDependencies {
  const profile = vi.fn(async () => hydration());
  const search = vi.fn(async () => []);
  return {
    ensureIdentitySaltFingerprint: vi.fn(async (fingerprint) => fingerprint),
    recallLegacy: vi.fn(async () => ({ results: [legacy()], mode: "substring" as const })),
    provider: { profile, search },
    memoryIdSalt: TEST_SALT,
    ...overrides,
  };
}

const input = {
  conversationId: "sms:fixture-user-a",
  memoryOwnerId: "fixture-user-a",
  currentUserMessage: "How do I like answers formatted?",
};

describe("Implementation 7 runtime memory selection", () => {
  it("injects preloaded context ahead of the dispatcher conversation prompt", () => {
    const prompt = composePreloadedMemoryPrompt(
      "Current message:\nHow should I reply?",
      "<daniel_memory_context>\nStable user profile:\n- Prefers concise replies\n</daniel_memory_context>",
    );

    expect(prompt.indexOf("daniel_memory_context")).toBeLessThan(
      prompt.indexOf("Current message"),
    );
  });

  it("preloads legacy context in Convex-only mode without requiring Supermemory identity", async () => {
    const deps = dependencies();
    const result = await prepareRuntimeMemoryContext(
      { ...input, config: configuration({ readMode: "convex", writeMode: "convex" }) },
      deps,
    );

    expect(result).toMatchObject({ source: "convex", fallbackUsed: false });
    expect(result.promptContext).toContain("The user prefers concise answers");
    expect(deps.ensureIdentitySaltFingerprint).not.toHaveBeenCalled();
    expect(deps.provider?.profile).not.toHaveBeenCalled();
  });

  it("keeps Convex user-facing in shadow mode while measuring Supermemory", async () => {
    const profile = vi.fn(async () => hydration("The user prefers short replies"));
    const deps = dependencies({ provider: { profile, search: vi.fn(async () => []) } });
    const result = await prepareRuntimeMemoryContext(
      { ...input, config: configuration() },
      deps,
    );

    expect(result.source).toBe("convex");
    expect(result.promptContext).toContain("concise answers");
    expect(result.promptContext).not.toContain("short replies");
    expect(result.shadowComparison).toMatchObject({
      legacyResultCount: 1,
      supermemoryResultCount: 0,
    });
    expect(result.shadowComparison).not.toHaveProperty("profile");
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: expect.stringMatching(/^daniel-user-/) }),
    );
  });

  it("uses the Supermemory profile and query result after read cutover", async () => {
    const deps = dependencies({
      provider: {
        profile: vi.fn(async () => hydration("The user prefers short replies")),
        search: vi.fn(async () => []),
      },
    });
    const result = await prepareRuntimeMemoryContext(
      { ...input, config: configuration({ readMode: "supermemory" }) },
      deps,
    );

    expect(result).toMatchObject({ source: "supermemory", fallbackUsed: false });
    expect(result.promptContext).toContain("short replies");
    expect(result.promptContext).not.toContain("concise answers");
    expect(deps.recallLegacy).not.toHaveBeenCalled();
  });

  it("uses legacy fallback only for a provider failure during burn-in", async () => {
    const provider: Pick<DanielMemoryProvider, "profile" | "search"> = {
      profile: vi.fn(async () => {
        throw new SupermemoryProviderError("fixture timeout", {
          operation: "profile",
          code: "timeout",
          retryable: true,
        });
      }),
      search: vi.fn(async () => []),
    };
    const deps = dependencies({ provider });
    const result = await prepareRuntimeMemoryContext(
      { ...input, config: configuration({ readMode: "supermemory" }) },
      deps,
    );

    expect(result).toMatchObject({
      source: "convex",
      fallbackUsed: true,
      error: { code: "timeout" },
    });
    expect(result.promptContext).toContain("concise answers");
    expect(deps.recallLegacy).toHaveBeenCalledOnce();
  });

  it("does not silently fall back for deployment configuration errors", async () => {
    const deps = dependencies({
      ensureIdentitySaltFingerprint: vi.fn(async () =>
        memoryIdSaltFingerprint("different-test-only-runtime-salt-987654321"),
      ),
    });
    const result = await prepareRuntimeMemoryContext(
      { ...input, config: configuration({ readMode: "supermemory" }) },
      deps,
    );

    expect(result).toMatchObject({
      source: "none",
      promptContext: "",
      fallbackUsed: false,
      error: { code: "configuration" },
    });
    expect(deps.recallLegacy).not.toHaveBeenCalled();
    expect(deps.provider?.profile).not.toHaveBeenCalled();
  });

  it("classifies only provider-path errors as fallback eligible", () => {
    expect(
      shouldUseLegacyProviderFallback({
        status: "failed",
        fallbackEligible: true,
        error: {
          name: "MemoryContextError",
          code: "provider",
          message: "provider failed",
          retryable: true,
        },
      }),
    ).toBe(true);
    expect(
      shouldUseLegacyProviderFallback({
        status: "failed",
        fallbackEligible: true,
        error: {
          name: "MemoryContextError",
          code: "configuration",
          message: "configuration failed",
          retryable: false,
        },
      }),
    ).toBe(false);
  });
});
