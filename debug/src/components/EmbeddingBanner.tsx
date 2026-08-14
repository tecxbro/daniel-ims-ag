import { useCallback, useEffect, useState } from "react";
import { useSocket } from "../lib/useSocket.js";

export type ProviderHealth =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unconfigured"
  | "disabled";

export type MemorySyncStatus =
  | "pending"
  | "processing"
  | "submitted"
  | "completed"
  | "failed"
  | "dead_letter";

export interface MemorySyncJobSummary {
  jobId: string;
  kind: string;
  status: MemorySyncStatus;
  attempts: number;
  nextAttemptAt?: number;
  lastError?: string;
  providerDocumentId?: string;
  providerMemoryIds: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface ProviderEventSummary {
  id: string;
  type: string;
  status?: string;
  message?: string;
  jobId?: string;
  providerDocumentId?: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export interface ProviderStatus {
  configured: boolean;
  health: ProviderHealth;
  readMode: string;
  writeMode: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastWorkerActivityAt?: number;
  lastError?: string;
  profileState: "ready" | "empty" | "unavailable";
  backlog: {
    pending: number;
    processing: number;
    submitted: number;
    completed: number;
    failed: number;
    deadLetter: number;
    active: number;
    total: number;
  };
  recentJobs: MemorySyncJobSummary[];
  recentEvents: ProviderEventSummary[];
  hydration?: { latencyMs?: number; errorRate?: number };
  documents?: { pending?: number; processing?: number; completed?: number; failed?: number };
  memories?: { current?: number; latest?: number; forgotten?: number };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const nested = record(value);
  return Math.max(0, numberValue(nested.count) ?? 0);
}

function normalizeHealth(value: unknown): ProviderHealth {
  switch (value) {
    case "healthy":
    case "degraded":
    case "unavailable":
    case "unconfigured":
    case "disabled":
      return value;
    case "down":
      return "unavailable";
    default:
      return "unconfigured";
  }
}

function normalizeJob(value: unknown, index: number): MemorySyncJobSummary | null {
  const raw = record(value);
  const status = text(raw.status) as MemorySyncStatus;
  if (!["pending", "processing", "submitted", "completed", "failed", "dead_letter"].includes(status)) {
    return null;
  }
  const jobId = text(raw.jobId ?? raw.id);
  if (!jobId) return null;
  return {
    jobId,
    kind: text(raw.kind, "capture"),
    status,
    attempts: numberValue(raw.attempts) ?? 0,
    nextAttemptAt: numberValue(raw.nextAttemptAt),
    lastError: text(raw.lastError ?? raw.error) || undefined,
    providerDocumentId: text(raw.providerDocumentId) || undefined,
    providerMemoryIds: Array.isArray(raw.providerMemoryIds)
      ? raw.providerMemoryIds.filter((id): id is string => typeof id === "string")
      : [],
    createdAt: numberValue(raw.createdAt),
    updatedAt: numberValue(raw.updatedAt) ?? index,
  };
}

function normalizeEvent(value: unknown, index: number): ProviderEventSummary | null {
  const raw = record(value);
  const type = text(raw.type ?? raw.eventType ?? raw.event);
  if (!type) return null;
  return {
    id: text(raw.id ?? raw.eventId, `${type}:${numberValue(raw.createdAt) ?? index}`),
    type,
    status: text(raw.status) || undefined,
    message: text(raw.message ?? raw.detail ?? raw.error) || undefined,
    jobId: text(raw.jobId) || undefined,
    providerDocumentId: text(raw.providerDocumentId) || undefined,
    createdAt: numberValue(raw.createdAt ?? raw.at ?? raw.timestamp),
    metadata: Object.keys(record(raw.metadata)).length > 0 ? record(raw.metadata) : undefined,
  };
}

export function normalizeProviderStatus(value: unknown): ProviderStatus {
  const raw = record(value);
  const provider = record(raw.provider ?? raw.state);
  const healthRecord = record(raw.health);
  const sync = record(raw.sync);
  const backlog = record(raw.backlog ?? sync.backlog ?? sync.counts);
  const counts = record(backlog.counts);
  const health = normalizeHealth(
    healthRecord.status ?? raw.healthStatus ?? provider.health ?? provider.healthStatus,
  );
  const configuredValue = raw.configured ?? raw.apiConfigured ?? provider.configured;
  const recentJobValues = raw.recentJobs ?? raw.syncJobs ?? raw.jobs ?? sync.recentJobs;
  const eventValues = raw.recentEvents ?? raw.events;
  const hydration = record(raw.hydration);
  const documents = record(raw.documents);
  const memories = record(raw.memories);
  const pending = count(backlog.pending ?? counts.pending);
  const processing = count(backlog.processing ?? counts.processing);
  const submitted = count(backlog.submitted ?? counts.submitted);
  const completed = count(backlog.completed ?? counts.completed);
  const failed = count(backlog.failed ?? counts.failed);
  const deadLetter = count(backlog.deadLetter ?? backlog.dead_letter ?? counts.dead_letter);
  const active = count(backlog.active) || pending + processing + submitted + failed;
  const total = count(backlog.total) || active + completed + deadLetter;
  const profileStateValue = text(raw.profileState ?? provider.profileState);

  return {
    configured:
      typeof configuredValue === "boolean"
        ? configuredValue
        : health !== "unconfigured" && health !== "disabled",
    health,
    readMode: text(raw.readMode ?? provider.readMode, "unavailable"),
    writeMode: text(raw.writeMode ?? provider.writeMode, "unavailable"),
    lastSuccessAt: numberValue(
      healthRecord.lastSuccessAt ?? raw.lastSuccessAt ?? raw.lastSuccessfulSubmissionAt ?? provider.lastSuccessfulSubmissionAt,
    ),
    lastFailureAt: numberValue(
      healthRecord.lastFailureAt ?? raw.lastFailureAt ?? raw.lastFailedSubmissionAt ?? provider.lastFailedSubmissionAt,
    ),
    lastWorkerActivityAt: numberValue(
      healthRecord.lastWorkerActivityAt ?? raw.lastWorkerActivityAt ?? provider.lastWorkerActivityAt,
    ),
    lastError: text(raw.lastError ?? provider.lastError) || undefined,
    profileState:
      profileStateValue === "ready" || profileStateValue === "empty"
        ? profileStateValue
        : "unavailable",
    backlog: { pending, processing, submitted, completed, failed, deadLetter, active, total },
    recentJobs: Array.isArray(recentJobValues)
      ? recentJobValues
          .map(normalizeJob)
          .filter((job): job is MemorySyncJobSummary => job !== null)
      : [],
    recentEvents: Array.isArray(eventValues)
      ? eventValues
          .map(normalizeEvent)
          .filter((event): event is ProviderEventSummary => event !== null)
      : [],
    hydration:
      Object.keys(hydration).length > 0
        ? {
            latencyMs: numberValue(hydration.latencyMs),
            errorRate: numberValue(hydration.errorRate),
          }
        : undefined,
    documents:
      Object.keys(documents).length > 0
        ? {
            pending: numberValue(documents.pending),
            processing: numberValue(documents.processing),
            completed: numberValue(documents.completed),
            failed: numberValue(documents.failed),
          }
        : undefined,
    memories:
      Object.keys(memories).length > 0
        ? {
            current: numberValue(memories.current),
            latest: numberValue(memories.latest),
            forgotten: numberValue(memories.forgotten),
          }
        : undefined,
  };
}

export async function fetchProviderStatus(signal?: AbortSignal): Promise<ProviderStatus> {
  const response = await fetch("/api/memory/provider-status", {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Provider status unavailable (${response.status})`);
  return normalizeProviderStatus(await response.json());
}

function formatTimestamp(value: number | undefined): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value) : "No activity reported";
}

export function SupermemoryStatusBanner({ isDark }: { isDark: boolean }) {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await fetchProviderStatus());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchProviderStatus(controller.signal)
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);

  useSocket((event) => {
    if (event.event.startsWith("memory.")) void refresh();
  });

  const health = status?.health ?? "unavailable";
  const tone =
    health === "healthy"
      ? isDark
        ? "border-emerald-400/20 bg-emerald-400/10"
        : "border-emerald-200 bg-emerald-50"
      : health === "degraded"
        ? isDark
          ? "border-amber-400/20 bg-amber-400/10"
          : "border-amber-200 bg-amber-50"
        : isDark
          ? "border-rose-400/20 bg-rose-400/10"
          : "border-rose-200 bg-rose-50";
  const primary = isDark ? "text-zinc-100" : "text-zinc-950";
  const secondary = isDark ? "text-zinc-400" : "text-zinc-600";

  return (
    <section
      aria-label="Supermemory provider status"
      aria-live="polite"
      className={`rounded-2xl border px-4 py-3 ${tone}`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className={`text-sm font-semibold ${primary}`}>Supermemory provider</h2>
            <span className={`text-xs font-medium capitalize ${secondary}`}>
              {status ? `${status.configured ? "Configured" : "Not configured"} · ${health}` : "Checking status"}
            </span>
          </div>
          <p className={`mt-1 text-xs leading-relaxed ${secondary}`}>
            {error
              ? error
              : status
                ? `Read ${status.readMode} · Write ${status.writeMode} · ${status.backlog.active} active · ${status.backlog.failed} failed · ${status.backlog.deadLetter} dead letters`
                : "Loading provider health and synchronization state…"}
          </p>
          {status?.lastError && <p className="mt-1 break-words text-xs text-rose-400">Last failure: {status.lastError}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className={`text-end text-[11px] leading-relaxed ${secondary}`}>
            <div>Last success</div>
            <time>{formatTimestamp(status?.lastSuccessAt)}</time>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-busy={refreshing}
            className={`min-h-9 rounded-xl border px-3 text-xs font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              isDark
                ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
    </section>
  );
}
