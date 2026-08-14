import { describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_INGESTION_STRATEGY,
  buildConversationTurnPayload,
  captureRawTurn,
  type EnqueueMemorySyncJobInput,
  type MemorySyncJobStore,
} from "../server/memory/supermemory/capture.js";
import {
  deriveMemoryIdentity,
  memoryIdSaltFingerprint,
} from "../server/memory/supermemory/identity.js";

const TEST_SALT = "test-only-capture-salt-0123456789abcdef";

function createOutbox(): {
  rows: Map<string, EnqueueMemorySyncJobInput>;
  store: MemorySyncJobStore;
} {
  const rows = new Map<string, EnqueueMemorySyncJobInput>();
  return {
    rows,
    store: {
      enqueue: vi.fn(async (input) => {
        const existing = rows.get(input.payloadHash);
        if (existing) {
          return { jobId: existing.jobId, enqueued: false, duplicate: true };
        }
        rows.set(input.payloadHash, input);
        return { jobId: input.jobId, enqueued: true, duplicate: false };
      }),
    },
  };
}

function normalTurn(overrides: Partial<Parameters<typeof captureRawTurn>[0]> = {}) {
  return {
    conversationId: "sms:+15555550100",
    memoryOwnerId: "+15555550100",
    turnId: "turn_001",
    userMessage: "I prefer concise answers.",
    assistantReply: "Got it — I'll keep things concise.",
    kind: "user" as const,
    channel: "imessage" as const,
    ...overrides,
  };
}

