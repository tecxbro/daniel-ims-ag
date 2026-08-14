import { describe, expect, it, vi } from "vitest";
import {
  DANIEL_ENTITY_CONTEXT,
  createContainerSettingsCoordinator,
  type MemoryProviderContainerState,
} from "../server/memory/supermemory/container.js";
import { memoryIdSaltFingerprint } from "../server/memory/supermemory/identity.js";

const SALT_A = "9".repeat(64);
const SALT_B = "a".repeat(64);

describe("Supermemory container settings contract", () => {
  it("updates once, persists initialization, and skips later settings requests", async () => {
    let state: MemoryProviderContainerState | null = null;
    let identitySaltFingerprint: string | null = null;
    const stateStore = {
      ensureIdentitySaltFingerprint: vi.fn(async (fingerprint: string) => {
        identitySaltFingerprint ??= fingerprint;
        return identitySaltFingerprint;
      }),
      getContainerState: vi.fn(async () => state),
      markContainerInitialized: vi.fn(async (next: MemoryProviderContainerState) => {
        state = next;
      }),
    };
    const provider = {
      getContainerSettings: vi.fn(),
      updateContainerSettings: vi.fn(async (containerTag: string, entityContext: string) => ({
        containerTag,
        name: null,
        entityContext,
      })),
    };
    const coordinator = createContainerSettingsCoordinator({
      stateStore,
      provider,
      now: () => 1_723_510_800_000,
      memoryIdSalt: SALT_A,
    });

    const [first, concurrent] = await Promise.all([
      coordinator.ensureContainerSettings("daniel-user-abc123"),
      coordinator.ensureContainerSettings("daniel-user-abc123"),
    ]);
    const later = await coordinator.ensureContainerSettings("daniel-user-abc123");

    expect(first).toEqual({ initialized: true, initializedAt: 1_723_510_800_000 });
    expect(concurrent).toEqual(first);
    expect(later).toEqual({ initialized: false, initializedAt: 1_723_510_800_000 });
    expect(provider.updateContainerSettings).toHaveBeenCalledTimes(1);
    expect(provider.updateContainerSettings).toHaveBeenCalledWith(
      "daniel-user-abc123",
      DANIEL_ENTITY_CONTEXT,
    );
    expect(stateStore.markContainerInitialized).toHaveBeenCalledWith({
      containerTag: "daniel-user-abc123",
      initializedAt: 1_723_510_800_000,
      saltFingerprint: memoryIdSaltFingerprint(SALT_A),
    });
    expect(DANIEL_ENTITY_CONTEXT.length).toBeLessThanOrEqual(1_500);
  });

  it("detects salt drift before touching provider settings", async () => {
    const provider = {
      getContainerSettings: vi.fn(),
      updateContainerSettings: vi.fn(),
    };
    const coordinator = createContainerSettingsCoordinator({
      stateStore: {
        ensureIdentitySaltFingerprint: async () => memoryIdSaltFingerprint(SALT_A),
        getContainerState: async () => null,
        markContainerInitialized: vi.fn(),
      },
      provider,
      memoryIdSalt: SALT_B,
    });

    await expect(coordinator.ensureContainerSettings("daniel-user-new-after-salt-change")).rejects.toThrow(
      /DANIEL_MEMORY_ID_SALT changed/,
    );
    expect(provider.updateContainerSettings).not.toHaveBeenCalled();
  });
});
