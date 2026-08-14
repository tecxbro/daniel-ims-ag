import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SupermemoryAdapter,
  SupermemoryProviderError,
  createConfiguredSupermemoryProvider,
  readMemoryProviderConfiguration,
  shouldInitializeSupermemoryClient,
  type SupermemorySdkClient,
} from "../server/memory/supermemory/client.js";
import { deriveMemoryIdentity } from "../server/memory/supermemory/identity.js";
import { createConfiguredSupermemoryService } from "../server/memory/supermemory/service.js";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".js", ".jsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Supermemory foundation configuration", () => {
  it("reports an unconfigured provider when the API key is absent", () => {
    const config = readMemoryProviderConfiguration({});
    expect(config).toEqual({
      timeoutMs: 1200,
      threshold: 0.6,
      searchLimit: 8,
      dreaming: "dynamic",
      apiKeyConfigured: false,
    });
    expect(shouldInitializeSupermemoryClient(config)).toBe(false);
  });

  it("does not initialize or call the SDK when the API key is absent", () => {
    const sdkFactory = vi.fn();
    expect(createConfiguredSupermemoryProvider({ env: {}, sdkFactory })).toBeNull();
    expect(
      createConfiguredSupermemoryService({
        owner: deriveMemoryIdentity(
          { memoryOwnerId: "fixture-user", conversationId: "fixture-conversation" },
          { salt: "b".repeat(64) },
        ),
        turnId: "turn_1",
        env: {},
      }),
    ).toBeNull();
    expect(sdkFactory).not.toHaveBeenCalled();
  });

  it("initializes the provider only for a non-empty API key", () => {
    const sdkFactory = vi.fn(() => ({
      add: vi.fn(),
      profile: vi.fn(),
      search: vi.fn(),
    }));
    const config = readMemoryProviderConfiguration({ SUPERMEMORY_API_KEY: "fixture-api-key" });

    expect(config.apiKeyConfigured).toBe(true);
    expect(shouldInitializeSupermemoryClient(config)).toBe(true);
    expect(
      createConfiguredSupermemoryProvider({
        env: { SUPERMEMORY_API_KEY: "fixture-api-key" },
        sdkFactory,
      }),
    ).toBeInstanceOf(SupermemoryAdapter);
    expect(sdkFactory).toHaveBeenCalledOnce();
  });

  it("keeps server secrets and the SDK out of browser source", () => {
    const browserRoot = resolve(process.cwd(), "debug/src");
    const browserSource = sourceFiles(browserRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(browserSource).not.toContain("SUPERMEMORY_API_KEY");
    expect(browserSource).not.toContain("DANIEL_MEMORY_ID_SALT");
    expect(browserSource).not.toMatch(/from\s+["']supermemory["']/);
    expect(browserSource).not.toMatch(/server\/memory\/supermemory/);
  });

  it("keeps tool handlers on a thin Supermemory service facade", () => {
    const interactionSource = readFileSync(resolve(process.cwd(), "server/interaction-agent.ts"), "utf8");
    const serviceSource = readFileSync(
      resolve(process.cwd(), "server/memory/supermemory/service.ts"),
      "utf8",
    );
    const toolsSource = readFileSync(resolve(process.cwd(), "server/memory/tools.ts"), "utf8");
    expect(interactionSource).toContain('from "./memory/tools.js"');
    expect(interactionSource).toContain("createConfiguredSupermemoryService(");
    expect(serviceSource).toContain('from "./context.js"');
    expect(serviceSource).toContain('from "./operations.js"');
    expect(serviceSource).toContain("retries: 0");
    expect(toolsSource).toContain('from "./supermemory/service.js"');
    expect(toolsSource).not.toContain('from "./supermemory/operations.js"');
  });

  it("keeps memory owner and conversation identity distinct at current entry points", () => {
    const imessageSource = readFileSync(resolve(process.cwd(), "server/imessage.ts"), "utf8");
    const serverSource = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");
    expect(imessageSource).toContain("memoryOwnerId: fromNumber");
    expect(imessageSource).toContain("const conversationId = conversationIdForPhone(fromNumber)");
    expect(serverSource).toContain("resolveChatMemoryOwnerId");
    expect(serverSource).toContain("memoryOwnerId: resolvedMemoryOwnerId");
    expect(serverSource).not.toContain('memoryOwnerId: memoryOwnerId || "local-default"');
  });
});

describe("Supermemory adapter contract", () => {
  it("uses current SDK add/search/profile calls and normalizes their responses", async () => {
    const add = vi.fn(async () => ({ id: "doc_1", status: "queued" }));
    const profile = vi.fn(async () => ({
      profile: { static: ["Prefers concise answers"], dynamic: ["Planning a launch"] },
      searchResults: {
        results: [
          {
            id: "mem_1",
            memory: "The user prefers concise answers",
            similarity: 0.91,
            metadata: { source: "conversation" },
            updatedAt: "2026-08-13T00:00:00.000Z",
          },
        ],
        total: 1,
        timing: 10,
      },
    }));
    const search = vi.fn(async () => ({
      results: [
        {
          id: "chunk_1",
          chunk: "Launch checklist",
          similarity: 0.82,
          metadata: null,
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      total: 1,
      timing: 8,
    }));
    const listDocuments = vi.fn(async () => ({
      memories: [
        {
          id: "doc_1",
          customId: "turn_1",
          status: "done",
          title: "Conversation turn",
          summary: "A short turn summary",
          type: "text",
          metadata: { source: "daniel" },
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:01:00.000Z",
        },
      ],
      pagination: { currentPage: 1, totalItems: 1, totalPages: 1 },
    }));
    const sdk = {
      add,
      profile,
      search,
      documents: { list: listDocuments },
    } satisfies SupermemorySdkClient;
    const sdkFactory = vi.fn(() => sdk);
    const adapter = new SupermemoryAdapter({
      apiKey: "test-api-key",
      timeoutMs: 1200,
      sdkFactory,
      fetchImpl: vi.fn(),
    });

    await expect(
      adapter.captureTurn({
        content: "USER: hello\nDANIEL: hi",
        containerTag: "daniel-user-abc123",
        customId: "daniel-conv-def456",
        taskType: "memory",
      }),
    ).resolves.toEqual({ id: "doc_1", status: "queued" });
    await expect(
      adapter.profile({
        containerTag: "daniel-user-abc123",
        q: "hello",
        threshold: 0.6,
      }),
    ).resolves.toMatchObject({
      provider: "supermemory",
      profile: { static: ["Prefers concise answers"], dynamic: ["Planning a launch"] },
      results: [{ id: "mem_1", kind: "memory", similarity: 0.91 }],
    });
    await expect(
      adapter.search({
        containerTag: "daniel-user-abc123",
        q: "launch",
        searchMode: "hybrid",
        limit: 8,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "chunk_1", content: "Launch checklist", kind: "chunk" }),
    ]);
    await expect(
      adapter.listDocuments({ containerTag: "daniel-user-abc123", page: 1, limit: 20 }),
    ).resolves.toMatchObject({
      documents: [{ id: "doc_1", customId: "turn_1", status: "done" }],
      page: 1,
      totalItems: 1,
      totalPages: 1,
    });

    expect(sdkFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-api-key",
        baseURL: "https://api.supermemory.ai",
        timeout: 1200,
        maxRetries: 0,
      }),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: "daniel-user-abc123",
        customId: "daniel-conv-def456",
      }),
      // Durable writes are retried by memorySyncJobs so the SDK must not add
      // hidden attempts outside the outbox's exact retry schedule.
      { timeout: 1200, maxRetries: 0 },
    );
    expect(profile).toHaveBeenCalledWith(expect.any(Object), { timeout: 1200, maxRetries: 0 });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: "daniel-user-abc123", searchMode: "hybrid" }),
      { timeout: 1200, maxRetries: 0 },
    );
    expect(listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTags: ["daniel-user-abc123"],
        includeContent: false,
      }),
      { timeout: 1200, maxRetries: 0 },
    );
  });

  it("uses typed v4 fetch wrappers with singular containerTag", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === "POST") {
        return jsonResponse(
          {
            documentId: "doc_1",
            memories: [
              {
                id: "mem_1",
                memory: "The user prefers dark mode",
                isStatic: true,
                createdAt: "2026-08-13T00:00:00.000Z",
              },
            ],
          },
          201,
        );
      }
      if (init?.method === "PATCH") {
        return jsonResponse({
          id: "mem_2",
          memory: "The user now prefers light mode",
          version: 2,
          parentMemoryId: "mem_1",
          rootMemoryId: "mem_1",
        });
      }
      return jsonResponse({ id: "mem_2", forgotten: true });
    });
    const sdk = {
      add: vi.fn(),
      profile: vi.fn(),
      search: vi.fn(),
    } as unknown as SupermemorySdkClient;
    const adapter = new SupermemoryAdapter({
      apiKey: "test-api-key",
      sdkFactory: () => sdk,
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(
      adapter.createExact({
        containerTag: "daniel-user-abc123",
        memories: [{ content: "The user prefers dark mode", isStatic: true }],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "mem_1", content: "The user prefers dark mode" }),
    ]);
    await expect(
      adapter.update({
        containerTag: "daniel-user-abc123",
        id: "mem_1",
        newContent: "The user now prefers light mode",
      }),
    ).resolves.toEqual(expect.objectContaining({ id: "mem_2", version: 2 }));
    await expect(
      adapter.forget({ containerTag: "daniel-user-abc123", id: "mem_2" }),
    ).resolves.toBeUndefined();

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://api.supermemory.ai/v4/memories"],
      ["PATCH", "https://api.supermemory.ai/v4/memories"],
      ["DELETE", "https://api.supermemory.ai/v4/memories"],
    ]);
    for (const request of requests) {
      const body = JSON.parse(String(request.init?.body));
      expect(body.containerTag).toBe("daniel-user-abc123");
      expect(body).not.toHaveProperty("containerTags");
      expect(new Headers(request.init?.headers).get("Authorization")).toBe("Bearer test-api-key");
    }
  });

  it("normalizes provider failures without leaking credentials", async () => {
    const adapter = new SupermemoryAdapter({
      apiKey: "never-leak-this-key",
      sdkFactory: () =>
        ({
          add: vi.fn(async () => {
            throw new TypeError("fetch failed");
          }),
          profile: vi.fn(),
          search: vi.fn(),
        }) as unknown as SupermemorySdkClient,
      fetchImpl: vi.fn(),
    });

    const error = await adapter
      .captureTurn({
        content: "hello",
        containerTag: "daniel-user-abc123",
        customId: "daniel-conv-def456",
      })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(SupermemoryProviderError);
    expect(String(error)).not.toContain("never-leak-this-key");
  });

  it("does not retry an exact mutation after an ambiguous network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("socket closed after write");
    });
    const adapter = new SupermemoryAdapter({
      apiKey: "test-api-key",
      sdkFactory: () =>
        ({ add: vi.fn(), profile: vi.fn(), search: vi.fn() }) as unknown as SupermemorySdkClient,
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
    });

    await expect(
      adapter.createExact({
        containerTag: "daniel-user-abc123",
        memories: [{ content: "The user prefers concise answers.", isStatic: false }],
      }),
    ).rejects.toBeInstanceOf(SupermemoryProviderError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
