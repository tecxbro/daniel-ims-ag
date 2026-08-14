import { describe, expect, it, vi } from "vitest";
import {
  createMemoryTools,
  type CreateMemoryToolsOptions,
  type LegacyMemoryRecall,
} from "../server/memory/tools.js";
import type {
  ForgetMatchingResult,
  ImageAnchor,
  MemoryOperationDependencies,
  MemoryOperationProvider,
  PendingOperation,
  PendingOperationStore,
} from "../server/memory/supermemory/operations.js";
import type {
  DanielMemoryProvider,
  MemoryOwnerContext,
  MemoryProviderConfiguration,
} from "../server/memory/supermemory/types.js";

const OWNER_KEY = "a".repeat(32);
const OWNER: MemoryOwnerContext = {
  memoryOwnerId: "fixture-user",
  ownerKey: OWNER_KEY,
  containerTag: `daniel-user-${OWNER_KEY}`,
  conversationId: "conversation_a",
  conversationKey: "daniel-conversation-a",
  customId: "daniel-conv-a",
  saltFingerprint: "salt-fingerprint-a",
};

const BASE_CONFIG: Pick<
  MemoryProviderConfiguration,
  | "readMode"
  | "writeMode"
  | "timeoutMs"
  | "threshold"
  | "searchLimit"
  | "legacyFallback"
> = {
  readMode: "shadow",
  writeMode: "dual",
  timeoutMs: 1_200,
  threshold: 0.6,
  searchLimit: 8,
  legacyFallback: true,
};

function memoryResult(id: string, content: string) {
  return {
    id,
    content,
    kind: "memory" as const,
    similarity: 0.91,
    metadata: null,
  };
}

function provider(
  search: DanielMemoryProvider["search"] = vi.fn(async () => []),
): Pick<DanielMemoryProvider, "profile" | "search"> {
  return {
    profile: vi.fn(async () => ({
      provider: "supermemory",
      profile: { static: [], dynamic: [] },
      results: [],
      latencyMs: 1,
    })),
    search,
  };
}

function legacyRecall(content = "Legacy aisle-seat preference") {
  return vi.fn(async (): Promise<LegacyMemoryRecall> => ({
    mode: "substring",
    results: [
      {
        memoryId: "legacy_1",
        content,
        tier: "long",
        segment: "preference",
        importance: 0.8,
      },
    ],
  }));
}

class PendingStore implements PendingOperationStore {
  operation: PendingOperation | null = null;

  async create(input: Omit<PendingOperation, "status" | "createdAt" | "completedAt"> & { now: number }) {
    this.operation = {
      ...input,
      status: "pending",
      createdAt: input.now,
    };
    return this.operation;
  }

  async confirm(input: { operationId: string; ownerKey: string; conversationId: string; now: number }) {
    if (
      !this.operation ||
      this.operation.operationId !== input.operationId ||
      this.operation.ownerKey !== input.ownerKey ||
      this.operation.conversationId !== input.conversationId
    ) {
      return { ok: false as const, reason: "not_found" as const };
    }
    this.operation = { ...this.operation, status: "confirmed" };
    return { ok: true as const, operation: this.operation };
  }

  async complete(input: { operationId: string; ownerKey: string; conversationId: string; now: number }) {
    const confirmed = await this.confirm(input);
    if (!confirmed.ok) return confirmed;
    this.operation = { ...confirmed.operation, status: "completed", completedAt: input.now };
    return { ok: true as const, operation: this.operation };
  }

  async cancel() {
    return { ok: false as const, reason: "not_found" as const };
  }

  async expire() {
    return { ok: false as const, reason: "not_found" as const };
  }
}

