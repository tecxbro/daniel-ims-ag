import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchProactiveNotice,
  recallPreferenceLines,
  type ProactiveMemoryTarget,
} from "../server/proactive-email.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
} from "../server/memory/supermemory/types.js";

function hydration(
  staticFacts: string[] = [],
  dynamicFacts: string[] = [],
): MemoryHydrationResult {
  return {
    provider: "supermemory",
    profile: { static: staticFacts, dynamic: dynamicFacts },
    results: [],
    latencyMs: 1,
  };
}

function provider(
  profile: DanielMemoryProvider["profile"],
): Pick<DanielMemoryProvider, "profile" | "search"> {
  return { profile, search: vi.fn(async () => []) };
}

const ownerKey = "a".repeat(32);
const target: ProactiveMemoryTarget = {
  phone: "+15551234567",
  conversationId: "sms:+15551234567",
  memoryOwnerId: "+15551234567",
  ownerKey,
  containerTag: `daniel-user-${ownerKey}`,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proactive Supermemory integration", () => {
  it("recalls only the paired owner's Supermemory profile", async () => {
    const profile = vi.fn(async () =>
      hydration(
        ["Always surface security alerts"],
        ["Ignore routine shipping updates"],
      ),
    );

    await expect(
      recallPreferenceLines(target, {
        env: { SUPERMEMORY_API_KEY: "server-test-key" },
        provider: provider(profile),
      }),
    ).resolves.toEqual([
      "Always surface security alerts",
      "Ignore routine shipping updates",
    ]);
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: target.containerTag,
        q: expect.stringContaining("proactively surface or ignore"),
      }),
    );
  });

  it("treats empty profiles and provider outages as valid fail-open preference reads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const emptyProfile = vi.fn(async () => hydration());
    await expect(
      recallPreferenceLines(target, {
        env: { SUPERMEMORY_API_KEY: "server-test-key" },
        provider: provider(emptyProfile),
      }),
    ).resolves.toEqual([]);

    const unavailable = vi.fn(async () => {
      throw new TypeError("provider unavailable");
    });
    await expect(
      recallPreferenceLines(target, {
        env: { SUPERMEMORY_API_KEY: "server-test-key" },
        provider: provider(unavailable),
      }),
    ).resolves.toEqual([]);
  });

  it("makes no provider request without an API key", async () => {
    const profile = vi.fn(async () => hydration(["must not be queried"]));
    await expect(
      recallPreferenceLines(target, { env: {}, provider: provider(profile) }),
    ).resolves.toEqual([]);
    expect(profile).not.toHaveBeenCalled();
  });

  it("skips before handling or sending when no primary owner is paired", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const handleMessage = vi.fn(async () => "must not run");
    const send = vi.fn(async () => true);
    const persistAssistantMessage = vi.fn(async () => undefined);

    await dispatchProactiveNotice("Security alert", null, {
      handleMessage,
      send,
      persistAssistantMessage,
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(persistAssistantMessage).not.toHaveBeenCalled();
  });

  it("uses the stored paired SMS conversation for a synthetic notice", async () => {
    const handleMessage = vi.fn(async () => "Personalized notice");
    const send = vi.fn(async () => true);
    const persistAssistantMessage = vi.fn(async () => undefined);

    await dispatchProactiveNotice("Security alert", target, {
      handleMessage,
      send,
      persistAssistantMessage,
    });

    expect(handleMessage).toHaveBeenCalledWith({
      conversationId: target.conversationId,
      memoryOwnerId: target.memoryOwnerId,
      content: "[proactive notice] Security alert",
      kind: "proactive",
    });
    expect(send).toHaveBeenCalledWith(target.phone, "Personalized notice");
    expect(persistAssistantMessage).toHaveBeenCalledWith({
      conversationId: target.conversationId,
      role: "assistant",
      content: "Personalized notice",
    });
  });
});
