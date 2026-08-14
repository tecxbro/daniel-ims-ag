import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runImageCleanupWithDependencies,
  type ImageCleanupDependencies,
} from "../server/images/clean.js";
import { captureRawTurn } from "../server/memory/supermemory/capture.js";
import {
  forgetDurableImageSource,
  rememberDurableImage,
  shouldRememberImageDurably,
  type ImageAnchor,
  type ImageAnchorStore,
  type MemoryOperationDependencies,
  type MemoryOperationProvider,
  type PendingOperationStore,
} from "../server/memory/supermemory/operations.js";

afterEach(() => vi.restoreAllMocks());

function cleanupDependencies(input?: {
  retained?: Set<string>;
  lookupError?: Error;
  finalDelete?: { deleted: boolean; reason?: string };
}) {
  const clearMessageImage = vi.fn(async () => undefined);
  const deleteStorageIfUnretained = vi.fn(async () => input?.finalDelete ?? { deleted: true });
  const dependencies: ImageCleanupDependencies = {
    now: () => 10 * 24 * 60 * 60 * 1_000,
    retentionDays: () => 3,
    listExpired: vi.fn(async () => ({
      rows: [{ _id: "message_1", imageStorageIds: ["storage_1"] }],
      isDone: true,
      continueCursor: null,
    })),
    findRetainedStorageIds: vi.fn(async () => {
      if (input?.lookupError) throw input.lookupError;
      return input?.retained ?? new Set<string>();
    }),
    clearMessageImage,
    deleteStorageIfUnretained,
  };
  return { dependencies, clearMessageImage, deleteStorageIfUnretained };
}

class FakeImageAnchorStore implements ImageAnchorStore {
  anchor: ImageAnchor | null = null;
  readonly events: string[] = [];

  async createPending(
    input: Omit<ImageAnchor, "providerDocumentId" | "status" | "createdAt" | "releasedAt">,
  ) {
    if (
      this.anchor?.status === "active" &&
      this.anchor.customId === input.customId &&
      this.anchor.ownerKey === input.ownerKey &&
      this.anchor.storageId === input.storageId
    ) {
      return this.anchor;
    }
    this.events.push("pending");
    this.anchor = { ...input, status: "pending", createdAt: 1 };
    return this.anchor;
  }

  async activate(input: { customId: string; ownerKey: string; providerDocumentId: string }) {
    if (!this.anchor || this.anchor.customId !== input.customId || this.anchor.ownerKey !== input.ownerKey) {
      throw new Error("not found");
    }
    this.events.push("active");
    this.anchor = { ...this.anchor, status: "active", providerDocumentId: input.providerDocumentId };
    return this.anchor;
  }

  async loadActiveByCustomId(input: { customId: string; ownerKey: string }) {
    if (
      this.anchor?.status === "active" &&
      this.anchor.customId === input.customId &&
      this.anchor.ownerKey === input.ownerKey
    ) {
      return this.anchor;
    }
    return null;
  }

  async releaseAfterProviderDeletion(input: {
    customId: string;
    ownerKey: string;
    providerDocumentId: string;
    providerDeletionConfirmed: true;
    now: number;
  }) {
    if (
      !this.anchor ||
      this.anchor.customId !== input.customId ||
      this.anchor.ownerKey !== input.ownerKey ||
      this.anchor.providerDocumentId !== input.providerDocumentId ||
      !input.providerDeletionConfirmed
    ) {
      throw new Error("not found");
    }
    this.events.push("released");
    this.anchor = { ...this.anchor, status: "released", releasedAt: input.now };
    return this.anchor;
  }
}

function imageProvider(input?: { uploadError?: Error; deleteError?: Error; anchors?: FakeImageAnchorStore }) {
  const provider: MemoryOperationProvider = {
    search: vi.fn(),
    createExact: vi.fn(),
    updateExact: vi.fn(),
    forgetExact: vi.fn(),
    previewForget: vi.fn(),
    applyExactForget: vi.fn(),
    uploadImage: vi.fn(async () => {
      if (input?.uploadError) throw input.uploadError;
      expect(input?.anchors?.anchor?.status).toBe("pending");
      input?.anchors?.events.push("uploaded");
      return { id: "provider_doc_1", status: "queued" };
    }),
    deleteDocument: vi.fn(async () => {
      if (input?.deleteError) throw input.deleteError;
    }),
  };
  return provider;
}

function imageDependencies(input?: {
  uploadError?: Error;
  deleteError?: Error;
  anchors?: FakeImageAnchorStore;
}): MemoryOperationDependencies & { imageAnchors: FakeImageAnchorStore; provider: MemoryOperationProvider } {
  const anchors = input?.anchors ?? new FakeImageAnchorStore();
  return {
    provider: imageProvider({ ...input, anchors }),
    pendingOperations: {} as PendingOperationStore,
    imageAnchors: anchors,
    fetchImageBytes: vi.fn(async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    })),
    now: () => 100,
  };
}

