import { describe, expect, it, vi } from "vitest";
import {
  buildConversationTurnJobPayload,
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
    jobId: "job_conversation_turn",
    kind: "conversation_turn",
    ownerKey: "owner001",
    containerTag,
    customId,
    turnId: "turn_001",
    payload: JSON.stringify(payload),
    payloadHash: "a".repeat(64),
    status: "pending",
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function conversationPayload(): MemorySyncJobPayload {
  return buildConversationTurnJobPayload({
    content: "USER: hello\nDANIEL: hi",
    containerTag,
    customId,
    taskType: "memory",
  });
}

describe("canonical memory sync job contract", () => {
  it("round-trips a conversation turn through serialization, parsing, and dispatch", async () => {
    const handler = vi.fn(async () => ({ providerDocumentId: "doc_001" }));
    const handlers: MemorySyncDispatchHandlers = { conversation_turn: handler };
    const dispatcher = new MemorySyncDispatcher(handlers);
    const durableJob = job(conversationPayload());

    await expect(dispatcher.dispatch(durableJob)).resolves.toEqual({
      providerDocumentId: "doc_001",
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ containerTag, customId }),
      durableJob,
    );
  });

  it("accepts only conversation_turn as the durable outbox kind", () => {
    const payload = conversationPayload();

    expect(() =>
      parseMemorySyncJobPayload(
        { ...payload, kind: "unsupported_kind" },
        {
          kind: "conversation_turn",
          containerTag,
          customId,
        },
      ),
    ).toThrow(/kind .* does not match durable job/);
  });

  it("rejects unknown schema versions and cross-container payloads", () => {
    const payload = conversationPayload();

    expect(() =>
      parseMemorySyncJobPayload(
        { ...payload, schemaVersion: 2 },
        {
          kind: "conversation_turn",
          containerTag,
          customId,
        },
      ),
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
