import { describe, expect, it, vi } from "vitest";
import {
  SupermemoryAdapter,
  SupermemoryProviderError,
  type SupermemorySdkClient,
} from "../server/memory/supermemory/client.js";
import {
  compareShadowRecall,
  hydrateMemoryContext,
  recallMemory,
} from "../server/memory/supermemory/context.js";
import {
  MEMORY_CONTEXT_MAX_CHARS,
  MEMORY_SEARCH_RESULT_LIMIT,
  formatMemoryContext,
} from "../server/memory/supermemory/format-context.js";
import { deriveMemoryIdentity } from "../server/memory/supermemory/identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
  MemorySearchResult,
} from "../server/memory/supermemory/types.js";

const TEST_SALT = "test-only-context-salt-0123456789";

function owner() {
  return deriveMemoryIdentity(
    { memoryOwnerId: "fixture-user-alpha", conversationId: "fixture-conversation-alpha" },
    { salt: TEST_SALT },
  );
}

function memory(
  id: string,
  content: string,
  similarity = 0.8,
  extra: Partial<MemorySearchResult> = {},
): MemorySearchResult {
  return {
    id,
    content,
    kind: "memory",
    similarity,
    metadata: null,
    ...extra,
  };
}

function hydration(
  profile: MemoryHydrationResult["profile"] = { static: [], dynamic: [] },
  results: MemorySearchResult[] = [],
): MemoryHydrationResult {
  return { provider: "supermemory", profile, results, latencyMs: 3 };
}

function providerWith(overrides: {
  profile?: DanielMemoryProvider["profile"];
  search?: DanielMemoryProvider["search"];
} = {}): Pick<DanielMemoryProvider, "profile" | "search"> {
  return {
    profile: overrides.profile ?? vi.fn(async () => hydration()),
    search: overrides.search ?? vi.fn(async () => []),
  };
}