describe("image cleanup retention anchors", () => {
  it("lets unanchored and released images expire normally", async () => {
    for (const retained of [new Set<string>(), new Set<string>()]) {
      const deps = cleanupDependencies({ retained });
      await expect(runImageCleanupWithDependencies(deps.dependencies)).resolves.toEqual({
        deleted: 1,
        kept: 0,
      });
      expect(deps.clearMessageImage).toHaveBeenCalledWith("message_1", "storage_1");
      expect(deps.deleteStorageIfUnretained).toHaveBeenCalledWith("storage_1");
    }
  });

  it.each(["pending", "active"])("keeps %s anchored image bytes", async () => {
    const deps = cleanupDependencies({ retained: new Set(["storage_1"]) });
    await expect(runImageCleanupWithDependencies(deps.dependencies)).resolves.toEqual({
      deleted: 0,
      kept: 1,
    });
    expect(deps.clearMessageImage).not.toHaveBeenCalled();
    expect(deps.deleteStorageIfUnretained).not.toHaveBeenCalled();
  });

  it("fails closed when anchor state is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = cleanupDependencies({ lookupError: new Error("Convex unavailable") });
    await expect(runImageCleanupWithDependencies(deps.dependencies)).resolves.toEqual({
      deleted: 0,
      kept: 1,
    });
    expect(deps.clearMessageImage).not.toHaveBeenCalled();
    expect(deps.deleteStorageIfUnretained).not.toHaveBeenCalled();
  });

  it("rechecks retention transactionally before deleting bytes", async () => {
    const deps = cleanupDependencies({
      retained: new Set(),
      finalDelete: { deleted: false, reason: "anchored" },
    });
    await expect(runImageCleanupWithDependencies(deps.dependencies)).resolves.toEqual({
      deleted: 0,
      kept: 1,
    });
  });
});

describe("durable image operations", () => {
  it("creates a pending anchor before upload and activates only after provider success", async () => {
    const deps = imageDependencies();
    const result = await rememberDurableImage(
      {
        ownerKey: "owner_a",
        containerTag: "daniel-user-owner_a",
        storageId: "storage_1",
        conversationId: "conversation_a",
        turnId: "turn_1",
        reason: "explicit_request",
      },
      deps,
    );

    expect(deps.imageAnchors.events).toEqual(["pending", "uploaded", "active"]);
    expect(result.anchor.status).toBe("active");
    expect(result.providerDocumentId).toBe("provider_doc_1");
    expect(Object.keys(result).sort()).toEqual(["anchor", "providerDocumentId"]);
    expect(deps.provider.uploadImage).toHaveBeenCalledOnce();

    const repeated = await rememberDurableImage(
      {
        ownerKey: "owner_a",
        containerTag: "daniel-user-owner_a",
        storageId: "storage_1",
        conversationId: "conversation_a",
        turnId: "turn_1",
        reason: "explicit_request",
      },
      deps,
    );
    expect(repeated.providerDocumentId).toBe("provider_doc_1");
    expect(deps.provider.uploadImage).toHaveBeenCalledOnce();
  });

  it("preserves the pending anchor when image ingestion fails", async () => {
    const deps = imageDependencies({ uploadError: new Error("provider unavailable") });
    await expect(
      rememberDurableImage(
        {
          ownerKey: "owner_a",
          containerTag: "daniel-user-owner_a",
          storageId: "storage_1",
          reason: "remember_image_tool",
        },
        deps,
      ),
    ).rejects.toThrow("provider unavailable");
    expect(deps.imageAnchors.anchor?.status).toBe("pending");
    expect(deps.imageAnchors.events).toEqual(["pending"]);
  });

  it("releases only after a confirmed provider source deletion", async () => {
    const anchors = new FakeImageAnchorStore();
    anchors.anchor = {
      storageId: "storage_1",
      ownerKey: "owner_a",
      customId: "daniel-image-test",
      providerDocumentId: "provider_doc_1",
      status: "active",
      reason: "explicit_request",
      createdAt: 1,
    };
    const failed = imageDependencies({ anchors, deleteError: new Error("provider unavailable") });
    await expect(
      forgetDurableImageSource(
        { ownerKey: "owner_a", customId: "daniel-image-test" },
        failed,
      ),
    ).rejects.toThrow("provider unavailable");
    expect(anchors.anchor.status).toBe("active");
    expect(anchors.events).not.toContain("released");

    const succeeded = imageDependencies({ anchors });
    await expect(
      forgetDurableImageSource(
        { ownerKey: "owner_a", customId: "daniel-image-test" },
        succeeded,
      ),
    ).resolves.toEqual({ customId: "daniel-image-test", released: true });
    expect(anchors.anchor.status).toBe("released");
    expect(anchors.events).toContain("released");
  });

  it("does not upload ordinary conversation images to durable memory", async () => {
    const enqueue = vi.fn(async (job) => ({
      jobId: job.jobId,
      enqueued: true,
      duplicate: false,
    }));
    await captureRawTurn(
      {
        conversationId: "conversation_a",
        memoryOwnerId: "user_a",
        turnId: "turn_1",
        userMessage: "What is in this screenshot?",
        assistantReply: "It shows a receipt.",
        imageStorageIds: ["storage_1"],
      },
      {
        jobStore: { enqueue },
        memoryConfigured: true,
        memoryIdSalt: "d".repeat(64),
        createJobId: () => "job_1",
      },
    );

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0][0].kind).toBe("conversation_turn");
    expect(shouldRememberImageDurably({})).toBe(false);
    expect(shouldRememberImageDurably({ explicitRequest: true })).toBe(true);
    expect(shouldRememberImageDurably({ durableObject: "pet" })).toBe(true);
    expect(shouldRememberImageDurably({ rememberImageToolCalled: true })).toBe(true);
  });
});
