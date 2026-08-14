import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import {
  normalizeDashboardSnapshot,
  type MemorySyncJobSummary,
} from "../lib/dashboardSnapshot.js";
import {
  EmptyState,
  HeaderPill,
  PanelPage,
  panelCardClass,
} from "./PanelPrimitives.js";

interface MemoryEventView {
  id: string;
  type: string;
  summary: string;
  detail?: string;
  at?: number;
  tone: "normal" | "success" | "warning" | "danger";
}

function eventTone(status: string): MemoryEventView["tone"] {
  if (status === "completed") return "success";
  if (status === "failed") return "warning";
  if (status === "dead_letter") return "danger";
  return "normal";
}

function eventsForJob(job: MemorySyncJobSummary): MemoryEventView[] {
  const operation = "conversation capture";
  const events: MemoryEventView[] = [
    {
      id: `${job.jobId}:state`,
      type: "memory.conversation_turn",
      summary: `${operation} · ${job.status.replace("_", " ")}`,
      detail:
        job.lastError ||
        (job.providerDocumentId ? `Provider document ${job.providerDocumentId}` : undefined),
      at: job.updatedAt ?? job.createdAt,
      tone: eventTone(job.status),
    },
  ];
  if (job.attempts > 1) {
    events.push({
      id: `${job.jobId}:retry`,
      type: "memory.retry",
      summary: `${operation} retried · attempt ${job.attempts}`,
      detail: job.lastError,
      at: job.updatedAt,
      tone: job.status === "dead_letter" ? "danger" : "warning",
    });
  }
  return events;
}

function formatTime(value: number | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Time unavailable";
}

export function EventsPanel({ isDark }: { isDark: boolean }) {
  const rawData = useQuery(api.dashboard.metrics, {}) as unknown;
  const data = rawData === undefined ? undefined : normalizeDashboardSnapshot(rawData);
  const events = useMemo(() => {
    if (!data) return [];
    const next = (data.sync?.recentJobs ?? []).flatMap(eventsForJob);
    next.push(
      ...(data.providerEvents ?? []).map((event) => ({
        id: event.eventId,
        type: `memory.provider_${event.operation}`,
        summary: `${event.operation} · ${event.outcome}`,
        detail:
          [
            event.latencyMs === undefined ? undefined : `${Math.round(event.latencyMs)} ms`,
            event.errorCode ? `Error ${event.errorCode}` : undefined,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        at: event.createdAt,
        tone: event.outcome === "success" ? "success" as const : "warning" as const,
      })),
    );
    if (data.memoryProvider?.lastWorkerActivityAt) {
      next.push({
        id: "provider:worker",
        type: "memory.provider_status",
        summary: `Provider ${data.memoryProvider.healthStatus}`,
        detail: "Latest synchronization worker activity",
        at: data.memoryProvider.lastWorkerActivityAt,
        tone:
          data.memoryProvider.healthStatus === "healthy"
            ? "success"
            : data.memoryProvider.healthStatus === "degraded"
              ? "warning"
              : "danger",
      });
    }
    return next.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  }, [data]);
  const available = Boolean(data?.sync || data?.providerEvents || data?.memoryProvider);

  return (
    <PanelPage
      eyebrow="Memory operations"
      title="Events"
      description="Durable conversation captures, provider reads, retries, failures, and worker activity."
      stat={<HeaderPill isDark={isDark}>{events.length} recent</HeaderPill>}
      maxWidth="max-w-[1040px]"
    >
      {data === undefined ? (
        <div className="space-y-2" aria-label="Loading memory events">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className={panelCardClass(isDark, "h-16 shimmer")} />
          ))}
        </div>
      ) : !available ? (
        <EmptyState isDark={isDark}>
          Memory operation data is unavailable. The dashboard will recover when Convex returns the current contract.
        </EmptyState>
      ) : events.length === 0 ? (
        <EmptyState isDark={isDark}>
          No persisted provider operations yet. Completed conversations and provider reads will appear here.
        </EmptyState>
      ) : (
        <ol className="space-y-2" aria-label="Recent memory operations">
          {events.map((event) => (
            <li key={event.id} className={panelCardClass(isDark, "px-4 py-3")}>
              <article>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      event.tone === "success"
                        ? isDark
                          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                          : "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : event.tone === "warning"
                          ? isDark
                            ? "border-amber-400/20 bg-amber-400/10 text-amber-300"
                            : "border-amber-200 bg-amber-50 text-amber-700"
                          : event.tone === "danger"
                            ? isDark
                              ? "border-rose-400/20 bg-rose-400/10 text-rose-300"
                              : "border-rose-200 bg-rose-50 text-rose-700"
                            : isDark
                              ? "border-white/10 bg-white/5 text-zinc-300"
                              : "border-zinc-200 bg-zinc-50 text-zinc-700"
                    }`}
                  >
                    {event.type}
                  </span>
                  <span className={`text-sm font-medium ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>
                    {event.summary}
                  </span>
                  <time className="ms-auto text-[11px] mono text-zinc-500">
                    {formatTime(event.at)}
                  </time>
                </div>
                {event.detail && (
                  <p className={`mt-2 break-words text-xs leading-relaxed ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>
                    {event.detail}
                  </p>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </PanelPage>
  );
}
