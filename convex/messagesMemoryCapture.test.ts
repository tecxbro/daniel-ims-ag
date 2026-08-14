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

function captureArgs(content = "Hello from Daniel", payloadContent = "USER: hi\nDANIEL: hello") {
  const conversationId = "local:test-user";
  const turnId = "turn_atomic_001";
  const containerTag = "daniel-user-owner001";
  const customId = "daniel-conv-conversation001";
  return {
    conversationId,
    content,
    turnId,
    pairingAuthorityProof,
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
    const t = await authorizedTest();
    const first = await t.mutation(
      api.messages.persistAssistantTurn,
      captureArgs(),
    );
    const replay = await t.mutation(
      api.messages.persistAssistantTurn,
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
    await expect(t.query(internal.memorySyncJobs.list, { limit: 10 })).resolves.toHaveLength(1);
  });

  it("rejects conflicting assistant content and conflicting turn payloads", async () => {
    const t = await authorizedTest();
    await t.mutation(api.messages.persistAssistantTurn, captureArgs());

    await expect(
      t.mutation(
        api.messages.persistAssistantTurn,
        captureArgs("Different assistant reply"),
      ),
    ).rejects.toThrow(/different content/);
    const conflict = captureArgs("Hello from Daniel", "different memory payload");
    conflict.job.payloadHash = "b".repeat(64);
    await expect(
      t.mutation(api.messages.persistAssistantTurn, conflict),
    ).rejects.toThrow(/different memory sync payload/);
  });

  it("persists an assistant turn without creating a memory job", async () => {
    const t = convexTest(schema, modules);
    const args = {
      conversationId: "local:unconfigured",
      content: "A normal reply without configured memory",
      turnId: "turn_unconfigured_001",
    };
    await expect(t.mutation(api.messages.persistAssistantTurn, args)).resolves.toMatchObject({
      messageCreated: true,
      jobCreated: false,
    });
    await expect(t.mutation(api.messages.persistAssistantTurn, args)).resolves.toMatchObject({
      messageCreated: false,
      jobCreated: false,
      duplicate: true,
    });
    await expect(
      t.query(api.messages.list, { conversationId: "local:unconfigured", limit: 10 }),
    ).resolves.toHaveLength(1);
    await expect(t.query(internal.memorySyncJobs.list, { limit: 10 })).resolves.toHaveLength(0);
  });

  it("revalidates bounded inbound SMS pairing candidates behind the server proof", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.memoryProviderState.initializeIdentityConfiguration, {
      saltFingerprint: "a".repeat(32),
      pairingAuthorityProof,
    });
    await t.mutation(api.messages.send, {
      conversationId: "sms:+15555550123",
      role: "user",
      content: "hello",
    });
    await t.mutation(api.messages.send, {
      conversationId: "sms:+15555550456",
      role: "assistant",
      content: "outbound only",
    });
    await t.mutation(api.messages.send, {
      conversationId: "local:browser",
      role: "user",
      content: "not an SMS candidate",
    });

    await expect(
      t.query(api.messages.recentInboundSms, {
        pairingAuthorityProof: "c".repeat(64),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      t.query(api.messages.recentInboundSms, { pairingAuthorityProof, limit: 10 }),
    ).resolves.toMatchObject([{ conversationId: "sms:+15555550123" }]);
    await expect(
      t.query(api.messages.hasInboundUserMessage, {
        pairingAuthorityProof,
        conversationId: "sms:+15555550123",
      }),
    ).resolves.toBe(true);
    await expect(
      t.query(api.messages.hasInboundUserMessage, {
        pairingAuthorityProof,
        conversationId: "sms:+15555550456",
      }),
    ).resolves.toBe(false);
  });
});
