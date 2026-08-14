export type ProviderHealth =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unconfigured"
  | "recovery_required";

export type MemorySyncStatus =
  | "pending"
  | "processing"
  | "submitted"
  | "completed"
  | "failed"
  | "dead_letter";

export interface MemorySyncJobSummary {
  jobId: string;
  kind: "conversation_turn";
  status: MemorySyncStatus;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  providerDocumentId?: string;
  providerMemoryIds: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface DashboardMemoryProvider {
  configured: boolean;
  healthStatus: ProviderHealth;
  lastSuccessfulSubmissionAt?: number;
  lastFailedSubmissionAt?: number;
  lastWorkerActivityAt?: number;
  hasError: boolean;
}

export interface DashboardSyncSnapshot {
  pending: number;
  processing: number;
  submitted: number;
  completed: number;
  failed: number;
  deadLetter: number;
  active: number;
  total: number;
  captureCompletionRate: number | null;
  recentJobs: MemorySyncJobSummary[];
}

export interface DashboardHydrationSnapshot {
  requests: number;
  failures: number;
  averageLatencyMs: number | null;
  p95UpperBoundMs: number | null;
  observedBuckets: number;
}

export interface DashboardProviderEvent {
  eventId: string;
  operation: string;
  outcome: "success" | "failure";
  latencyMs?: number;
  errorCode?: string;
  createdAt: number;
}

export interface DashboardImageAnchors {
  pending: number;
  active: number;
  released: number;
  total: number;
}

export interface DashboardSnapshot {
  messages: number | null;
  memoryProvider: DashboardMemoryProvider | null;
  hydration: DashboardHydrationSnapshot | null;
  sync: DashboardSyncSnapshot | null;
  providerEvents: DashboardProviderEvent[] | null;
  imageAnchors: DashboardImageAnchors | null;
  agents: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    running: number;
  } | null;
  cost: { total: number } | null;
  tokens: { input: number; output: number } | null;
  truncated: boolean;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function optionalNumber(value: unknown): number | undefined {
  return finiteNumber(value) ?? undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerHealth(value: unknown): ProviderHealth | null {
  return value === "healthy" ||
    value === "degraded" ||
    value === "unavailable" ||
    value === "unconfigured" ||
    value === "recovery_required"
    ? value
    : null;
}

function syncStatus(value: unknown): MemorySyncStatus | null {
  return value === "pending" ||
    value === "processing" ||
    value === "submitted" ||
    value === "completed" ||
    value === "failed" ||
    value === "dead_letter"
    ? value
    : null;
}

function normalizeJob(value: unknown): MemorySyncJobSummary | null {
  const raw = record(value);
  if (!raw || raw.kind !== "conversation_turn") return null;
  const jobId = optionalText(raw.jobId);
  const status = syncStatus(raw.status);
  const attempts = count(raw.attempts);
  if (!jobId || !status || attempts === null) return null;
  return {
    jobId,
    kind: "conversation_turn",
    status,
    attempts,
    nextAttemptAt: optionalNumber(raw.nextAttemptAt),
    lastError: optionalText(raw.lastError),
    providerDocumentId: optionalText(raw.providerDocumentId),
    providerMemoryIds: Array.isArray(raw.providerMemoryIds)
      ? raw.providerMemoryIds.filter((id): id is string => typeof id === "string")
      : [],
    createdAt: optionalNumber(raw.createdAt),
    updatedAt: optionalNumber(raw.updatedAt),
  };
}

function normalizeProvider(value: unknown): DashboardMemoryProvider | null {
  const raw = record(value);
  if (!raw || typeof raw.configured !== "boolean") return null;
  const healthStatus = providerHealth(raw.healthStatus);
  if (!healthStatus) return null;
  return {
    configured: raw.configured,
    healthStatus,
    lastSuccessfulSubmissionAt: optionalNumber(raw.lastSuccessfulSubmissionAt),
    lastFailedSubmissionAt: optionalNumber(raw.lastFailedSubmissionAt),
    lastWorkerActivityAt: optionalNumber(raw.lastWorkerActivityAt),
    hasError: raw.hasError === true || optionalText(raw.lastError) !== undefined,
  };
}

function normalizeSync(value: unknown): DashboardSyncSnapshot | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.recentJobs)) return null;
  const pending = count(raw.pending);
  const processing = count(raw.processing);
  const submitted = count(raw.submitted);
  const completed = count(raw.completed);
  const failed = count(raw.failed);
  const deadLetter = count(raw.deadLetter);
  const active = count(raw.active);
  const total = count(raw.total);
  const captureCompletionRate =
    raw.captureCompletionRate === null ? null : finiteNumber(raw.captureCompletionRate);
  if (
    pending === null ||
    processing === null ||
    submitted === null ||
    completed === null ||
    failed === null ||
    deadLetter === null ||
    active === null ||
    total === null ||
    captureCompletionRate === null && raw.captureCompletionRate !== null
  ) {
    return null;
  }
  return {
    pending,
    processing,
    submitted,
    completed,
    failed,
    deadLetter,
    active,
    total,
    captureCompletionRate,
    recentJobs: raw.recentJobs
      .map(normalizeJob)
      .filter((job): job is MemorySyncJobSummary => job !== null),
  };
}

