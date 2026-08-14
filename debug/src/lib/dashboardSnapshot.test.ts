import { describe, expect, it } from "vitest";
import { normalizeDashboardSnapshot } from "./dashboardSnapshot.js";

function completeSnapshot() {
  return {
    messages: 0,
    memoryProvider: {
      configured: false,
      healthStatus: "unconfigured",
      hasError: false,
    },
    hydration: {
      requests: 0,
      failures: 0,
      averageLatencyMs: null,
      p95UpperBoundMs: null,
      observedBuckets: 0,
    },
    sync: {
      pending: 0,
      processing: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      active: 0,
      total: 0,
      captureCompletionRate: null,
      recentJobs: [],
    },
    providerEvents: [],
    imageAnchors: { pending: 0, active: 0, released: 0, total: 0 },
    agents: { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0 },
    cost: { total: 0 },
    tokens: { input: 0, output: 0 },
    truncated: false,
  };
}

describe("dashboard snapshot normalization", () => {
  it("preserves explicit empty arrays and zero counts as available data", () => {
    expect(normalizeDashboardSnapshot(completeSnapshot())).toMatchObject({
      messages: 0,
      memoryProvider: { configured: false, healthStatus: "unconfigured" },
      hydration: { requests: 0 },
      sync: { total: 0, recentJobs: [] },
      providerEvents: [],
      imageAnchors: { total: 0 },
      cost: { total: 0 },
      tokens: { input: 0, output: 0 },
    });
  });

  it("marks missing or malformed sections unavailable without inventing zeros", () => {
    expect(normalizeDashboardSnapshot({ memoryProvider: {}, sync: { recentJobs: [] } })).toEqual({
      messages: null,
      memoryProvider: null,
      hydration: null,
      sync: null,
      providerEvents: null,
      imageAnchors: null,
      agents: null,
      cost: null,
      tokens: null,
      truncated: false,
    });
  });

  it("accepts only conversation-turn jobs from an older mixed-kind response", () => {
    const value = completeSnapshot();
    value.sync.recentJobs = [
      {
        jobId: "capture-1",
        kind: "conversation_turn",
        status: "completed",
        attempts: 1,
        providerMemoryIds: [],
      },
      {
        jobId: "old-kind",
        kind: "image",
        status: "completed",
        attempts: 1,
        providerMemoryIds: [],
      },
    ] as never[];
    expect(normalizeDashboardSnapshot(value).sync?.recentJobs).toEqual([
      expect.objectContaining({ jobId: "capture-1", kind: "conversation_turn" }),
    ]);
  });
});
