// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const pairingAuthorityProof = "b".repeat(64);

async function authorizedTest() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
    saltFingerprint: "a".repeat(32),
    pairingAuthorityProof,
  });
  return t;
}

function pendingArgs(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "op_1",
    ownerKey: "owner_a",
    conversationId: "conversation_a",
    type: "forget" as const,
    providerMemoryIds: ["mem_1", "mem_1", "mem_2"],
    preview: "Forget two memories?",
    expiresAt: 2_000,
    now: 1_000,
    pairingAuthorityProof,
    ...overrides,
  };
}

describe("memory pending operation transactions", () => {
  it("keeps the preview's exact IDs through confirmation and completion", async () => {
    const t = await authorizedTest();
    const created = await t.mutation(api.memoryPendingOperations.createPending, pendingArgs());
    expect(created.providerMemoryIds).toEqual(["mem_1", "mem_2"]);

    const current = await t.query(api.memoryPendingOperations.loadCurrentPendingByConversation, {
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      now: 1_001,
      pairingAuthorityProof,
    });
    expect(current?.operationId).toBe("op_1");

    const confirmed = await t.mutation(api.memoryPendingOperations.confirm, {
      operationId: "op_1",
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      now: 1_001,
      pairingAuthorityProof,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      operation: { status: "confirmed", providerMemoryIds: ["mem_1", "mem_2"] },
    });

    const completed = await t.mutation(api.memoryPendingOperations.complete, {
      operationId: "op_1",
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      now: 1_002,
      pairingAuthorityProof,
    });
    expect(completed).toMatchObject({ ok: true, operation: { status: "completed" } });
  });

  it("expires atomically and refuses cross-owner capability use", async () => {
    const t = await authorizedTest();
    await t.mutation(api.memoryPendingOperations.createPending, pendingArgs());
    await expect(
      t.mutation(api.memoryPendingOperations.confirm, {
        operationId: "op_1",
        ownerKey: "owner_b",
        conversationId: "conversation_b",
        now: 1_001,
        pairingAuthorityProof,
      }),
    ).rejects.toThrow("Pending operation not found");

    const expired = await t.mutation(api.memoryPendingOperations.confirm, {
      operationId: "op_1",
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      now: 2_001,
      pairingAuthorityProof,
    });
    expect(expired).toEqual({ ok: false, reason: "expired" });
    const loaded = await t.query(api.memoryPendingOperations.loadByOperationId, {
      operationId: "op_1",
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      now: 2_002,
      pairingAuthorityProof,
    });
    expect(loaded).toEqual({ ok: false, reason: "expired" });
  });

  it("makes cancellation terminal", async () => {
    const t = await authorizedTest();
    await t.mutation(api.memoryPendingOperations.createPending, pendingArgs());
    await t.mutation(api.memoryPendingOperations.cancel, {
      operationId: "op_1",
      ownerKey: "owner_a",
      conversationId: "conversation_a",
      now: 1_001,
      pairingAuthorityProof,
    });
    await expect(
      t.mutation(api.memoryPendingOperations.confirm, {
        operationId: "op_1",
        ownerKey: "owner_a",
        conversationId: "conversation_a",
        now: 1_002,
        pairingAuthorityProof,
      }),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
  });
});
describe("memory image anchor transactions", () => {
  it("retains pending/active storage and permits deletion only after release", async () => {
    const t = await authorizedTest();
    const storageId = await t.run(async (ctx) =>
      await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })),
    );
    await t.mutation(api.memoryImageAnchors.createPending, {
      storageId,
      ownerKey: "owner_a",
      customId: "daniel-image-test",
      reason: "explicit_request",
      pairingAuthorityProof,
    });
    await expect(
      t.query(api.memoryImageAnchors.findRetainedStorageIds, { storageIds: [storageId] }),
    ).resolves.toEqual([storageId]);
    await expect(
      t.mutation(api.memoryImageAnchors.deleteStorageIfUnretained, { storageId }),
    ).resolves.toEqual({ deleted: false, reason: "anchored" });

    await t.mutation(api.memoryImageAnchors.activate, {
      customId: "daniel-image-test",
      ownerKey: "owner_a",
      providerDocumentId: "provider_doc_1",
      pairingAuthorityProof,
    });
    await expect(
      t.query(api.memoryImageAnchors.loadActiveByCustomId, {
        customId: "daniel-image-test",
        ownerKey: "owner_b",
        pairingAuthorityProof,
      }),
    ).rejects.toThrow("Image anchor not found");

    await expect(
      t.mutation(api.memoryImageAnchors.releaseAfterProviderDeletion, {
        customId: "daniel-image-test",
        ownerKey: "owner_a",
        providerDocumentId: "provider_doc_1",
        providerDeletionConfirmed: false,
        now: 2_000,
        pairingAuthorityProof,
      }),
    ).rejects.toThrow(/must be confirmed/);
    await t.mutation(api.memoryImageAnchors.releaseAfterProviderDeletion, {
      customId: "daniel-image-test",
      ownerKey: "owner_a",
      providerDocumentId: "provider_doc_1",
      providerDeletionConfirmed: true,
      now: 2_000,
      pairingAuthorityProof,
    });
    await expect(
      t.query(api.memoryImageAnchors.findRetainedStorageIds, { storageIds: [storageId] }),
    ).resolves.toEqual([]);
    await expect(
      t.mutation(api.memoryImageAnchors.deleteStorageIfUnretained, { storageId }),
    ).resolves.toEqual({ deleted: true });
  });
});
