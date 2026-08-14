import { describe, expect, it, vi } from "vitest";
import type { Doc } from "../convex/_generated/dataModel.js";
import { inspectPendingOperation } from "../convex/memoryPendingOperations.js";
import {
  applyExactForget,
  cancelPendingOperation,
  createExactMemory,
  forgetDurableImageSource,
  previewForget,
  rememberDurableImage,
  searchMemoryCandidatesForUpdate,
  SupermemoryOperationTransport,
  updateExactMemory,
  type ForgetCandidate,
  type ForgetMatchingResult,
  type ImageAnchorStore,
  type MemoryOperationDependencies,
  type MemoryOperationProvider,
  type PendingOperation,
  type PendingOperationStore,
  type PendingOperationTransitionResult,
} from "../server/memory/supermemory/operations.js";
import type {
  CreateExactMemoryInput,
  MemorySearchResult,
  ProviderMemoryResult,
} from "../server/memory/supermemory/types.js";

class InMemoryPendingStore implements PendingOperationStore {
  readonly operations = new Map<string, PendingOperation>();

  async create(
    input: Omit<PendingOperation, "status" | "createdAt" | "completedAt"> & { now: number },
  ): Promise<PendingOperation> {
    const operation: PendingOperation = { ...input, status: "pending", createdAt: input.now };
    this.operations.set(input.operationId, operation);
    return operation;
  }

  async confirm(input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    now: number;
  }): Promise<PendingOperationTransitionResult> {
    const operation = this.owned(input);
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status === "pending" && operation.expiresAt <= input.now) {
      operation.status = "expired";
      return { ok: false, reason: "expired" };
    }
    if (operation.status === "confirmed") return { ok: true, operation };
    if (operation.status === "cancelled") return { ok: false, reason: "cancelled" };
    if (operation.status === "completed") return { ok: false, reason: "completed" };
    if (operation.status === "expired") return { ok: false, reason: "expired" };
    operation.status = "confirmed";
    return { ok: true, operation };
  }

  async complete(input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    now: number;
  }): Promise<PendingOperationTransitionResult> {
    const operation = this.owned(input);
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status !== "confirmed") return { ok: false, reason: "invalid_status" };
    operation.status = "completed";
    operation.completedAt = input.now;
    return { ok: true, operation };
  }

  async cancel(input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    now: number;
  }): Promise<PendingOperationTransitionResult> {
    const operation = this.owned(input);
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status === "cancelled") return { ok: true, operation };
    if (operation.status !== "pending") return { ok: false, reason: "invalid_status" };
    operation.status = "cancelled";
    return { ok: true, operation };
  }

  async expire(input: {
    operationId: string;
    ownerKey: string;
    conversationId: string;
    now: number;
  }): Promise<PendingOperationTransitionResult> {
    const operation = this.owned(input);
    if (!operation) return { ok: false, reason: "not_found" };
    if (operation.status !== "pending" || operation.expiresAt > input.now) {
      return { ok: false, reason: "invalid_status" };
    }
    operation.status = "expired";
    return { ok: true, operation };
  }

  private owned(input: { operationId: string; ownerKey: string; conversationId: string }) {
    const operation = this.operations.get(input.operationId);
    if (!operation) return null;
    if (operation.ownerKey !== input.ownerKey || operation.conversationId !== input.conversationId) {
      throw new Error("Pending operation not found");
    }
    return operation;
  }
}

type FakeMemory = ProviderMemoryResult & { isLatest: boolean; forgotten: boolean };

class StatefulProvider implements MemoryOperationProvider {
  readonly memories = new Map<string, FakeMemory>();
  readonly previewQueries: string[] = [];
  readonly exactApplyIds: string[][] = [];
  private nextId = 1;

  async search(input: { q: string }): Promise<MemorySearchResult[]> {
    const query = input.q.toLowerCase();
    return [...this.memories.values()]
      .filter(
        (memory) =>
          memory.isLatest && !memory.forgotten && memory.content.toLowerCase().includes(query),
      )
      .map((memory) => ({
        id: memory.id,
        content: memory.content,
        kind: "memory" as const,
        similarity: 0.99,
        metadata: memory.metadata ?? null,
        version: memory.version,
      }));
  }

