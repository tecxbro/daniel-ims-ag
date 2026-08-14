export type TimeRange = "all" | "7d" | "30d" | "90d";

export interface DailyBucket {
  day: string;
  agentCost: number;
  inputTokens: number;
  outputTokens: number;
  agentsSpawned: number;
  agentsCompleted: number;
  agentsFailed: number;
  agentsCancelled: number;
  automationRuns: number;
}

export function cutoffDate(range: TimeRange, now = Date.now()): string | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

export function deriveDashboardMetrics(
  buckets: DailyBucket[],
  range: TimeRange,
  now = Date.now(),
) {
  const cutoff = cutoffDate(range, now);
  const days = cutoff ? buckets.filter((bucket) => bucket.day >= cutoff) : buckets;
  let agentCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let agentsSpawned = 0;
  let agentsCompleted = 0;
  let agentsFailed = 0;
  let agentsCancelled = 0;
  let automationRuns = 0;

  for (const day of days) {
    agentCost += day.agentCost;
    inputTokens += day.inputTokens;
    outputTokens += day.outputTokens;
    agentsSpawned += day.agentsSpawned;
    agentsCompleted += day.agentsCompleted;
    agentsFailed += day.agentsFailed;
    agentsCancelled += day.agentsCancelled;
    automationRuns += day.automationRuns;
  }

  const totalTokens = inputTokens + outputTokens;
  return {
    days,
    cost: { total: agentCost, agents: agentCost },
    tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
    agents: {
      total: agentsSpawned,
      completed: agentsCompleted,
      failed: agentsFailed,
      cancelled: agentsCancelled,
      failureRate: agentsSpawned > 0 ? agentsFailed / agentsSpawned : 0,
    },
    automationRuns,
  };
}