function operations(): MemoryOperationDependencies & {
  provider: MemoryOperationProvider;
  pendingOperations: PendingStore;
} {
  const pendingOperations = new PendingStore();
  let anchor: ImageAnchor | null = null;
  const preview: ForgetMatchingResult = {
    dryRun: true,
    count: 1,
    forgetBatchId: null,
    summary: "one memory",
    candidates: [{ id: "provider_rome", memory: "The Rome trip is in May", score: 0.9 }],
    forgotten: [],
  };
  const operationProvider: MemoryOperationProvider = {
    search: vi.fn(async () => [memoryResult("provider_old", "The user prefers dark mode")]),
    createExact: vi.fn(async (input) => ({
      documentId: "provider_doc",
      memories: [
        {
          id: "provider_created",
          content: input.memories[0].content,
          isStatic: input.memories[0].isStatic,
        },
      ],
    })),
    updateExact: vi.fn(async (input) => ({
      id: "provider_new",
      content: input.newContent,
      version: 2,
      parentMemoryId: input.id,
      rootMemoryId: input.id,
    })),
    forgetExact: vi.fn(async (input) => ({ id: String(input.id), forgotten: true })),
    previewForget: vi.fn(async () => preview),
    applyExactForget: vi.fn(async (input) => ({
      ...preview,
      dryRun: false,
      forgetBatchId: "batch_1",
      candidates: [],
      forgotten: input.ids.map((id) => ({ id, memory: "The Rome trip is in May", score: 1 })),
    })),
    uploadImage: vi.fn(async () => ({ id: "provider_image", status: "queued" })),
    deleteDocument: vi.fn(async () => undefined),
  };

  return {
    provider: operationProvider,
    pendingOperations,
    imageAnchors: {
      async createPending(input) {
        anchor = { ...input, status: "pending", createdAt: 1 };
        return anchor;
      },
      async activate(input) {
        if (!anchor) throw new Error("missing anchor");
        anchor = { ...anchor, status: "active", providerDocumentId: input.providerDocumentId };
        return anchor;
      },
      async loadActiveByCustomId() {
        return anchor?.status === "active" ? anchor : null;
      },
      async releaseAfterProviderDeletion(input) {
        if (!anchor) throw new Error("missing anchor");
        anchor = { ...anchor, status: "released", releasedAt: input.now };
        return anchor;
      },
    },
    fetchImageBytes: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    })),
    now: () => 1_000,
    createOperationId: () => "memory-op-tools",
    log: { info: vi.fn() },
  };
}

function options(
  overrides: Partial<CreateMemoryToolsOptions> = {},
): CreateMemoryToolsOptions {
  return {
    owner: OWNER,
    turnId: "turn_tools",
    imageStorageIds: ["storage_1"],
    config: BASE_CONFIG,
    provider: provider(),
    operationDependencies: operations(),
    legacyRecall: legacyRecall(),
    legacyWrite: vi.fn(async (input) => ({
      memoryId: "legacy_created",
      tier: input.tier ?? "long",
      segment: input.segment,
    })),
    ...overrides,
  };
}

function tool(tools: ReturnType<typeof createMemoryTools>, name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  if (!selected) throw new Error(`Missing tool ${name}`);
  return selected;
}