  async createExact(input: CreateExactMemoryInput) {
    const memories = input.memories.map((memory) => {
      const id = `mem_${this.nextId++}`;
      const created: FakeMemory = {
        id,
        content: memory.content,
        isStatic: memory.isStatic,
        metadata: memory.metadata ?? null,
        version: 1,
        parentMemoryId: null,
        rootMemoryId: id,
        isLatest: true,
        forgotten: false,
      };
      this.memories.set(id, created);
      return created;
    });
    return { documentId: `doc_${this.nextId}`, memories };
  }

  async updateExact(input: { id?: string; newContent: string }): Promise<ProviderMemoryResult> {
    const previous = this.memories.get(String(input.id));
    if (!previous) throw new Error("not found");
    previous.isLatest = false;
    const id = `mem_${this.nextId++}`;
    const updated: FakeMemory = {
      ...previous,
      id,
      content: input.newContent,
      version: (previous.version ?? 1) + 1,
      parentMemoryId: previous.id,
      rootMemoryId: previous.rootMemoryId ?? previous.id,
      isLatest: true,
      forgotten: false,
    };
    this.memories.set(id, updated);
    return updated;
  }

  async forgetExact(input: { id?: string }) {
    const memory = this.memories.get(String(input.id));
    if (!memory) throw new Error("not found");
    memory.forgotten = true;
    return { id: memory.id, forgotten: true };
  }

  async previewForget(input: { query: string }): Promise<ForgetMatchingResult> {
    this.previewQueries.push(input.query);
    const query = input.query.toLowerCase().replace(/^forget (everything )?(about )?/, "");
    const candidates: ForgetCandidate[] = [...this.memories.values()]
      .filter(
        (memory) =>
          memory.isLatest && !memory.forgotten && memory.content.toLowerCase().includes(query),
      )
      .map((memory) => ({ id: memory.id, memory: memory.content, score: 0.95 }));
    return forgetResult(true, candidates);
  }

  async applyExactForget(input: { ids: string[] }): Promise<ForgetMatchingResult> {
    this.exactApplyIds.push([...input.ids]);
    const forgotten = input.ids.map((id) => {
      const memory = this.memories.get(id);
      if (!memory) throw new Error("not found");
      memory.forgotten = true;
      return { id, memory: memory.content, score: 1 };
    });
    return forgetResult(false, forgotten);
  }

  async uploadImage() {
    return { id: "doc_image", status: "queued" };
  }

  async deleteDocument() {}
}

function forgetResult(dryRun: boolean, memories: ForgetCandidate[]): ForgetMatchingResult {
  return {
    dryRun,
    count: memories.length,
    forgetBatchId: dryRun ? null : "batch_1",
    summary: `${memories.length} memories`,
    candidates: dryRun ? memories : [],
    forgotten: dryRun ? [] : memories,
  };
}

const unusedImageAnchors = {} as ImageAnchorStore;

function dependencies(input?: {
  provider?: StatefulProvider;
  pending?: InMemoryPendingStore;
  now?: () => number;
}): MemoryOperationDependencies & {
  provider: StatefulProvider;
  pendingOperations: InMemoryPendingStore;
} {
  return {
    provider: input?.provider ?? new StatefulProvider(),
    pendingOperations: input?.pending ?? new InMemoryPendingStore(),
    imageAnchors: unusedImageAnchors,
    fetchImageBytes: vi.fn(),
    now: input?.now,
    createOperationId: () => "memory-op-test",
    log: { info: vi.fn() },
  };
}

const exactInput = {
  ownerKey: "owner_a",
  containerTag: "daniel-user-owner_a",
  conversationKey: "conversation_key",
  turnId: "turn_1",
};