describe("durable Supermemory turn capture", () => {
  it("uses one stable customId for delta turns in the same conversation", async () => {
    const outbox = createOutbox();
    const first = await captureRawTurn(normalTurn(), {
      jobStore: outbox.store,
      writeMode: "dual",
      memoryIdSalt: TEST_SALT,
      createJobId: () => "job_001",
      now: () => 100,
    });
    const second = await captureRawTurn(
      normalTurn({ turnId: "turn_002", userMessage: "And no long preambles." }),
      {
        jobStore: outbox.store,
        writeMode: "dual",
        memoryIdSalt: TEST_SALT,
        createJobId: () => "job_002",
        now: () => 101,
      },
    );

    expect("identity" in first && "identity" in second).toBe(true);
    if (!("identity" in first) || !("identity" in second)) return;
    expect(first.identity.customId).toBe(second.identity.customId);
    expect(first.payloadHash).not.toBe(second.payloadHash);
    expect(outbox.rows).toHaveLength(2);
    const payloads = [...outbox.rows.values()].map((row) => JSON.parse(row.payload));
    expect(payloads.every((payload) => payload.ingestionStrategy === "delta_turn_v1")).toBe(true);
    expect(payloads.every((payload) => !Object.hasOwn(payload, "fullTranscript"))).toBe(true);
  });

  it("creates only one durable job for a repeated turn", async () => {
    const outbox = createOutbox();
    const dependencies = {
      jobStore: outbox.store,
      writeMode: "dual" as const,
      memoryIdSalt: TEST_SALT,
      createJobId: vi.fn().mockReturnValueOnce("job_first").mockReturnValueOnce("job_retry"),
      now: () => 100,
    };

    const first = await captureRawTurn(normalTurn(), dependencies);
    const retry = await captureRawTurn(normalTurn(), dependencies);

    expect(first).toMatchObject({ enqueued: true, duplicate: false, jobId: "job_first" });
    expect(retry).toMatchObject({ enqueued: false, duplicate: true, jobId: "job_first" });
    expect(outbox.rows).toHaveLength(1);
  });

  it("captures the raw exchange without a preprocessing or extraction dependency", async () => {
    const outbox = createOutbox();
    await captureRawTurn(normalTurn(), {
      jobStore: outbox.store,
      writeMode: "dual",
      memoryIdSalt: TEST_SALT,
      createJobId: () => "job_raw",
      now: () => 100,
    });

    const row = [...outbox.rows.values()][0];
    const payload = JSON.parse(row.payload);
    expect(payload).toEqual({
      schemaVersion: 1,
      kind: "conversation_turn",
      ingestionStrategy: CONVERSATION_INGESTION_STRATEGY,
      providerInput: {
        content:
          "Conversation between the user and Daniel.\nTurn: turn_001\n\nUSER: I prefer concise answers.\n\nDANIEL: Got it — I'll keep things concise.",
        containerTag: expect.stringMatching(/^daniel-user-[a-f0-9]{32}$/),
        customId: expect.stringMatching(/^daniel-conv-[a-f0-9]{32}$/),
        taskType: "memory",
        metadata: {
          source: "daniel",
          kind: "conversation_turn",
          channel: "imessage",
          conversationKey: expect.stringMatching(/^[a-f0-9]{32}$/),
          turnId: "turn_001",
          schemaVersion: 1,
          hasImages: false,
          imageCount: 0,
        },
      },
    });
  });

  it("never captures synthetic proactive notices", async () => {
    const outbox = createOutbox();
    const result = await captureRawTurn(normalTurn({ kind: "proactive" }), {
      jobStore: outbox.store,
      writeMode: "dual",
      memoryIdSalt: TEST_SALT,
    });

    expect(result).toEqual({ enqueued: false, reason: "synthetic_proactive" });
    expect(outbox.rows).toHaveLength(0);
  });

  it("does not enqueue when Supermemory writes are disabled", async () => {
    const outbox = createOutbox();
    const result = await captureRawTurn(normalTurn(), {
      jobStore: outbox.store,
      writeMode: "convex",
      memoryIdSalt: TEST_SALT,
    });

    expect(result).toEqual({ enqueued: false, reason: "write_mode_disabled" });
    expect(outbox.rows).toHaveLength(0);
  });

  it("isolates different users in different containers", async () => {
    const outbox = createOutbox();
    const first = await captureRawTurn(normalTurn(), {
      jobStore: outbox.store,
      writeMode: "dual",
      memoryIdSalt: TEST_SALT,
    });
    const second = await captureRawTurn(
      normalTurn({
        conversationId: "sms:+15555550200",
        memoryOwnerId: "+15555550200",
      }),
      { jobStore: outbox.store, writeMode: "dual", memoryIdSalt: TEST_SALT },
    );

    if (!("identity" in first) || !("identity" in second)) throw new Error("capture skipped");
    expect(first.identity.containerTag).not.toBe(second.identity.containerTag);
  });

  it("records ordinary image metadata without uploading durable image content", async () => {
    const outbox = createOutbox();
    await captureRawTurn(normalTurn({ imageStorageIds: ["storage_1", "storage_2"] }), {
      jobStore: outbox.store,
      writeMode: "dual",
      memoryIdSalt: TEST_SALT,
    });

    const payload = JSON.parse([...outbox.rows.values()][0].payload);
    expect(payload.providerInput.metadata).toMatchObject({ hasImages: true, imageCount: 2 });
    expect(payload.providerInput.content).not.toContain("storage_1");
    expect([...outbox.rows.values()].every((row) => row.kind === "conversation_turn")).toBe(true);
  });

  it("builds stable payload identity independently of raw owner identifiers", () => {
    const identity = deriveMemoryIdentity(
      { memoryOwnerId: "+15555550100", conversationId: "sms:+15555550100" },
      { salt: TEST_SALT },
    );
    const payload = buildConversationTurnPayload({
      identity,
      turnId: "turn_001",
      userMessage: "hello",
      assistantReply: "hi",
    });

    expect(JSON.stringify(payload)).not.toContain("+15555550100");
    expect(payload.providerInput.customId).toBe(identity.customId);
  });

  it("checks the deployment salt fingerprint before creating an outbox row", async () => {
    const outbox = createOutbox();
    const differentSalt = "test-only-different-capture-salt-987654321";

    await expect(captureRawTurn(normalTurn(), {
      jobStore: outbox.store,
      identityStateStore: {
        ensureIdentitySaltFingerprint: async () =>
          memoryIdSaltFingerprint(differentSalt),
      },
      writeMode: "dual",
      memoryIdSalt: TEST_SALT,
    })).rejects.toThrow(/DANIEL_MEMORY_ID_SALT changed/);
    expect(outbox.store.enqueue).not.toHaveBeenCalled();
  });
});
