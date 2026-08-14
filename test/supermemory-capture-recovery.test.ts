import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finalizeAssistantTurnCapture,
  inspectCaptureRecoveryJournal,
  replayCaptureRecoveryJournal,
} from "../server/memory/supermemory/capture-recovery.js";

const directories: string[] = [];
const salt = "test-only-recovery-salt-0123456789abcdef";

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
  it("journals an injected Convex failure and replays it after restart", async () => {
    const directory = await recoveryDirectory();
    const failedPersist = vi.fn(async () => {
      throw new Error("Convex unavailable");
    });

    await expect(
      finalizeAssistantTurnCapture(turn, {
        directory,
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

    const replayPersist = vi.fn(async (record) => ({
      job: { jobId: record.job.jobId },
    }));
    await expect(
      replayCaptureRecoveryJournal({ directory, persist: replayPersist }),
    ).resolves.toEqual({ attempted: 1, recovered: 1, remaining: 0 });
    expect(replayPersist).toHaveBeenCalledOnce();
    await expect(inspectCaptureRecoveryJournal({ directory })).resolves.toMatchObject({
      unresolvedCount: 0,
    });
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
