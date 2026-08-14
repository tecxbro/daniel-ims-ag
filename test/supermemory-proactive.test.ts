import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchProactiveNotice,
  recallPreferenceLines,
  resolveProactiveMemoryTarget,
} from "../server/proactive-email.js";
import {
  deriveMemoryIdentity,
  memoryIdSaltFingerprint,
} from "../server/memory/supermemory/identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
} from "../server/memory/supermemory/types.js";

const TEST_SALT = "test-only-proactive-salt-0123456789abcdef";

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

const target = {
  phone: "+15551234567",
  conversationId: "sms:+15551234567",
  memoryOwnerId: "+15551234567",
};

describe("proactive Supermemory integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("canonicalizes the proactive owner exactly like the iMessage bridge", () => {
    expect(resolveProactiveMemoryTarget("(555) 123-4567")).toEqual(target);
    expect(resolveProactiveMemoryTarget("not-a-phone")).toBeNull();
  });

  it("recalls profile context from the correct owner container after read cutover", async () => {
    const profile = vi.fn(async () =>
      hydration(
        ["Always surface security alerts"],
        ["Ignore routine shipping updates"],
      ),
    );
    const recallLegacy = vi.fn(async () => ["legacy global preference"]);

    const lines = await recallPreferenceLines(target, {
      env: {
        DANIEL_MEMORY_READ_MODE: "supermemory",
        DANIEL_MEMORY_LEGACY_FALLBACK: "true",
        DANIEL_MEMORY_ID_SALT: TEST_SALT,
      },
      provider: provider(profile),
      recallLegacy,
      ensureIdentitySaltFingerprint: async (fingerprint) => fingerprint,
    });

    const expectedOwner = deriveMemoryIdentity(
      {
        memoryOwnerId: target.memoryOwnerId,
        conversationId: target.conversationId,
      },
      { salt: TEST_SALT },
    );
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: expectedOwner.containerTag,
        q: expect.stringContaining("proactively surface or ignore"),
      }),
    );
    expect(lines).toEqual([
      "Always surface security alerts",
      "Ignore routine shipping updates",
    ]);
    expect(recallLegacy).not.toHaveBeenCalled();
  });

  it("executes an owner-scoped shadow read while keeping Convex preferences user-facing", async () => {
    const profile = vi.fn(async () => hydration(["provider preference"]));
    const recallLegacy = vi.fn(async () => ["legacy preference"]);

    await expect(
      recallPreferenceLines(target, {
        env: {
          DANIEL_MEMORY_READ_MODE: "shadow",
          DANIEL_MEMORY_ID_SALT: TEST_SALT,
        },
        provider: provider(profile),
        recallLegacy,
        ensureIdentitySaltFingerprint: async (fingerprint) => fingerprint,
      }),
    ).resolves.toEqual(["legacy preference"]);
    expect(profile).toHaveBeenCalledWith(
      expect.objectContaining({
        containerTag: deriveMemoryIdentity(
          {
            memoryOwnerId: target.memoryOwnerId,
            conversationId: target.conversationId,
          },
          { salt: TEST_SALT },
        ).containerTag,
      }),
    );
  });

  it("uses legacy fallback only for provider failures, not an empty profile", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const recallLegacy = vi.fn(async () => ["legacy preference"]);
    const env = {
      DANIEL_MEMORY_READ_MODE: "supermemory",
      DANIEL_MEMORY_LEGACY_FALLBACK: "true",
      DANIEL_MEMORY_ID_SALT: TEST_SALT,
    };

    await expect(
      recallPreferenceLines(target, {
        env,
        provider: provider(vi.fn(async () => hydration())),
        recallLegacy,
        ensureIdentitySaltFingerprint: async (fingerprint) => fingerprint,
      }),
    ).resolves.toEqual([]);
    expect(recallLegacy).not.toHaveBeenCalled();

    await expect(
      recallPreferenceLines(target, {
        env,
        provider: provider(
          vi.fn(async () => {
            throw new TypeError("provider unavailable");
          }),
        ),
        recallLegacy,
        ensureIdentitySaltFingerprint: async (fingerprint) => fingerprint,
      }),
    ).resolves.toEqual(["legacy preference"]);
    expect(recallLegacy).toHaveBeenCalledOnce();
  });

  it("refuses a changed deployment salt before querying the owner container", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const profile = vi.fn(async () => hydration(["must not be read"]));
    const recallLegacy = vi.fn(async () => ["legacy preference"]);

    await expect(
      recallPreferenceLines(target, {
        env: {
          DANIEL_MEMORY_READ_MODE: "supermemory",
          DANIEL_MEMORY_LEGACY_FALLBACK: "true",
          DANIEL_MEMORY_ID_SALT: TEST_SALT,
        },
        provider: provider(profile),
        recallLegacy,
        ensureIdentitySaltFingerprint: async () =>
          memoryIdSaltFingerprint("different-proactive-salt-987654321"),
      }),
    ).resolves.toEqual([]);
    expect(profile).not.toHaveBeenCalled();
    expect(recallLegacy).not.toHaveBeenCalled();
  });

  it("passes the same owner into synthetic proactive dispatch so capture is skipped", async () => {
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