function normalizeHydration(value: unknown): DashboardHydrationSnapshot | null {
  const raw = record(value);
  if (!raw) return null;
  const requests = count(raw.requests);
  const failures = count(raw.failures);
  const observedBuckets = count(raw.observedBuckets);
  const averageLatencyMs =
    raw.averageLatencyMs === null ? null : finiteNumber(raw.averageLatencyMs);
  const p95UpperBoundMs =
    raw.p95UpperBoundMs === null ? null : finiteNumber(raw.p95UpperBoundMs);
  if (
    requests === null ||
    failures === null ||
    observedBuckets === null ||
    averageLatencyMs === null && raw.averageLatencyMs !== null ||
    p95UpperBoundMs === null && raw.p95UpperBoundMs !== null
  ) {
    return null;
  }
  return { requests, failures, averageLatencyMs, p95UpperBoundMs, observedBuckets };
}

function normalizeProviderEvents(value: unknown): DashboardProviderEvent[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const raw = record(entry);
    const eventId = optionalText(raw?.eventId);
    const operation = optionalText(raw?.operation);
    const createdAt = finiteNumber(raw?.createdAt);
    if (
      !raw ||
      !eventId ||
      !operation ||
      createdAt === null ||
      (raw.outcome !== "success" && raw.outcome !== "failure")
    ) {
      return [];
    }
    return [{
      eventId,
      operation,
      outcome: raw.outcome,
      latencyMs: optionalNumber(raw.latencyMs),
      errorCode: optionalText(raw.errorCode),
      createdAt,
    }];
  });
}

function normalizeCounts<T extends string>(
  value: unknown,
  keys: readonly T[],
): Record<T, number> | null {
  const raw = record(value);
  if (!raw) return null;
  const entries = keys.map((key) => [key, count(raw[key])] as const);
  if (entries.some(([, value]) => value === null)) return null;
  return Object.fromEntries(entries) as Record<T, number>;
}

export function normalizeDashboardSnapshot(value: unknown): DashboardSnapshot {
  const raw = record(value) ?? {};
  const imageAnchors = normalizeCounts(raw.imageAnchors, [
    "pending",
    "active",
    "released",
    "total",
  ] as const);
  const agents = normalizeCounts(raw.agents, [
    "total",
    "completed",
    "failed",
    "cancelled",
    "running",
  ] as const);
  const cost = normalizeCounts(raw.cost, ["total"] as const);
  const tokens = normalizeCounts(raw.tokens, ["input", "output"] as const);
  return {
    messages: count(raw.messages),
    memoryProvider: normalizeProvider(raw.memoryProvider),
    hydration: normalizeHydration(raw.hydration),
    sync: normalizeSync(raw.sync),
    providerEvents: normalizeProviderEvents(raw.providerEvents),
    imageAnchors,
    agents,
    cost,
    tokens,
    truncated: raw.truncated === true,
  };
}
