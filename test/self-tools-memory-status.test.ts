import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convex } from "../server/convex-client.js";
import {
  buildMemoryRuntimeStatus,
  createSelfTools,
  readMemoryProviderOperationalStatus,
} from "../server/self-tools.js";
import type { MemoryProviderConfiguration } from "../server/memory/supermemory/types.js";

const configuredMemory: MemoryProviderConfiguration = {
  timeoutMs: 1_200,
  threshold: 0.6,
  searchLimit: 8,
  dreaming: "dynamic",
  apiKeyConfigured: true,
};

const availableOperationalState = {
  providerState: {
    healthStatus: "healthy" as const,
    lastSuccessfulSubmissionAt: 100,
    lastFailedSubmissionAt: 90,
    hasError: false,
    lastWorkerActivityAt: 110,
    updatedAt: 120,
  },
  syncBacklog: {
    pending: 1,
    processing: 0,
    submitted: 0,
    completed: 4,
    failed: 0,
    deadLetter: 0,
    active: 1,
    total: 5,
    truncated: false,
  },
  providerStateAvailable: true,
  syncBacklogAvailable: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("self-tool memory provider status", () => {
  it("reads sanitized provider health and the durable sync backlog", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 100,
        lastFailedSubmissionAt: 200,
        hasError: true,
        lastError: "sensitive provider detail",
        lastWorkerActivityAt: 250,
        updatedAt: 300,
      })
      .mockResolvedValueOnce({
        counts: {
          pending: { count: 2 },
          processing: { count: 1 },
          submitted: { count: 3 },
          completed: { count: 8 },
          failed: { count: 4 },
          dead_letter: { count: 5 },
        },
        active: 10,
        total: 23,
        truncated: false,
      });

    const status = await readMemoryProviderOperationalStatus({ query });

    expect(query.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "memoryProviderState:getDeploymentState",
      "memorySyncJobs:backlog",
    ]);
    expect(status).toEqual({
      providerState: {
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 100,
        lastFailedSubmissionAt: 200,
        hasError: true,
        lastWorkerActivityAt: 250,
        updatedAt: 300,
      },
      syncBacklog: {
        pending: 2,
        processing: 1,
        submitted: 3,
        completed: 8,
        failed: 4,
        deadLetter: 5,
        active: 10,
        total: 23,
        truncated: false,
      },
      providerStateAvailable: true,
      syncBacklogAvailable: true,
    });
    expect(JSON.stringify(status)).not.toContain("sensitive provider detail");
  });

  it("keeps the independent sync result when provider state is unavailable", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider state unavailable"))
      .mockResolvedValueOnce({ pending: 1, failed: 2, total: 3 });

    await expect(readMemoryProviderOperationalStatus({ query })).resolves.toEqual({
      providerState: null,
      providerStateAvailable: false,
      syncBacklog: {
        pending: 1,
        processing: 0,
        submitted: 0,
        completed: 0,
        failed: 2,
        deadLetter: 0,
        active: 3,
        total: 3,
        truncated: false,
      },
      syncBacklogAvailable: true,
    });
  });

  it("reports unconfigured without advertising a capture job", () => {
    expect(
      buildMemoryRuntimeStatus(
        { ...configuredMemory, apiKeyConfigured: false },
        availableOperationalState,
      ),
    ).toMatchObject({
      memoryProvider: "supermemory",
      memoryProviderHealth: "unconfigured",
      memoryCaptureKind: null,
      memoryProviderHasError: false,
      supermemoryConfigured: false,
    });
  });

  it("reports identity recovery while retaining the sole configured capture kind", () => {
    const status = buildMemoryRuntimeStatus(configuredMemory, {
      ...availableOperationalState,
      providerState: {
        ...availableOperationalState.providerState,
        healthStatus: "recovery_required",
        hasError: true,
      },
    });

    expect(status).toMatchObject({
      memoryProvider: "supermemory",
      memoryProviderHealth: "recovery_required",
      memoryCaptureKind: null,
      memoryProviderHasError: true,
      supermemoryConfigured: true,
    });
    expect(status).not.toHaveProperty("memoryLastProviderFailure");
  });

  it("reports healthy configured operation and normalized backlog timestamps", () => {
    expect(buildMemoryRuntimeStatus(configuredMemory, availableOperationalState)).toEqual({
      memoryProvider: "supermemory",
      memoryProviderHealth: "healthy",
      memoryCaptureKind: "conversation_turn",
      memorySyncBacklog: availableOperationalState.syncBacklog,
      memoryLastProviderSuccessAt: 100,
      memoryLastProviderFailureAt: 90,
      memoryProviderHasError: false,
      memoryLastWorkerActivityAt: 110,
      memoryProviderStateUpdatedAt: 120,
      memoryProviderStateAvailable: true,
      memorySyncBacklogAvailable: true,
      supermemoryConfigured: true,
    });
  });

  it("returns the current provider contract from get_config without error detail", async () => {
    const query = vi.spyOn(convex, "query").mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "memoryProviderState:getDeploymentState") {
        return {
          healthStatus: "healthy",
          lastSuccessfulSubmissionAt: 100,
          lastFailedSubmissionAt: 90,
          hasError: true,
          lastError: "do not expose this",
          lastWorkerActivityAt: 105,
          updatedAt: 110,
        } as never;
      }
      if (name === "memorySyncJobs:backlog") {
        return { pending: 2, active: 2, total: 2 } as never;
      }
      if (name === "memoryProviderState:getIdentityPresence") {
        return {
          hasSaltFingerprint: false,
          hasPairingAuthority: false,
          hasPrimaryOwner: false,
          recoveryRequired: false,
        } as never;
      }
      return null as never;
    });
    vi.spyOn(convex, "mutation").mockResolvedValue({ status: "ready" } as never);
    vi.stubEnv("SUPERMEMORY_API_KEY", "test-key");
    vi.stubEnv("DANIEL_MEMORY_ID_SALT", "c".repeat(64));

    const getConfig = createSelfTools().find((tool) => tool.name === "get_config");
    expect(getConfig).toBeDefined();
    const result = await getConfig!.handle({});
    const config = JSON.parse(result.text) as Record<string, unknown>;

    expect(query).toHaveBeenCalled();
    expect(config).toMatchObject({
      memoryProvider: "supermemory",
      memoryProviderHealth: "healthy",
      memoryCaptureKind: "conversation_turn",
      memoryProviderHasError: true,
      memorySyncBacklog: { pending: 2, active: 2, total: 2 },
      memoryLastProviderSuccessAt: 100,
      memoryLastProviderFailureAt: 90,
      supermemoryConfigured: true,
    });
    expect(result.text).not.toContain("do not expose this");
  });
});
