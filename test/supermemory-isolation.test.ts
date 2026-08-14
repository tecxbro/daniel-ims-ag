import { describe, expect, it, vi } from "vitest";
import {
  hydrateMemoryContext,
  recallMemory,
} from "../server/memory/supermemory/context.js";
import { deriveMemoryIdentity } from "../server/memory/supermemory/identity.js";
import type {
  DanielMemoryProvider,
  MemoryHydrationResult,
  MemoryOwnerContext,
  MemorySearchResult,
} from "../server/memory/supermemory/types.js";

const TEST_SALT = "test-only-isolation-salt-0123456789";

function identity(memoryOwnerId: string): MemoryOwnerContext {
  return deriveMemoryIdentity(
    { memoryOwnerId, conversationId: `fixture:${memoryOwnerId}` },
    { salt: TEST_SALT },
  );
}

function result(id: string, content: string): MemorySearchResult {
  return { id, content, kind: "memory", similarity: 0.9, metadata: null };
}

function emptyHydration(results: MemorySearchResult[] = []): MemoryHydrationResult {
  return {
    provider: "supermemory",
    profile: { static: [], dynamic: [] },
    results,
    latencyMs: 1,
  };
}

describe("Supermemory per-user request isolation", () => {
  it("never returns one derived container's results for another container", async () => {
    const userA = identity("fixture-user-a");
    const userB = identity("fixture-user-b");
    const byContainer = new Map([
      [userA.containerTag, [result("a-fact", "Alpha's isolated project fact")]],
      [userB.containerTag, [result("b-fact", "Beta's isolated travel fact")]],
    ]);
    const profile = vi.fn(async ({ containerTag }: { containerTag: string }) =>
      emptyHydration(byContainer.get(containerTag) ?? []),
    ) as DanielMemoryProvider["profile"];
    const search = vi.fn(async ({ containerTag }: { containerTag: string }) =>
      byContainer.get(containerTag) ?? [],
    ) as DanielMemoryProvider["search"];
    const provider = { profile, search };

    const hydratedA = await hydrateMemoryContext({
      provider,
      owner: userA,
      currentUserMessage: "project",
      mode: "shadow",
      env: {},
    });
    const recalledB = await recallMemory({
      provider,
      owner: userB,
      q: "travel",
      mode: "shadow",
      env: {},
    });

    expect(hydratedA.hydration.results.map((item) => item.id)).toEqual(["a-fact"]);
    expect(hydratedA.formattedContext).not.toContain("Beta");
    expect(recalledB.results.map((item) => item.id)).toEqual(["b-fact"]);
    expect(recalledB.results.map((item) => item.content).join(" ")).not.toContain("Alpha");
    expect(profile).toHaveBeenCalledWith(expect.objectContaining({ containerTag: userA.containerTag }));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ containerTag: userB.containerTag }));
    expect(userA.containerTag).not.toBe(userB.containerTag);
  });

  it("fails open without a provider request when the container tag is mistyped", async () => {
    const valid = identity("fixture-user-a");
    const replacement = valid.containerTag.endsWith("0") ? "1" : "0";
    const mistyped = {
      ...valid,
      containerTag: `${valid.containerTag.slice(0, -1)}${replacement}`,
    };
    const profile = vi.fn<DanielMemoryProvider["profile"]>(async () => emptyHydration());
    const search = vi.fn<DanielMemoryProvider["search"]>(async () => []);

    const hydrated = await hydrateMemoryContext({
      provider: { profile, search },
      owner: mistyped,
      currentUserMessage: "hello",
      mode: "shadow",
      env: {},
      instrumentation: vi.fn(),
    });
    const recalled = await recallMemory({
      provider: { profile, search },
      owner: mistyped,
      q: "hello",
      mode: "shadow",
      env: {},
      instrumentation: vi.fn(),
    });

    expect(hydrated).toMatchObject({ status: "failed", error: { code: "isolation" } });
    expect(recalled).toMatchObject({ status: "failed", error: { code: "isolation" } });
    expect(profile).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("never includes raw phone numbers in provider requests", async () => {
    const phone = "+15550001001";
    const owner = identity(phone);
    const profile = vi.fn<DanielMemoryProvider["profile"]>(async () => emptyHydration());
    const search = vi.fn<DanielMemoryProvider["search"]>(async () => []);
    const provider = { profile, search };

    await hydrateMemoryContext({
      provider,
      owner,
      currentUserMessage: "hello",
      mode: "shadow",
      env: {},
    });
    await recallMemory({
      provider,
      owner,
      q: "travel preferences",
      mode: "shadow",
      env: {},
    });

    const requests = JSON.stringify([
      ...profile.mock.calls.map(([request]) => request),
      ...search.mock.calls.map(([request]) => request),
    ]);
    expect(requests).not.toContain(phone);
    expect(requests).not.toContain(phone.replace(/\D/g, ""));
    expect(requests).toContain(owner.containerTag);
  });
});
