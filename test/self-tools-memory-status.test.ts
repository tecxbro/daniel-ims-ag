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
  readMode: "shadow",
  writeMode: "dual",
  timeoutMs: 1_200,
  threshold: 0.6,
  searchLimit: 8,
  dreaming: "dynamic",
  historyBackfillDays: 0,
  legacyFallback: true,
  apiKeyConfigured: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("self-tool memory provider status", () => {
  it("reads provider health and sync backlog from the durable Convex modules", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        healthStatus: "degraded",
        lastSuccessfulSubmissionAt: 100,
        lastFailedSubmissionAt: 200,
        lastError: "provider timeout",
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
        lastError: "provider timeout",
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
  });

  it("keeps partial status available if one operational query fails", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider state unavailable"))
      .mockResolvedValueOnce({ pending: 1, failed: 2, total: 3 });

    await expect(readMemoryProviderOperationalStatus({ query })).resolves.toMatchObject({
      providerState: null,
      providerStateAvailable: false,
      syncBacklog: { pending: 1, failed: 2, total: 3 },
      syncBacklogAvailable: true,
    });
  });

  it("exposes shadow/dual modes, operational timestamps, and inactive fallback", () => {
    const status = buildMemoryRuntimeStatus(configuredMemory, {
      providerState: {
        healthStatus: "healthy",
        lastSuccessfulSubmissionAt: 100,
        lastFailedSubmissionAt: 90,
        lastError: "old failure",
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
    });

    expect(status).toMatchObject({
      memoryProvider: "supermemory",
      memoryReadMode: "shadow",
      memoryCaptureMode: "dual",
      memoryWriteMode: "dual",
      memoryProviderHealth: "healthy",
      memoryLastProviderSuccessAt: 100,
      memoryLastProviderFailureAt: 90,
      memoryLastProviderFailure: "old failure",
      memoryLegacyFallback: {
        enabled: true,
        active: false,
        status: "inactive",
      },
    });
  });

  it("marks fallback provider-error-only after read cutover and overrides stale health", () => {
    const operational = {
      providerState: {
        healthStatus: "healthy" as const,
        lastSuccessfulSubmissionAt: null,
        lastFailedSubmissionAt: null,
        lastError: null,
        lastWorkerActivityAt: null,
        updatedAt: null,
      },
      syncBacklog: null,
      providerStateAvailable: true,
      syncBacklogAvailable: false,
    };
    const cutover = buildMemoryRuntimeStatus(
      { ...configuredMemory, readMode: "supermemory" },
      operational,
    );
    expect(cutover.memoryLegacyFallback).toEqual({
      enabled: true,
      active: true,
      status: "provider_errors_only",
    });

    expect(
      buildMemoryRuntimeStatus(
        { ...configuredMemory, apiKeyConfigured: false },
        operational,
      ).memoryProviderHealth,
    ).toBe("unconfigured");
    expect(
      buildMemoryRuntimeStatus(
        { ...configuredMemory, readMode: "convex", writeMode: "convex" },
        operational,
      ).memoryProviderHealth,
    ).toBe("disabled");
  });

  it("reports legacy embeddings retired while returning live provider status", async () => {
    const query = vi.spyOn(convex, "query").mockImplementation(async (reference) => {
      const name = getFunctionName(reference);
      if (name === "memoryProviderState:getDeploymentState") {
        return {
          healthStatus: "healthy",
          lastSuccessfulSubmissionAt: 100,
          updatedAt: 110,
        } as never;
      }
      if (name === "memorySyncJobs:backlog") {
        return { pending: 2, active: 2, total: 2 } as never;
      }
      return null as never;
    });
    vi.stubEnv("DANIEL_MEMORY_READ_MODE", "shadow");
    vi.stubEnv("DANIEL_MEMORY_WRITE_MODE", "dual");
    vi.stubEnv("DANIEL_MEMORY_LEGACY_FALLBACK", "true");
    vi.stubEnv("SUPERMEMORY_API_KEY", "test-key");

    const getConfig = createSelfTools().find((tool) => tool.name === "get_config");
    expect(getConfig).toBeDefined();
    const result = await getConfig!.handle({});
    const config = JSON.parse(result.text) as Record<string, unknown>;

    expect(query).toHaveBeenCalled();
    expect(config).toMatchObject({
      embeddingsEnabled: false,
      embeddingsProvider: "retired",
      memoryProvider: "supermemory",
      memoryReadMode: "shadow",
      memoryCaptureMode: "dual",
      memoryWriteMode: "dual",
      memoryProviderHealth: "healthy",
      memorySyncBacklog: { pending: 2, active: 2, total: 2 },
      memoryLastProviderSuccessAt: 100,
      memoryLegacyFallback: { enabled: true, active: false, status: "inactive" },
    });
    expect(config.memoryLegacyRuntime).toBe("retired");
  });
});
