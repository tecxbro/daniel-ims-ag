import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeAssistantTurnCapture,
  inspectCaptureRecoveryJournal,
  replayCaptureRecoveryJournal,
  writeCaptureRecoveryRecord,
  type AssistantCaptureRecoveryRecord,
} from "../server/memory/supermemory/capture-recovery.js";
import { memoryIdSaltFingerprint } from "../server/memory/supermemory/identity.js";

const directories: string[] = [];
const salt = "4".repeat(64);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function recoveryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "daniel-memory-recovery-"));
  directories.push(directory);
  return directory;
}

const turn = {
  conversationId: "sms:+15555550100",
  memoryOwnerId: "+15555550100",
  turnId: "turn_recovery_001",
  userMessage: "Remember that I prefer concise answers",
  assistantReply: "Got it.",
  kind: "user" as const,
  channel: "imessage" as const,
};

describe("durable capture recovery journal", () => {
  it("journals one configured conversation job and replays it after restart", async () => {
    const directory = await recoveryDirectory();
    const failedPersist = vi.fn(async () => {
      throw new Error("Convex unavailable");
    });

    await expect(
      finalizeAssistantTurnCapture(turn, {
        directory,
        memoryConfigured: true,
        memoryIdSalt: salt,
        ensureIdentitySaltFingerprint: async (fingerprint) => fingerprint,
        persist: failedPersist,
        now: () => 1_000,
      }),
    ).resolves.toMatchObject({ durable: "journal" });
    await expect(
      inspectCaptureRecoveryJournal({ directory, now: () => 1_500 }),
    ).resolves.toEqual({
      unresolvedCount: 1,
      oldestCreatedAt: 1_000,
      oldestAgeMs: 500,
    });

    const replayPersist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => {
      if (!record.job) throw new Error("expected configured capture job");
      expect(record.job.kind).toBe("conversation_turn");
      return { job: { jobId: record.job.jobId } };
    });
    await expect(
      replayCaptureRecoveryJournal({ directory, persist: replayPersist }),
    ).resolves.toEqual({ attempted: 1, recovered: 1, remaining: 0 });
    expect(replayPersist).toHaveBeenCalledOnce();
    await expect(inspectCaptureRecoveryJournal({ directory })).resolves.toMatchObject({
      unresolvedCount: 0,
    });
  });

  it("retains semantic capture intent when identity state is transiently unavailable", async () => {
    const directory = await recoveryDirectory();
    await expect(
      finalizeAssistantTurnCapture(turn, {
        directory,
        memoryConfigured: true,
        memoryIdSalt: salt,
        ensureIdentitySaltFingerprint: async () => {
          throw new TypeError("Convex network unavailable");
        },
        persist: async () => {
          throw new TypeError("Convex network unavailable");
        },
      }),
    ).resolves.toMatchObject({ durable: "journal", jobId: expect.any(String) });

    const replayPersist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => {
      expect(record.job?.kind).toBe("conversation_turn");
      return { job: { payloadHash: record.job?.payloadHash } };
    });
    await expect(
      replayCaptureRecoveryJournal({ directory, persist: replayPersist }),
    ).resolves.toEqual({ attempted: 1, recovered: 1, remaining: 0 });
  });

  it("accepts idempotent finalization of the same configured turn", async () => {
    const directory = await recoveryDirectory();
    let firstJob: AssistantCaptureRecoveryRecord["job"];
    const persist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => {
      firstJob ??= record.job;
      return { job: { jobId: firstJob?.jobId, payloadHash: firstJob?.payloadHash } };
    });
    const dependencies = {
      directory,
      memoryConfigured: true,
      memoryIdSalt: salt,
      ensureIdentitySaltFingerprint: async (fingerprint: string) => fingerprint,
      persist,
    };

    const first = await finalizeAssistantTurnCapture(turn, dependencies);
    const second = await finalizeAssistantTurnCapture(turn, dependencies);
    expect(first).toEqual(second);
    expect(first.jobId).toMatch(/^memory-sync-[a-f0-9]{64}$/);
    expect(persist).toHaveBeenCalledTimes(2);
    await expect(inspectCaptureRecoveryJournal({ directory })).resolves.toMatchObject({
      unresolvedCount: 0,
    });
  });

  it("persists an assistant reply without a job when the API key is absent", async () => {
    const directory = await recoveryDirectory();
    const persist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => {
      expect(record.assistant).toMatchObject({
        conversationId: turn.conversationId,
        content: turn.assistantReply,
        turnId: turn.turnId,
      });
      expect(record.job).toBeUndefined();
      return {};
    });

    await expect(
      finalizeAssistantTurnCapture(turn, {
        directory,
        memoryConfigured: false,
        persist,
      }),
    ).resolves.toEqual({ durable: "convex", jobId: undefined });
    expect(persist).toHaveBeenCalledOnce();
    await expect(inspectCaptureRecoveryJournal({ directory })).resolves.toMatchObject({
      unresolvedCount: 0,
    });
  });

  it("persists an assistant reply without a job when identity recovery is required", async () => {
    const directory = await recoveryDirectory();
    const persist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => {
      expect(record.job).toBeUndefined();
      return {};
    });

    await expect(
      finalizeAssistantTurnCapture(turn, {
        directory,
        memoryConfigured: true,
        memoryIdSalt: salt,
        ensureIdentitySaltFingerprint: async () =>
          memoryIdSaltFingerprint("5".repeat(64)),
        persist,
      }),
    ).resolves.toEqual({ durable: "convex", jobId: undefined });
    expect(persist).toHaveBeenCalledOnce();
    await expect(inspectCaptureRecoveryJournal({ directory })).resolves.toMatchObject({
      unresolvedCount: 0,
    });
  });

  it("journals and replays assistant-only turns", async () => {
    const directory = await recoveryDirectory();
    await expect(
      finalizeAssistantTurnCapture(turn, {
        directory,
        memoryConfigured: false,
        persist: async () => {
          throw new Error("Convex unavailable");
        },
        now: () => 2_000,
      }),
    ).resolves.toEqual({ durable: "journal", jobId: undefined });

    const replayPersist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => {
      expect(record.job).toBeUndefined();
      return {};
    });
    await expect(
      replayCaptureRecoveryJournal({ directory, persist: replayPersist }),
    ).resolves.toEqual({ attempted: 1, recovered: 1, remaining: 0 });
    expect(replayPersist).toHaveBeenCalledOnce();
  });

  it("replays version-one job-bearing recovery records", async () => {
    const directory = await recoveryDirectory();
    let captured: AssistantCaptureRecoveryRecord | undefined;
    await finalizeAssistantTurnCapture(turn, {
      directory,
      memoryConfigured: true,
      memoryIdSalt: salt,
      ensureIdentitySaltFingerprint: async (fingerprint) => fingerprint,
      persist: async (record) => {
        captured = record;
        if (!record.job) throw new Error("expected configured capture job");
        return { job: { jobId: record.job.jobId } };
      },
    });
    if (!captured?.job) throw new Error("expected captured job");
    await writeCaptureRecoveryRecord(
      { ...captured, schemaVersion: 1 },
      { directory },
    );

    const replayPersist = vi.fn(async (record: AssistantCaptureRecoveryRecord) => ({
      job: { jobId: record.job?.jobId },
    }));
    await expect(
      replayCaptureRecoveryJournal({ directory, persist: replayPersist }),
    ).resolves.toEqual({ attempted: 1, recovered: 1, remaining: 0 });
    expect(replayPersist).toHaveBeenCalledOnce();
  });

  it("does not enqueue proactive notices or create a recovery record", async () => {
    const directory = await recoveryDirectory();
    const persist = vi.fn();
    await expect(
      finalizeAssistantTurnCapture(
        { ...turn, kind: "proactive" },
        { directory, persist },
      ),
    ).resolves.toEqual({ durable: "skipped" });
    expect(persist).not.toHaveBeenCalled();
    await expect(inspectCaptureRecoveryJournal({ directory })).resolves.toMatchObject({
      unresolvedCount: 0,
    });
  });
});