describe("Implementation 7 memory tools", () => {
  it("keeps shadow recall user-facing output on Convex while executing the provider query", async () => {
    const providerSearch = vi.fn(async () => [memoryResult("provider_1", "Provider-only preference")]);
    const legacy = legacyRecall();
    const tools = createMemoryTools(
      options({ provider: provider(providerSearch), legacyRecall: legacy }),
    );

    const result = await tool(tools, "recall").handle({ query: "seat preference" });

    expect(result.text).toContain("Legacy aisle-seat preference");
    expect(result.text).not.toContain("Provider-only preference");
    expect(providerSearch).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag: OWNER.containerTag, q: "seat preference" }),
    );
    expect(legacy).toHaveBeenCalledOnce();
  });

  it("uses Supermemory recall after cutover and falls back only on provider failure", async () => {
    const legacy = legacyRecall();
    const successfulSearch = vi.fn(async () => [memoryResult("provider_1", "Provider aisle-seat preference")]);
    const successful = createMemoryTools(
      options({
        config: { ...BASE_CONFIG, readMode: "supermemory" },
        provider: provider(successfulSearch),
        legacyRecall: legacy,
      }),
    );

    const found = await tool(successful, "recall").handle({ query: "seat preference" });
    expect(found.text).toContain("Provider aisle-seat preference");
    expect(legacy).not.toHaveBeenCalled();

    const empty = createMemoryTools(
      options({
        config: { ...BASE_CONFIG, readMode: "supermemory" },
        provider: provider(vi.fn(async () => [])),
        legacyRecall: legacy,
      }),
    );
    expect((await tool(empty, "recall").handle({ query: "unknown" })).text).toBe(
      "No memories matched.",
    );
    expect(legacy).not.toHaveBeenCalled();

    const failed = createMemoryTools(
      options({
        config: { ...BASE_CONFIG, readMode: "supermemory", legacyFallback: true },
        provider: provider(vi.fn(async () => { throw new Error("provider unavailable"); })),
        legacyRecall: legacy,
      }),
    );
    expect((await tool(failed, "recall").handle({ query: "seat preference" })).text).toContain(
      "Legacy aisle-seat preference",
    );
    expect(legacy).toHaveBeenCalledOnce();

    const isolatedLegacy = legacyRecall();
    const isolated = createMemoryTools(
      options({
        owner: { ...OWNER, containerTag: "daniel-user-wrong-owner" },
        config: { ...BASE_CONFIG, readMode: "supermemory", legacyFallback: true },
        provider: provider(successfulSearch),
        legacyRecall: isolatedLegacy,
      }),
    );
    const rejected = await tool(isolated, "recall").handle({ query: "seat preference" });
    expect(rejected.success).toBe(false);
    expect(isolatedLegacy).not.toHaveBeenCalled();
  });

  it("writes an exact provider memory plus the Convex rollback copy in dual mode", async () => {
    const deps = operations();
    const legacyWrite = vi.fn(async (input) => ({
      memoryId: "legacy_created",
      tier: input.tier ?? "permanent" as const,
      segment: input.segment,
    }));
    const tools = createMemoryTools(
      options({ operationDependencies: deps, legacyWrite }),
    );

    const result = await tool(tools, "write_memory").handle({
      content: "The user's preferred name is Alex.",
      segment: "identity",
      importance: 0.95,
      staticKind: "preferred_name",
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain("provider_created");
    expect(result.text).toContain("legacy_created");
    expect(deps.provider.createExact).toHaveBeenCalledWith({
      containerTag: OWNER.containerTag,
      memories: [
        expect.objectContaining({
          content: "The user's preferred name is Alex.",
          isStatic: true,
        }),
      ],
    });
    expect(legacyWrite).toHaveBeenCalledOnce();
  });

  it("still writes the Convex rollback copy when the dual-write provider is unavailable", async () => {
    const legacyWrite = vi.fn(async (input) => ({
      memoryId: "legacy_rollback_only",
      tier: input.tier ?? "long" as const,
      segment: input.segment,
    }));
    const tools = createMemoryTools(
      options({
        provider: null,
        operationDependencies: null,
        legacyWrite,
      }),
    );

    const result = await tool(tools, "write_memory").handle({
      content: "The user prefers window seats.",
      segment: "preference",
      importance: 0.8,
    });

    expect(result.success).toBe(false);
    expect(result.text).toContain("legacy_rollback_only");
    expect(result.text).toContain("Supermemory exact write was unavailable");
    expect(legacyWrite).toHaveBeenCalledOnce();
  });

  it("searches update candidates, then versions only an exact selected ID", async () => {
    const deps = operations();
    const tools = createMemoryTools(options({ operationDependencies: deps }));
    const update = tool(tools, "update_memory");

    const candidates = await update.handle({ query: "dark mode" });
    expect(candidates.text).toContain("provider_old");
    expect(deps.provider.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: "dark mode", containerTag: OWNER.containerTag }),
    );

    const updated = await update.handle({
      memoryId: "provider_old",
      newContent: "The user now prefers light mode.",
    });
    expect(updated.text).toContain("provider_new");
    expect(deps.provider.updateExact).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "provider_old",
        newContent: "The user now prefers light mode.",
        containerTag: OWNER.containerTag,
      }),
    );
  });

  it("previews forget once and confirms the stored exact IDs without rerunning semantics", async () => {
    const deps = operations();
    const forget = tool(
      createMemoryTools(options({ operationDependencies: deps })),
      "forget_memory",
    );

    const preview = await forget.handle({ query: "Rome trip" });
    expect(preview.text).toContain("memory-op-tools");
    expect(preview.text).toContain("Rome trip");

    const confirmed = await forget.handle({
      operationId: "memory-op-tools",
      confirm: true,
    });
    expect(confirmed.text).toBe("Forgot 1 confirmed memory.");
    expect(deps.provider.previewForget).toHaveBeenCalledOnce();
    expect(deps.provider.applyExactForget).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["provider_rome"], containerTag: OWNER.containerTag }),
    );
  });

  it("routes explicitly durable images through the anchor-backed image operation", async () => {
    const deps = operations();
    const rememberImage = tool(
      createMemoryTools(options({ operationDependencies: deps })),
      "remember_image",
    );

    const foreign = await rememberImage.handle({ storageId: "storage_from_another_turn" });
    expect(foreign.success).toBe(false);
    expect(deps.fetchImageBytes).not.toHaveBeenCalled();

    const result = await rememberImage.handle({ storageId: "storage_1" });

    expect(result.text).toContain("provider_image");
    expect(deps.fetchImageBytes).toHaveBeenCalledWith("storage_1");
    expect(deps.provider.uploadImage).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: OWNER.containerTag,
        mediaType: "image/png",
        metadata: expect.objectContaining({ reason: "remember_image_tool" }),
      }),
    );
  });
});