describe("explicit and versioned Supermemory operations", () => {
  it("creates exact memories through the immediately-searchable path", async () => {
    const deps = dependencies();
    const createExact = vi.spyOn(deps.provider, "createExact");
    const created = await createExactMemory(
      { ...exactInput, content: "The user always prefers aisle seats on flights." },
      deps,
    );
    const results = await searchMemoryCandidatesForUpdate(
      { ownerKey: exactInput.ownerKey, containerTag: exactInput.containerTag, query: "aisle seats" },
      deps,
    );

    expect(created.memories).toHaveLength(1);
    expect(results).toEqual([
      expect.objectContaining({ id: created.memories[0].id, content: expect.stringContaining("aisle") }),
    ]);
    expect(createExact).toHaveBeenCalledWith({
      containerTag: exactInput.containerTag,
      memories: [
        expect.objectContaining({
          content: "The user always prefers aisle seats on flights.",
          metadata: expect.objectContaining({
            conversationKey: exactInput.conversationKey,
            turnId: exactInput.turnId,
          }),
        }),
      ],
    });
  });

  it("classifies static memories only through the durable identity whitelist", async () => {
    const deps = dependencies();
    const preference = await createExactMemory(
      { ...exactInput, content: "The user prefers aisle seats." },
      deps,
    );
    const name = await createExactMemory(
      { ...exactInput, turnId: "turn_2", content: "The user's preferred name is Alex.", staticKind: "preferred_name" },
      deps,
    );
    const unrecognized = await createExactMemory(
      { ...exactInput, turnId: "turn_3", content: "The user is working on Rome plans.", staticKind: "normal_preference" as never },
      deps,
    );

    expect(preference.isStatic).toBe(false);
    expect(name.isStatic).toBe(true);
    expect(unrecognized.isStatic).toBe(false);
  });

  it("updates one selected ID as a new version instead of a correction record", async () => {
    const deps = dependencies();
    const created = await createExactMemory(
      { ...exactInput, content: "The user prefers dark mode." },
      deps,
    );
    const oldId = created.memories[0].id;
    const result = await updateExactMemory(
      {
        ownerKey: exactInput.ownerKey,
        containerTag: exactInput.containerTag,
        memoryId: oldId,
        newContent: "The user now prefers light mode.",
      },
      deps,
    );

    expect(result).toMatchObject({
      oldMemoryId: oldId,
      newMemoryId: expect.not.stringMatching(new RegExp(`^${oldId}$`)),
      version: 2,
      parentMemoryId: oldId,
      oldIsLatest: false,
      newIsLatest: true,
    });
    expect(deps.provider.memories.get(oldId)?.isLatest).toBe(false);
    expect(deps.provider.memories.get(result.newMemoryId)?.isLatest).toBe(true);
  });

  it("uploads and later releases an exact durable image source synchronously", async () => {
    const provider = new StatefulProvider();
    const uploadImage = vi.spyOn(provider, "uploadImage");
    const deleteDocument = vi.spyOn(provider, "deleteDocument");
    let anchor: import("../server/memory/supermemory/operations.js").ImageAnchor | null = null;
    const deps: MemoryOperationDependencies = {
      ...dependencies({ provider }),
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
    };

    const remembered = await rememberDurableImage(
      {
        ownerKey: exactInput.ownerKey,
        containerTag: exactInput.containerTag,
        storageId: "storage_1",
        conversationId: "conversation_a",
        turnId: exactInput.turnId,
        reason: "remember_image_tool",
      },
      deps,
    );
    expect(remembered.providerDocumentId).toBe("doc_image");
    expect(uploadImage).toHaveBeenCalledOnce();

    await expect(
      forgetDurableImageSource(
        { ownerKey: exactInput.ownerKey, customId: remembered.anchor.customId },
        deps,
      ),
    ).resolves.toEqual({ customId: remembered.anchor.customId, released: true });
    expect(deleteDocument).toHaveBeenCalledWith("doc_image");
    expect(anchor).toMatchObject({ status: "released" });
  });
});

