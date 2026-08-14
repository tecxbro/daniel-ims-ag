import { describe, expect, it, vi } from "vitest";
import {
  SupermemoryAdapter,
  SupermemoryProviderError,
  type SupermemorySdkClient,
} from "../server/memory/supermemory/client.js";
import {
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

const TEST_SALT = "8".repeat(64);

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

describe("direct Supermemory context", () => {
  it("hydrates profile and query memories with one provider call", async () => {
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
    const identity = owner();
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile, search }),
      owner: identity,
      currentUserMessage: "What should I do for the launch?",
      config: { timeoutMs: 1_200, threshold: 0.6, searchLimit: 8 },
    });

    expect(result.status).toBe("success");
    expect(profile).toHaveBeenCalledWith({
      containerTag: identity.containerTag,
      q: "What should I do for the launch?",
      threshold: 0.6,
    });
    expect(search).not.toHaveBeenCalled();
    expect(result.formattedContext).toContain("The launch checklist uses staged rollouts");
  });

  it("treats an empty profile and search result as a successful empty state", async () => {
    const result = await hydrateMemoryContext({
      provider: providerWith(),
      owner: owner(),
      currentUserMessage: "hello",
      env: {},
    });

    expect(result).toEqual({
      status: "empty",
      formattedContext: "",
      hydration: {
        provider: "supermemory",
        profile: { static: [], dynamic: [] },
        results: [],
        latencyMs: expect.any(Number),
      },
    });
  });

  it("fails open at the internal timeout with empty context and sanitized instrumentation", async () => {
    const instrumentation = vi.fn();
    const profile = vi.fn(() => new Promise<MemoryHydrationResult>(() => undefined));
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile }),
      owner: owner(),
      currentUserMessage: "hello",
      config: { timeoutMs: 10, threshold: 0.6, searchLimit: 8 },
      instrumentation,
    });

    expect(result).toMatchObject({
      status: "failed",
      formattedContext: "",
      hydration: { profile: { static: [], dynamic: [] }, results: [] },
      error: { code: "timeout", retryable: true },
    });
    expect(instrumentation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "memory.recall.failed",
        operation: "hydrate",
        errorCode: "timeout",
      }),
    );
  });

  it("normalizes provider failures without returning credentials or raw responses", async () => {
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

  it("rejects invalid direct settings before contacting the provider", async () => {
    const profile = vi.fn(async () => hydration());
    const result = await hydrateMemoryContext({
      provider: providerWith({ profile }),
      owner: owner(),
      currentUserMessage: "hello",
      env: { DANIEL_SUPERMEMORY_TIMEOUT_MS: "invalid" },
      instrumentation: vi.fn(),
    });

    expect(result).toMatchObject({ status: "failed", error: { code: "configuration" } });
    expect(profile).not.toHaveBeenCalled();
  });

  it("supports independent narrow recalls and returns an empty state truthfully", async () => {
    const search = vi
      .fn<DanielMemoryProvider["search"]>()
      .mockResolvedValueOnce([memory("navan", "The Navan project uses TypeScript", 0.9)])
      .mockResolvedValueOnce([]);
    const identity = owner();
    const first = await recallMemory({
      provider: providerWith({ search }),
      owner: identity,
      q: "What do you remember about my Navan work?",
      env: {},
    });
    const second = await recallMemory({
      provider: providerWith({ search }),
      owner: identity,
      q: "Unknown topic",
      env: {},
    });

    expect(first).toMatchObject({ status: "success", results: [{ id: "navan" }] });
    expect(second).toMatchObject({ status: "empty", results: [] });
    expect(search).toHaveBeenNthCalledWith(1, {
      q: "What do you remember about my Navan work?",
      containerTag: identity.containerTag,
      searchMode: "memories",
      limit: 8,
      threshold: 0.6,
    });
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
});

describe("memory context formatting", () => {
  it("orders profile sections and relevant results deterministically", () => {
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
    expect(first).toBe(formatMemoryContext(input));
    expect(first.indexOf("Stable user profile:")).toBeLessThan(
      first.indexOf("Recent user context:"),
    );
    expect(first.indexOf("Recent user context:")).toBeLessThan(
      first.indexOf("Relevant past memories:"),
    );
    expect(first.indexOf("September 12")).toBeLessThan(first.indexOf("staged rollout"));
  });

  it("caps prompt size and result count without breaking the closing tag", () => {
    const oversized = formatMemoryContext(
      hydration({ static: [`The user keeps notes ${"x".repeat(10_000)}`], dynamic: [] }),
    );
    expect(oversized.length).toBeLessThanOrEqual(MEMORY_CONTEXT_MAX_CHARS);
    expect(oversized.endsWith("</daniel_memory_context>")).toBe(true);

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
  });

  it("redacts secrets, rejects raw JSON lines, and renders only current memory versions", () => {
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
        [
          memory("duplicate", "Prefers concise answers", 0.99),
          memory("forgotten", "The user once preferred paper tickets", 0.98, {
            metadata: { forgotten: true },
          }),
          memory("old", "The user prefers window seats", 0.97, {
            metadata: { rootMemoryId: "travel-seat" },
            version: 1,
          }),
          memory("new", "The user now prefers aisle seats", 0.8, {
            metadata: { rootMemoryId: "travel-seat" },
            version: 2,
          }),
        ],
      ),
    );

    expect(prompt).not.toContain("raw provider response");
    expect(prompt).not.toContain("sm_fixture_should_not_render");
    expect(prompt).toContain("api_key=[redacted]");
    expect(prompt.match(/concise answers/g)).toHaveLength(1);
    expect(prompt).not.toContain("paper tickets");
    expect(prompt).not.toContain("window seats");
    expect(prompt).toContain("aisle seats");
  });
});
