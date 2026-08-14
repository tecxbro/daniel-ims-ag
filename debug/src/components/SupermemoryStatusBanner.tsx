import { useCallback, useEffect, useState } from "react";
import { useSocket } from "../lib/useSocket.js";
import type { ProviderHealth } from "../lib/dashboardSnapshot.js";

export interface ProviderStatus {
  configured: boolean | null;
  health: ProviderHealth;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastWorkerActivityAt?: number;
  backlog: {
    pending: number;
    processing: number;
    submitted: number;
    completed: number;
    failed: number;
    deadLetter: number;
    active: number;
    total: number;
  } | null;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | null {
  const nested = record(value);
  const candidate = numberValue(value) ?? numberValue(nested?.count);
  return candidate !== undefined && candidate >= 0 ? candidate : null;
}

function normalizeHealth(value: unknown, configured: boolean | null): ProviderHealth {
  if (
    value === "healthy" ||
    value === "degraded" ||
    value === "unavailable" ||
    value === "unconfigured" ||
    value === "recovery_required"
  ) {
    return value;
  }
  return configured === false ? "unconfigured" : "unavailable";
}

function normalizeBacklog(value: unknown): ProviderStatus["backlog"] {
  const raw = record(value);
  if (!raw) return null;
  const counts = record(raw.counts) ?? raw;
  const pending = count(counts.pending);
  const processing = count(counts.processing);
  const submitted = count(counts.submitted);
  const completed = count(counts.completed);
  const failed = count(counts.failed);
  const deadLetter = count(counts.deadLetter ?? counts.dead_letter);
  if (
    pending === null ||
    processing === null ||
    submitted === null ||
    completed === null ||
    failed === null ||
    deadLetter === null
  ) {
    return null;
  }
  const suppliedActive = count(raw.active);
  const suppliedTotal = count(raw.total);
  const active = suppliedActive ?? pending + processing + submitted + failed;
  const total = suppliedTotal ?? active + completed + deadLetter;
  return { pending, processing, submitted, completed, failed, deadLetter, active, total };
}

export function normalizeProviderStatus(value: unknown): ProviderStatus {
  const raw = record(value) ?? {};
  const healthRecord = record(raw.health);
  const provider = record(raw.state) ?? record(raw.memoryProvider);
  const configured =
    typeof raw.configured === "boolean"
      ? raw.configured
      : typeof provider?.configured === "boolean"
        ? provider.configured
        : null;
  return {
    configured,
    health: normalizeHealth(
      healthRecord?.status ?? raw.healthStatus ?? provider?.healthStatus,
      configured,
    ),
    lastSuccessAt: numberValue(
      healthRecord?.lastSuccessAt ?? raw.lastSuccessAt ?? provider?.lastSuccessfulSubmissionAt,
    ),
    lastFailureAt: numberValue(
      healthRecord?.lastFailureAt ?? raw.lastFailureAt ?? provider?.lastFailedSubmissionAt,
    ),
    lastWorkerActivityAt: numberValue(
      healthRecord?.lastWorkerActivityAt ?? raw.lastWorkerActivityAt ?? provider?.lastWorkerActivityAt,
    ),
    backlog: normalizeBacklog(raw.backlog ?? record(raw.sync)?.backlog ?? raw.sync),
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
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value)
    : "No activity reported";
}

function configurationLabel(configured: boolean | null): string {
  if (configured === true) return "Configured";
  if (configured === false) return "Not configured";
  return "Configuration unavailable";
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
      : health === "degraded" || health === "unconfigured" || health === "recovery_required"
        ? isDark
          ? "border-amber-400/20 bg-amber-400/10"
          : "border-amber-200 bg-amber-50"
        : isDark
          ? "border-rose-400/20 bg-rose-400/10"
          : "border-rose-200 bg-rose-50";
  const primary = isDark ? "text-zinc-100" : "text-zinc-950";
  const secondary = isDark ? "text-zinc-400" : "text-zinc-600";
  const backlog = status?.backlog;

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
              {status
                ? `${configurationLabel(status.configured)} · ${health}`
                : "Checking status"}
            </span>
          </div>
          <p className={`mt-1 text-xs leading-relaxed ${secondary}`}>
            {error
              ? error
              : backlog
                ? `${backlog.active} active · ${backlog.failed} failed · ${backlog.deadLetter} dead letters`
                : status
                  ? "Synchronization state unavailable."
                  : "Loading provider health and synchronization state…"}
          </p>
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