describe("Supermemory automatic context hydration", () => {
  it("gets profile and query memories in one profile call", async () => {
    const profile = vi.fn(async () =>
      hydration(
        {
          static: ["The user prefers concise answers"],
          dynamic: ["The user is preparing a launch"],
        },
        [memory("mem-launch", "The launch checklist uses staged rollouts", 0.91)],
      ),
    );
    const search = vi.fn(async () => []);
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile, search }),
      owner: owner(),
      currentUserMessage: "What should I do for the launch?",
      mode: "shadow",
      config: { timeoutMs: 1_200, threshold: 0.6, searchLimit: 8 },
    });

    expect(result.status).toBe("success");
    expect(profile).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledWith({
      containerTag: owner().containerTag,
      q: "What should I do for the launch?",
      threshold: 0.6,
    });
    expect(search).not.toHaveBeenCalled();
    expect(result.formattedContext).toContain("The launch checklist uses staged rollouts");
  });

  it("formats static, dynamic, then relevant results deterministically", () => {
    const input = hydration(
      {
        static: ["The user is named Rowan", "The user prefers concise answers"],
        dynamic: ["The user is preparing a launch"],
      },
      [
        memory("lower", "The launch uses a staged rollout", 0.72),
        memory("higher", "The launch date is September 12", 0.94),
      ],
    );

    const first = formatMemoryContext(input);
    const second = formatMemoryContext(input);
    expect(first).toBe(second);
    expect(first.indexOf("Stable user profile:")).toBeLessThan(
      first.indexOf("Recent user context:"),
    );
    expect(first.indexOf("Recent user context:")).toBeLessThan(
      first.indexOf("Relevant past memories:"),
    );
    expect(first.indexOf("September 12")).toBeLessThan(first.indexOf("staged rollout"));
  });

  it("caps the prompt at 8,000 characters without breaking its closing tag", () => {
    const result = formatMemoryContext(
      hydration({ static: [`The user keeps notes ${"x".repeat(10_000)}`], dynamic: [] }),
    );

    expect(result.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    expect(result.endsWith("</daniel_memory_context>")).toBe(true);
    expect(result).toContain("…");
  });

  it("caps relevant memories at eight results", () => {
    const results = Array.from({ length: 12 }, (_, index) =>
      memory(`mem-${index}`, `Unique memory number ${index}`, 1 - index / 100),
    );
    const prompt = formatMemoryContext(hydration({ static: [], dynamic: [] }, results));
    const renderedResults = prompt
      .split("Relevant past memories:\n")[1]
      ?.split("\n</daniel_memory_context>")[0]
      ?.split("\n")
      .filter((line) => line.startsWith("- "));

    expect(renderedResults).toHaveLength(MEMORY_SEARCH_RESULT_LIMIT);
    expect(prompt).not.toContain("Unique memory number 8");
  });

  it("keeps the eight most relevant profile-query results", async () => {
    const results = Array.from({ length: 9 }, (_, index) =>
      memory(`mem-${index}`, `Unique hydration memory ${index}`, 0.1 + index / 10),
    );
    const response = await hydrateMemoryContext({
      provider: providerWith({ profile: vi.fn(async () => hydration(undefined, results)) }),
      owner: owner(),
      currentUserMessage: "project details",
      mode: "shadow",
      env: {},
    });

    expect(response.hydration.results).toHaveLength(8);
    expect(response.hydration.results.map(({ id }) => id)).toContain("mem-8");
    expect(response.hydration.results.map(({ id }) => id)).not.toContain("mem-0");
  });

  it("distinguishes an empty profile from failure without user-visible status text", async () => {
    const result = await hydrateMemoryContext({
      provider: providerWith(),
      owner: owner(),
      currentUserMessage: "hello",
      mode: "shadow",
      env: {},
    });

    expect(result).toMatchObject({
      status: "empty",
      formattedContext: "",
      hydration: { profile: { static: [], dynamic: [] }, results: [] },
    });
    expect(result).not.toHaveProperty("error");
  });

  it("fails open at Daniel's timeout and records sanitized instrumentation", async () => {
    const instrumentation = vi.fn();
    const profile = vi.fn(() => new Promise<MemoryHydrationResult>(() => undefined));
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile }),
      owner: owner(),
      currentUserMessage: "hello",
      mode: "supermemory",
      config: {
        timeoutMs: 10,
        threshold: 0.6,
        searchLimit: 8,
        legacyFallback: false,
      },
      instrumentation,
    });

    expect(result).toMatchObject({
      status: "failed",
      formattedContext: "",
      fallbackEligible: false,
      error: { code: "timeout", retryable: true },
    });
    expect(result.hydration.results).toEqual([]);
    expect(instrumentation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "memory.recall.failed",
        operation: "hydrate",
        errorCode: "timeout",
      }),
    );
  });

  it("normalizes provider errors without returning credentials or raw responses", async () => {
    const profile = vi.fn(async () => {
      throw new SupermemoryProviderError(
        "API key sm_test_secret_value failed with raw response {\"debug\":true}",
        { operation: "profile", status: 503, retryable: true },
      );
    });
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile }),
      owner: owner(),
      currentUserMessage: "hello",
      mode: "shadow",
      env: {},
      instrumentation: vi.fn(),
    });

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("sm_test_secret_value");
    expect(JSON.stringify(result)).not.toContain("debug");
    expect(result.error).toEqual({
      name: "MemoryContextError",
      code: "provider",
      message: "Supermemory hydrate failed",
      retryable: true,
    });
  });

  it("does not make legacy fallback eligible after final cutover configuration errors", async () => {
    const profile = vi.fn(async () => hydration());
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile }),
      owner: owner(),
      currentUserMessage: "hello",
      env: {
        DANIEL_MEMORY_READ_MODE: "supermemory",
        DANIEL_MEMORY_LEGACY_FALLBACK: "false",
        DANIEL_SUPERMEMORY_TIMEOUT_MS: "invalid",
      },
      instrumentation: vi.fn(),
    });

    expect(result).toMatchObject({
      status: "failed",
      mode: "supermemory",
      fallbackEligible: false,
      error: { code: "configuration" },
    });
    expect(profile).not.toHaveBeenCalled();
  });

  it("rejects raw JSON prompt lines, redacts secrets, and deduplicates profile facts", () => {
    const prompt = formatMemoryContext(
      hydration(
        {
          static: [
            '{"profile":{"static":["raw provider response"]}}',
            "The user prefers concise answers",
            "api_key=sm_fixture_should_not_render",
          ],
          dynamic: [],
        },
        [memory("duplicate", "Prefers concise answers", 0.99)],
      ),
    );

    expect(prompt).not.toContain("raw provider response");
    expect(prompt).not.toContain("sm_fixture_should_not_render");
    expect(prompt).toContain("api_key=[redacted]");
    expect(prompt.match(/concise answers/g)).toHaveLength(1);
  });

  it("supports multiple independent narrow recalls during one turn", async () => {
    const search = vi
      .fn<DanielMemoryProvider["search"]>()
      .mockResolvedValueOnce([memory("navan", "The Navan project uses TypeScript", 0.9)])
      .mockResolvedValueOnce([memory("decision", "The old decision was to use queues", 0.88)]);
    const provider = providerWith({ search });
    const identity = owner();

    const first = await recallMemory({
      provider,
      owner: identity,
      q: "What do you remember about my Navan work?",
      mode: "shadow",
      env: {},
    });
    const second = await recallMemory({
      provider,
      owner: identity,
      q: "Why did we choose queues?",
      mode: "shadow",
      env: {},
    });

    expect(first.results[0]?.id).toBe("navan");
    expect(second.results[0]?.id).toBe("decision");
    expect(search).toHaveBeenNthCalledWith(1, {
      q: "What do you remember about my Navan work?",
      containerTag: identity.containerTag,
      searchMode: "memories",
      limit: 8,
      threshold: 0.6,
    });
    expect(search).toHaveBeenNthCalledWith(2, {
      q: "Why did we choose queues?",
      containerTag: identity.containerTag,
      searchMode: "memories",
      limit: 8,
      threshold: 0.6,
    });
    expect(search.mock.calls.flatMap(([request]) => Object.keys(request))).not.toContain("include");
  });

  it("routes narrow recall through the adapter's direct SDK search call", async () => {
    const sdkSearch = vi.fn(async () => ({
      results: [
        {
          id: "navan",
          memory: "The Navan project uses TypeScript",
          similarity: 0.9,
          metadata: null,
          updatedAt: "2026-08-13T00:00:00.000Z",
          version: 1,
        },
      ],
      total: 1,
      timing: 5,
    }));
    const sdk = {
      add: vi.fn(),
      profile: vi.fn(),
      search: sdkSearch,
    } as unknown as SupermemorySdkClient;
    const adapter = new SupermemoryAdapter({
      apiKey: "fixture-api-key",
      sdkFactory: () => sdk,
      fetchImpl: vi.fn(),
    });
    const identity = owner();

    const recalled = await recallMemory({
      provider: adapter,
      owner: identity,
      q: "What do you remember about my Navan work?",
      mode: "shadow",
      env: {},
    });

    expect(recalled.results.map(({ id }) => id)).toEqual(["navan"]);
    expect(sdkSearch).toHaveBeenCalledWith(
      {
        q: "What do you remember about my Navan work?",
        containerTag: identity.containerTag,
        searchMode: "memories",
        limit: 8,
        threshold: 0.6,
      },
      { timeout: 1_200, maxRetries: 0 },
    );
  });

  it("excludes forgotten memories and renders only the latest lineage version", () => {
    const results = [
      memory("forgotten", "The user once preferred paper tickets", 0.99, {
        metadata: { forgotten: true },
      }),
      memory("old", "The user prefers window seats", 0.97, {
        metadata: { rootMemoryId: "travel-seat" },
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      memory("new", "The user now prefers aisle seats", 0.8, {
        metadata: { rootMemoryId: "travel-seat" },
        version: 2,
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    ];
    const prompt = formatMemoryContext(hydration({ static: [], dynamic: [] }, results));

    expect(prompt).not.toContain("paper tickets");
    expect(prompt).not.toContain("window seats");
    expect(prompt).toContain("aisle seats");
  });

  it("produces aggregate-only shadow comparison metrics", () => {
    const report = compareShadowRecall({
      legacyResults: ["The user prefers concise answers", "Legacy-only fact"],
      supermemory: hydration(
        { static: ["The user is named Rowan"], dynamic: [] },
        [memory("concise", "The user prefers concise answers", 0.9)],
      ),
      expectedFacts: [
        { id: "concise", expectedPresence: "present" },
        { text: "The user is named Rowan", expectedPresence: "present" },
        { text: "A fact that must be absent", expectedPresence: "absent" },
      ],
    });

    expect(report).toMatchObject({
      legacyResultCount: 2,
      supermemoryResultCount: 1,
      overlapCount: 1,
      expectedFactCoverage: 1,
      expectedAbsenceViolationCount: 0,
    });
    expect(report).not.toHaveProperty("profile");
    expect(report).not.toHaveProperty("results");
    expect(JSON.stringify(report)).not.toContain("Rowan");
  });

  it("counts profile facts when comparing shadow overlap", () => {
    const report = compareShadowRecall({
      legacyResults: ["The user is named Rowan"],
      supermemory: hydration({ static: ["The user is named Rowan"], dynamic: [] }),
    });

    expect(report).toMatchObject({ overlapCount: 1, overlapRate: 1 });
  });
});