describe("two-stage exact forget", () => {
  it("requires a preview and confirms the stored exact IDs without rerunning semantics", async () => {
    const deps = dependencies();
    await createExactMemory(
      { ...exactInput, content: "The user's Rome trip includes a museum visit." },
      deps,
    );

    await expect(
      applyExactForget(
        {
          operationId: "missing",
          ownerKey: "owner_a",
          conversationId: "conversation_a",
          containerTag: exactInput.containerTag,
        },
        deps,
      ),
    ).rejects.toThrow(/unavailable/);
    expect(deps.provider.exactApplyIds).toHaveLength(0);

    const preview = await previewForget(
      {
        ownerKey: "owner_a",
        conversationId: "conversation_a",
        containerTag: exactInput.containerTag,
        query: "Forget everything about Rome trip",
      },
      deps,
    );
    const storedIds = deps.pendingOperations.operations.get(String(preview.operationId))?.providerMemoryIds;
    const applied = await applyExactForget(
      {
        operationId: String(preview.operationId),
        ownerKey: "owner_a",
        conversationId: "conversation_a",
        containerTag: exactInput.containerTag,
      },
      deps,
    );

    expect(deps.provider.previewQueries).toHaveLength(1);
    expect(deps.provider.exactApplyIds).toEqual([storedIds]);
    expect(applied.forgottenIds).toEqual(storedIds);
    expect(deps.pendingOperations.operations.get(String(preview.operationId))?.status).toBe("completed");
  });

  it("expires pending operations before a destructive call", async () => {
    let now = 1_000;
    const deps = dependencies({ now: () => now });
    await createExactMemory({ ...exactInput, content: "The user's Rome trip is in May." }, deps);
    const preview = await previewForget(
      {
        ownerKey: "owner_a",
        conversationId: "conversation_a",
        containerTag: exactInput.containerTag,
        query: "Rome trip",
        expiresInMs: 10,
      },
      deps,
    );
    now = 1_011;

    await expect(
      applyExactForget(
        {
          operationId: String(preview.operationId),
          ownerKey: "owner_a",
          conversationId: "conversation_a",
          containerTag: exactInput.containerTag,
        },
        deps,
      ),
    ).rejects.toThrow(/expired/);
    expect(deps.pendingOperations.operations.get(String(preview.operationId))?.status).toBe("expired");
    expect(deps.provider.exactApplyIds).toHaveLength(0);
  });

  it("does nothing after cancellation and refuses cross-user operation IDs", async () => {
    const deps = dependencies();
    await createExactMemory({ ...exactInput, content: "The user's Rome trip is in May." }, deps);
    const preview = await previewForget(
      {
        ownerKey: "owner_a",
        conversationId: "conversation_a",
        containerTag: exactInput.containerTag,
        query: "Rome trip",
      },
      deps,
    );

    await expect(
      applyExactForget(
        {
          operationId: String(preview.operationId),
          ownerKey: "owner_b",
          conversationId: "conversation_b",
          containerTag: "daniel-user-owner_b",
        },
        deps,
      ),
    ).rejects.toThrow(/not found/);

    await cancelPendingOperation(
      {
        operationId: String(preview.operationId),
        ownerKey: "owner_a",
        conversationId: "conversation_a",
      },
      deps,
    );
    await expect(
      applyExactForget(
        {
          operationId: String(preview.operationId),
          ownerKey: "owner_a",
          conversationId: "conversation_a",
          containerTag: exactInput.containerTag,
        },
        deps,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(deps.provider.exactApplyIds).toHaveLength(0);
  });

  it("the Convex ownership projection hides exact IDs from another owner", () => {
    const operation = {
      operationId: "op_secret",
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      type: "forget",
      providerMemoryIds: ["mem_secret"],
      preview: "secret",
      status: "pending",
      createdAt: 1,
      expiresAt: 100,
    } as unknown as Doc<"memoryPendingOperations">;

    expect(() =>
      inspectPendingOperation(operation, {
        ownerKey: "owner_b",
        conversationId: "conversation_b",
        now: 2,
      }),
    ).toThrow("Pending operation not found");
  });
});

describe("Supermemory operation wire contract", () => {
  it("uses query only for preview and stored IDs only for confirmation", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      const dryRun = body.dryRun === true;
      const memories = [{ id: "mem_1", memory: "The user's Rome trip is in May.", score: 0.9 }];
      return new Response(
        JSON.stringify({
          dryRun,
          count: 1,
          forgetBatchId: dryRun ? null : "batch_1",
          summary: "one memory",
          ...(dryRun ? { candidates: memories } : { forgotten: memories }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const transport = new SupermemoryOperationTransport({
      apiKey: "test-api-key",
      fetchImpl: fetchImpl as typeof fetch,
      retries: 0,
    });

    await transport.previewForget({
      containerTag: "daniel-user-owner_a",
      query: "Rome trip",
    });
    await transport.applyExactForget({
      containerTag: "daniel-user-owner_a",
      ids: ["mem_1"],
    });

    expect(requests).toEqual([
      {
        url: "https://api.supermemory.ai/v4/memories/forget-matching",
        body: expect.objectContaining({ query: "Rome trip", dryRun: true }),
      },
      {
        url: "https://api.supermemory.ai/v4/memories/forget-matching",
        body: expect.objectContaining({ ids: ["mem_1"], dryRun: false }),
      },
    ]);
    expect(requests[1].body).not.toHaveProperty("query");
    expect(requests[1].body).not.toHaveProperty("q");
  });
});
