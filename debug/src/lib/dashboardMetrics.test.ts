import { describe, expect, it } from "vitest";
import { cutoffDate, deriveDashboardMetrics, type DailyBucket } from "./dashboardMetrics.js";

const buckets: DailyBucket[] = [
  {
    day: "2026-01-01",
    agentCost: 1,
    inputTokens: 100,
    outputTokens: 20,
    agentsSpawned: 2,
    agentsCompleted: 1,
    agentsFailed: 1,
    agentsCancelled: 0,
    automationRuns: 3,
  },
  {
    day: "2026-01-10",
    agentCost: 2.5,
    inputTokens: 250,
    outputTokens: 50,
    agentsSpawned: 3,
    agentsCompleted: 3,
    agentsFailed: 0,
    agentsCancelled: 0,
    automationRuns: 4,
  },
];

describe("dashboard metrics", () => {
  it("preserves all-time totals", () => {
    const metrics = deriveDashboardMetrics(buckets, "all");
    expect(metrics.cost.total).toBe(3.5);
    expect(metrics.tokens).toEqual({ input: 350, output: 70, total: 420 });
    expect(metrics.agents).toMatchObject({ total: 5, completed: 4, failed: 1 });
    expect(metrics.agents.failureRate).toBe(0.2);
    expect(metrics.automationRuns).toBe(7);
  });

  it("filters finite ranges against the supplied clock", () => {
    const now = Date.parse("2026-01-12T12:00:00Z");
    expect(cutoffDate("7d", now)).toBe("2026-01-05");
    const metrics = deriveDashboardMetrics(buckets, "7d", now);
    expect(metrics.days.map((day) => day.day)).toEqual(["2026-01-10"]);
    expect(metrics.cost.total).toBe(2.5);
  });

  it("returns a zero failure rate when no agents spawned", () => {
    const metrics = deriveDashboardMetrics([], "all");
    expect(metrics.agents.failureRate).toBe(0);
    expect(metrics.tokens.total).toBe(0);
  });
});
