import { describe, expect, it, vi } from "vitest";
import {
  buildConversationTurnJobPayload,
  buildExplicitMemoryOutboxPayload,
  buildImageOutboxPayload,
  buildMemoryForgetOutboxPayload,
  buildMemoryUpdateOutboxPayload,
  parseMemorySyncJobPayload,
  type MemorySyncJobPayload,
} from "../server/memory/supermemory/job-contract.js";
import {
  MemorySyncDispatcher,
  type MemorySyncDispatchHandlers,
  type MemorySyncJob,
} from "../server/memory/supermemory/sync-worker.js";

const containerTag = "daniel-user-owner001";
const customId = "daniel-conv-conversation001";

function job(payload: MemorySyncJobPayload): MemorySyncJob {
  return {
    jobId: `job_${payload.kind}`,
    kind: payload.kind,
    ownerKey: "owner001",
    containerTag,
    customId:
      payload.kind === "conversation_turn" || payload.kind === "image"
        ? customId
        : undefined,
    turnId: payload.kind === "conversation_turn" ? "turn_001" : undefined,
    payload: JSON.stringify(payload),
    payloadHash: "a".repeat(64),
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function payloads(): MemorySyncJobPayload[] {
  return [
    buildConversationTurnJobPayload({
      content: "USER: hello\nDANIEL: hi",
      containerTag,
      customId,
      taskType: "memory",
    }),
    buildExplicitMemoryOutboxPayload({
      containerTag,
      memories: [{ content: "The user prefers concise answers" }],
    }),
    buildImageOutboxPayload({
      containerTag,
      customId,
      storageId: "storage_001",
      reason: "explicit_request",
    }),
    buildMemoryUpdateOutboxPayload({
      containerTag,
      memoryId: "memory_001",
      newContent: "The user now prefers detailed answers",
    }),
    buildMemoryForgetOutboxPayload({
      containerTag,
      providerMemoryIds: ["memory_001", "memory_002", "memory_001"],
      reason: "user requested",
    }),
  ];
}

describe("canonical memory sync job contract", () => {
  it("round-trips every producer through serialization, parsing, and dispatch", async () => {
    const handlers = Object.fromEntries(
      ["conversation_turn", "explicit_memory", "image", "memory_update", "memory_forget"].map(
        (kind) => [kind, vi.fn(async () => ({}))],
      ),
    ) as unknown as MemorySyncDispatchHandlers;
    const dispatcher = new MemorySyncDispatcher(handlers);

    for (const payload of payloads()) await dispatcher.dispatch(job(payload));

    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledOnce();
    expect(handlers.image).toHaveBeenCalledWith(
      expect.objectContaining({ storageId: "storage_001", customId }),
      expect.objectContaining({ kind: "image" }),
    );
    expect(handlers.memory_forget).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["memory_001", "memory_002"] }),
      expect.objectContaining({ kind: "memory_forget" }),
    );
  });

  it("rejects unknown schema versions and cross-container payloads", () => {
    const payload = buildConversationTurnJobPayload({
      content: "USER: hello\nDANIEL: hi",
      containerTag,
      customId,
    });
    expect(() =>
      parseMemorySyncJobPayload({ ...payload, schemaVersion: 2 }, {
        kind: "conversation_turn",
        containerTag,
        customId,
      }),
    ).toThrow(/schemaVersion/);
    expect(() =>
      parseMemorySyncJobPayload(payload, {
        kind: "conversation_turn",
        containerTag: "daniel-user-foreign",
        customId,
      }),
    ).toThrow(/containerTag does not match/);
  });
});
