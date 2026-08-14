import { afterEach, describe, expect, it, vi } from "vitest";
import { convex } from "../server/convex-client.js";
import { recallLegacyMemory } from "../server/memory/tools.js";

const legacy = {
  memoryId: "legacy-memory-1",
  content: "The user prefers concise answers",
  tier: "permanent",
  segment: "preference",
  importance: 0.9,
};

afterEach(() => vi.restoreAllMocks());

describe("read-only emergency legacy recall", () => {
  it("returns read results when markAccessed is frozen", async () => {
    vi.spyOn(convex, "query").mockResolvedValue([legacy] as never);
    vi.spyOn(convex, "mutation").mockRejectedValue(
      new Error("LEGACY_MEMORY_WRITE_FROZEN"),
    );

    await expect(
      recallLegacyMemory({
        conversationId: "sms:fixture-user",
        query: "answer preference",
        bookkeeping: "best_effort",
      }),
    ).resolves.toEqual({ results: [legacy], mode: "substring" });
  });

  it("returns read results when the legacy event mutation is frozen", async () => {
    vi.spyOn(convex, "query").mockResolvedValue([legacy] as never);
    vi.spyOn(convex, "mutation")
      .mockResolvedValueOnce(null as never)
      .mockRejectedValueOnce(new Error("LEGACY_MEMORY_WRITE_FROZEN"));

    await expect(
      recallLegacyMemory({
        conversationId: "sms:fixture-user",
        query: "answer preference",
        bookkeeping: "best_effort",
      }),
    ).resolves.toEqual({ results: [legacy], mode: "substring" });
  });

  it("keeps the cutover fallback fully read-only by default", async () => {
    vi.spyOn(convex, "query").mockResolvedValue([legacy] as never);
    const mutation = vi.spyOn(convex, "mutation");

    await expect(
      recallLegacyMemory({
        conversationId: "sms:fixture-user",
        query: "answer preference",
      }),
    ).resolves.toMatchObject({ results: [legacy] });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("still surfaces a legacy read failure", async () => {
    vi.spyOn(convex, "query").mockRejectedValue(new Error("legacy read unavailable"));
    await expect(
      recallLegacyMemory({
        conversationId: "sms:fixture-user",
        query: "answer preference",
      }),
    ).rejects.toThrow("legacy read unavailable");
  });
});
