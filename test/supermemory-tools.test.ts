import { describe, expect, it, vi } from "vitest";
import { createMemoryTools } from "../server/memory/tools.js";
import {
  type ForgetMatchingResult,
  type ImageAnchor,
  type MemoryOperationDependencies,
  type MemoryOperationProvider,
  type PendingOperation,
  type PendingOperationStore,
} from "../server/memory/supermemory/operations.js";
import { SupermemoryService } from "../server/memory/supermemory/service.js";
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

const CONFIGURATION: MemoryProviderConfiguration = {
  timeoutMs: 1_200,
  threshold: 0.6,
  searchLimit: 8,
  dreaming: "dynamic",
  apiKeyConfigured: true,
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

class PendingStore implements PendingOperationStore {
  operation: PendingOperation | null = null;

  async create(
    input: Omit<PendingOperation, "status" | "createdAt" | "completedAt"> & { now: number },
  ) {
    this.operation = { ...input, status: "pending", createdAt: input.now };
    return this.operation;
  }

  async confirm(input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    now: number;
  }) {
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

  async complete(input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    now: number;
  }) {
    if (!this.operation || this.operation.status !== "confirmed") {
      return { ok: false as const, reason: "invalid_status" as const };
    }
    this.operation = { ...this.operation, status: "completed", completedAt: input.now };
    return { ok: true as const, operation: this.operation };
  }

  async cancel() {
    return { ok: false as const, reason: "not_found" as const };
  }

  async expire() {
    return { ok: false as const, reason: "not_found" as const };
  }
}

function operationDependencies(): MemoryOperationDependencies & {
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
  const provider: MemoryOperationProvider = {
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
    provider,
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

function fixture(input?: {
  search?: DanielMemoryProvider["search"];
  imageStorageIds?: string[];
}) {
  const operations = operationDependencies();
  const service = new SupermemoryService({
    owner: OWNER,
    turnId: "turn_tools",
    provider: provider(input?.search),
    configuration: CONFIGURATION,
    operations,
  });
  const tools = createMemoryTools({
    service,
    imageStorageIds: input?.imageStorageIds ?? ["storage_1"],
  });
  return { operations, service, tools };
}

function tool(tools: ReturnType<typeof createMemoryTools>, name: string) {
  const selected = tools.find((candidate) => candidate.name === name);
  if (!selected) throw new Error(`Missing tool ${name}`);
  return selected;
}

describe("Implementation 10 Supermemory tools", () => {
  it("exposes only the direct Supermemory tool surface", () => {
    expect(fixture().tools.map(({ name }) => name)).toEqual([
      "remember_memory",
      "recall",
      "update_memory",
      "forget_memory",
      "remember_image",
    ]);
  });

  it("remembers one exact fact synchronously through the thin service facade", async () => {
    const { operations, tools } = fixture();
    const result = await tool(tools, "remember_memory").handle({
      content: "The user's preferred name is Alex.",
      staticKind: "preferred_name",
    });

    expect(result).toMatchObject({ success: true });
    expect(result.text).toContain("provider_created");
    expect(operations.provider.createExact).toHaveBeenCalledWith({
      containerTag: OWNER.containerTag,
      memories: [
        expect.objectContaining({
          content: "The user's preferred name is Alex.",
          isStatic: true,
          metadata: expect.objectContaining({
            conversationKey: OWNER.conversationKey,
            turnId: "turn_tools",
          }),
        }),
      ],
    });
  });

  it("returns truthful empty recall and fails open on provider errors", async () => {
    const empty = fixture();
    await expect(tool(empty.tools, "recall").handle({ query: "unknown" })).resolves.toMatchObject({
      success: true,
      text: "No memories matched.",
    });

    const unavailable = fixture({ search: vi.fn(async () => Promise.reject(new TypeError("offline"))) });
    const result = await tool(unavailable.tools, "recall").handle({ query: "seat preference" });
    expect(result.success).toBe(false);
    expect(result.text).toContain("Continue the conversation");
    expect(result.text).not.toContain("offline");
  });

  it("searches update candidates before updating one exact selected ID", async () => {
    const { operations, tools } = fixture();
    const update = tool(tools, "update_memory");

    expect((await update.handle({ query: "dark mode" })).text).toContain("provider_old");
    const updated = await update.handle({
      memoryId: "provider_old",
      newContent: "The user now prefers light mode.",
    });

    expect(updated.text).toContain("provider_new");
    expect(operations.provider.updateExact).toHaveBeenCalledWith({
      containerTag: OWNER.containerTag,
      id: "provider_old",
      newContent: "The user now prefers light mode.",
      metadata: undefined,
    });
    expect((await update.handle({ query: "dark", memoryId: "provider_old" })).success).toBe(false);
  });

  it("previews forget once and confirms only the stored exact IDs", async () => {
    const { operations, tools } = fixture();
    const forget = tool(tools, "forget_memory");

    const preview = await forget.handle({ query: "Rome trip" });
    expect(preview.text).toContain("memory-op-tools");
    const confirmed = await forget.handle({ operationId: "memory-op-tools", confirm: true });

    expect(confirmed.text).toBe("Forgot 1 confirmed memory.");
    expect(operations.provider.previewForget).toHaveBeenCalledOnce();
    expect(operations.provider.applyExactForget).toHaveBeenCalledWith({
      containerTag: OWNER.containerTag,
      ids: ["provider_rome"],
      reason: undefined,
    });
  });

  it("remembers only an exact current-turn image synchronously", async () => {
    const { operations, tools } = fixture();
    const rememberImage = tool(tools, "remember_image");

    const foreign = await rememberImage.handle({ storageId: "storage_from_another_turn" });
    expect(foreign.success).toBe(false);
    expect(operations.fetchImageBytes).not.toHaveBeenCalled();

    const result = await rememberImage.handle({ storageId: "storage_1" });
    expect(result.text).toContain("provider_image");
    expect(operations.fetchImageBytes).toHaveBeenCalledWith("storage_1");
    expect(operations.provider.uploadImage).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: OWNER.containerTag,
        mediaType: "image/png",
        metadata: expect.objectContaining({ reason: "remember_image_tool" }),
      }),
    );
  });
});
