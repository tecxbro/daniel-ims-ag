import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import type { MemorySyncJobSummary, MemorySyncStatus } from "./EmbeddingBanner.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  panelCardClass,
} from "./PanelPrimitives.js";

interface SyncDashboardData {
  sync: {
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
  };
  truncated: boolean;
}

const STATUS_ORDER: { key: keyof Omit<SyncDashboardData["sync"], "active" | "total" | "captureCompletionRate" | "recentJobs">; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "processing", label: "Processing" },
  { key: "submitted", label: "Submitted" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
  { key: "deadLetter", label: "Dead letter" },
];

function formatTime(value: number | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Not scheduled";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
}

function statusTone(status: MemorySyncStatus, isDark: boolean): string {
  if (status === "completed") {
    return isDark
      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";
  }
  if (status === "failed") {
    return isDark
      ? "border-amber-400/20 bg-amber-400/10 text-amber-300"
      : "border-amber-200 bg-amber-50 text-amber-700";
  }
  if (status === "dead_letter") {
    return isDark
      ? "border-rose-400/20 bg-rose-400/10 text-rose-300"
      : "border-rose-200 bg-rose-50 text-rose-700";
  }
  return isDark
    ? "border-sky-400/20 bg-sky-400/10 text-sky-300"
    : "border-sky-200 bg-sky-50 text-sky-700";
}

async function retryMemoryJob(job: MemorySyncJobSummary): Promise<void> {
  const endpoint =
    job.status === "dead_letter"
      ? "/api/memory/retry-dead-letter"
      : "/api/memory/retry-job";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.jobId }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: { message?: string } | string }
    | null;
  if (!response.ok || payload?.ok !== true) {
    const error = payload?.error;
    const message =
      typeof error === "string"
        ? error
        : error?.message ?? `Retry failed (${response.status})`;
    throw new Error(message);
  }
}

export function MemorySyncPanel({ isDark }: { isDark: boolean }) {
  const data = useQuery(api.dashboard.metrics, {}) as SyncDashboardData | undefined;
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState("Select a failed job to retry it.");
  const sync = data?.sync;

  async function retry(job: MemorySyncJobSummary) {
    setRetryingJobId(job.jobId);
    setRetryMessage(`Retrying ${job.jobId}…`);
    try {
      await retryMemoryJob(job);
      setRetryMessage(`${job.jobId} was queued for another attempt.`);
    } catch (cause) {
      setRetryMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetryingJobId(null);
    }
  }

  return (
    <PanelPage
      eyebrow="Durable outbox"
      title="Memory sync"
      description="Synchronization state between Convex application data and the Supermemory provider."
      stat={<HeaderPill isDark={isDark}>{sync?.active ?? 0} active</HeaderPill>}
      maxWidth="max-w-[1120px]"
    >
      <section aria-label="Synchronization counts" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {STATUS_ORDER.map(({ key, label }) => (
          <div key={key} className={panelCardClass(isDark, "min-w-0 p-4")}>
            <div className={`text-[11px] font-medium ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>{label}</div>
            <div className={`mt-1 text-2xl font-semibold mono ${key === "deadLetter" && (sync?.[key] ?? 0) > 0 ? "text-rose-400" : isDark ? "text-zinc-100" : "text-zinc-950"}`}>
              {sync?.[key] ?? 0}
            </div>
          </div>
        ))}
      </section>

      <section className={panelCardClass(isDark, "overflow-hidden")} aria-labelledby="sync-summary-heading">
        <div className={`flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between ${isDark ? "border-white/10" : "border-zinc-200"}`}>
          <div>
            <h2 id="sync-summary-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Outbox health</h2>
            <p className={`mt-1 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
              {sync?.captureCompletionRate === null || sync?.captureCompletionRate === undefined
                ? "Completion rate is unavailable until terminal jobs exist."
                : `${(sync.captureCompletionRate * 100).toFixed(1)}% terminal-job completion rate.`}
              {data?.truncated ? " Counts are a bounded snapshot." : ""}
            </p>
          </div>
          <p role="status" aria-live="polite" className={`max-w-lg text-xs ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>
            {retryMessage}
          </p>
        </div>

        {!data ? (
          <div className="space-y-3 p-5" aria-label="Loading synchronization jobs">
            {[1, 2, 3].map((item) => (
              <div key={item} className={`h-20 rounded-xl shimmer ${isDark ? "bg-white/5" : "bg-zinc-100"}`} />
            ))}
          </div>
        ) : data.sync.recentJobs.length === 0 ? (
          <EmptyState isDark={isDark}>
            No synchronization jobs yet. Completed conversations and explicit memory operations will enqueue durable work.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-start text-xs">
              <thead className={isDark ? "bg-black/20 text-zinc-500" : "bg-zinc-50 text-zinc-500"}>
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">Job</th>
                  <th scope="col" className="px-3 py-3 text-start font-medium">State</th>
                  <th scope="col" className="px-3 py-3 text-start font-medium">Attempts</th>
                  <th scope="col" className="px-3 py-3 text-start font-medium">Next attempt</th>
                  <th scope="col" className="px-3 py-3 text-start font-medium">Provider references</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">Action</th>
                </tr>
              </thead>
              <tbody className={isDark ? "divide-y divide-white/10" : "divide-y divide-zinc-200"}>
                {data.sync.recentJobs.map((job) => {
                  const retryable = job.status === "failed" || job.status === "dead_letter";
                  const busy = retryingJobId === job.jobId;
                  return (
                    <tr key={job.jobId} className={isDark ? "text-zinc-300" : "text-zinc-700"}>
                      <td className="max-w-[260px] px-5 py-4 align-top">
                        <div className="truncate font-medium mono" title={job.jobId}>{job.jobId}</div>
                        <div className={`mt-1 capitalize ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>{humanize(job.kind)}</div>
                        {job.lastError && <p className="mt-2 break-words text-rose-400">{job.lastError}</p>}
                      </td>
                      <td className="px-3 py-4 align-top">
                        <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase ${statusTone(job.status, isDark)}`}>
                          {humanize(job.status)}
                        </span>
                      </td>
                      <td className="px-3 py-4 align-top mono">{job.attempts}</td>
                      <td className="px-3 py-4 align-top">{formatTime(job.nextAttemptAt)}</td>
                      <td className="max-w-[260px] px-3 py-4 align-top">
                        {job.providerDocumentId ? (
                          <div className="truncate mono" title={job.providerDocumentId}>doc:{job.providerDocumentId}</div>
                        ) : (
                          <span className={isDark ? "text-zinc-600" : "text-zinc-400"}>No document ID</span>
                        )}
                        {job.providerMemoryIds.length > 0 && (
                          <div className="mt-1 truncate mono" title={job.providerMemoryIds.join(", ")}>
                            {job.providerMemoryIds.length} provider {job.providerMemoryIds.length === 1 ? "memory" : "memories"}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4 text-end align-top">
                        {retryable ? (
                          <button
                            type="button"
                            onClick={() => void retry(job)}
                            aria-busy={busy}
                            className={`min-h-9 rounded-xl border px-3 font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                              isDark
                                ? "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50"
                            }`}
                          >
                            {busy
                              ? "Retrying…"
                              : job.status === "dead_letter"
                                ? "Retry dead letter"
                                : "Retry job"}
                          </button>
                        ) : (
                          <span className={isDark ? "text-zinc-600" : "text-zinc-400"}>No action</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PanelPage>
  );
}
