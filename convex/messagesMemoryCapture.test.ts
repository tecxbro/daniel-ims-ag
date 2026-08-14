// @vitest-environment edge-runtime
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

function captureArgs(content = "Hello from Daniel", payloadContent = "USER: hi\nDANIEL: hello") {
  const conversationId = "local:test-user";
  const turnId = "turn_atomic_001";
  const containerTag = "daniel-user-owner001";
  const customId = "daniel-conv-conversation001";
  return {
    conversationId,
    content,
    turnId,
    job: {
      jobId: "job_atomic_001",
      kind: "conversation_turn" as const,
      ownerKey: "owner001",
      containerTag,
      customId,
      conversationId,
      turnId,
      payload: JSON.stringify({
        schemaVersion: 1,
        kind: "conversation_turn",
        ingestionStrategy: "delta_turn_v1",
        providerInput: { content: payloadContent, containerTag, customId },
      }),
      payloadHash: "a".repeat(64),
      now: 1_000,
    },
  };
}

describe("atomic assistant persistence and memory capture", () => {
  it("creates one assistant row and one outbox job, then replays idempotently", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(
      api.messages.persistAssistantWithMemoryCapture,
      captureArgs(),
    );
    const replay = await t.mutation(
      api.messages.persistAssistantWithMemoryCapture,
      captureArgs(),
    );

    expect(first).toMatchObject({ messageCreated: true, jobCreated: true });
    expect(replay).toMatchObject({
      messageCreated: false,
      jobCreated: false,
      duplicate: true,
    });
    await expect(
      t.query(api.messages.list, { conversationId: "local:test-user", limit: 10 }),
    ).resolves.toHaveLength(1);
    await expect(t.query(api.memorySyncJobs.list, { limit: 10 })).resolves.toHaveLength(1);
  });

  it("rejects conflicting assistant content and conflicting turn payloads", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.messages.persistAssistantWithMemoryCapture, captureArgs());

    await expect(
      t.mutation(
        api.messages.persistAssistantWithMemoryCapture,
        captureArgs("Different assistant reply"),
      ),
    ).rejects.toThrow(/different content/);
    const conflict = captureArgs("Hello from Daniel", "different memory payload");
    conflict.job.payloadHash = "b".repeat(64);
    await expect(
      t.mutation(api.messages.persistAssistantWithMemoryCapture, conflict),
    ).rejects.toThrow(/different memory sync payload/);
  });
});
