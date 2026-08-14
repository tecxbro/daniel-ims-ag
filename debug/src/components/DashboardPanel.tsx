import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { SupermemoryStatusBanner } from "./EmbeddingBanner.js";
import { PanelPage, panelCardClass } from "./PanelPrimitives.js";
import { useMemoryProfileState } from "../lib/memoryProfile.js";

interface DashboardMetrics {
  messages: number;
  memoryProvider: {
    configured: boolean;
    healthStatus: string;
    readMode: string;
    writeMode: string;
    lastSuccessfulSubmissionAt?: number;
    lastFailedSubmissionAt?: number;
    lastWorkerActivityAt?: number;
    lastError?: string;
  };
  hydration: {
    requests: number;
    failures: number;
    averageLatencyMs: number | null;
    p95UpperBoundMs: number | null;
    observedBuckets: number;
  };
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
  };
  migration: {
    pending: number;
    migrated: number;
    failed: number;
    skipped: number;
    total: number;
    reconciled: boolean;
  };
  imageAnchors: { pending: number; active: number; released: number; total: number };
  agents: { total: number; completed: number; failed: number; cancelled: number; running: number };
  cost: { total: number };
  tokens: { input: number; output: number };
  truncated: boolean;
  scanLimit: number;
}

function compact(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function time(value: number | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Not reported";
}

export function DashboardPanel({ isDark }: { isDark: boolean }) {
  const data = useQuery(api.dashboard.metrics, {}) as DashboardMetrics | undefined;
  const profileState = useMemoryProfileState();

  if (!data) {
    return <div className={`flex h-full items-center justify-center text-sm ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>Loading dashboard…</div>;
  }

  const completion =
    data.sync.captureCompletionRate === null
      ? "Unavailable"
      : `${(data.sync.captureCompletionRate * 100).toFixed(1)}%`;
  const totalTokens = data.tokens.input + data.tokens.output;

  return (
    <PanelPage
      eyebrow="Operations"
      title="Debug dashboard"
      description="Provider state, profile availability, synchronization health, and migration evidence."
      maxWidth="max-w-[1440px]"
    >
      <SupermemoryStatusBanner isDark={isDark} />

      <section aria-labelledby="provider-overview-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="provider-overview-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Memory provider</h2>
            <p className={`mt-1 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>Live state is stored in Convex; profile and document content remain provider-side.</p>
          </div>
          {data.truncated && <span className="text-xs text-amber-400">Bounded operational snapshot</span>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Provider health" value={data.memoryProvider.healthStatus} detail={data.memoryProvider.configured ? "Provider state initialized" : "No active provider state"} isDark={isDark} tone={data.memoryProvider.healthStatus === "healthy" ? "success" : "warning"} />
          <Metric label="Read / write mode" value={`${data.memoryProvider.readMode} / ${data.memoryProvider.writeMode}`} detail="Current semantic routing" isDark={isDark} />
          <Metric label="Profile state" value={profileState} detail="Live provider profile response" isDark={isDark} />
          <Metric label="Last provider success" value={time(data.memoryProvider.lastSuccessfulSubmissionAt)} detail={data.memoryProvider.lastError || "No stored provider error"} isDark={isDark} />
        </div>
      </section>

      <section aria-labelledby="sync-health-heading">
        <div className="mb-3">
          <h2 id="sync-health-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Synchronization health</h2>
          <p className={`mt-1 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>Durable outbox completion, backlog, and failure state.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Capture completion" value={completion} detail={`${data.sync.completed} completed · ${data.sync.failed} failed`} isDark={isDark} tone={data.sync.captureCompletionRate !== null && data.sync.captureCompletionRate >= 0.995 ? "success" : "normal"} />
          <Metric label="Outbox backlog" value={compact(data.sync.active)} detail={`${data.sync.pending} pending · ${data.sync.processing} processing · ${data.sync.submitted} submitted`} isDark={isDark} />
          <Metric label="Dead letters" value={compact(data.sync.deadLetter)} detail="Visible and retriable in Memory sync" isDark={isDark} tone={data.sync.deadLetter > 0 ? "danger" : "success"} />
          <Metric label="Worker activity" value={time(data.memoryProvider.lastWorkerActivityAt)} detail={`${data.sync.total} jobs in bounded snapshot`} isDark={isDark} />
        </div>
      </section>

      <section aria-labelledby="provider-telemetry-heading">
        <div className="mb-3">
          <h2 id="provider-telemetry-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Provider telemetry</h2>
          <p className={`mt-1 text-xs ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>Unavailable values are shown explicitly; the dashboard does not infer provider analytics.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Hydration requests" value={compact(data.hydration.requests)} detail={`${data.hydration.observedBuckets} bounded hourly buckets`} isDark={isDark} />
          {data.hydration.averageLatencyMs !== null && (
            <Metric label="Average hydration latency" value={`${Math.round(data.hydration.averageLatencyMs)} ms`} detail={data.hydration.p95UpperBoundMs === null ? "P95 exceeds the highest bounded bucket" : `P95 ≤ ${data.hydration.p95UpperBoundMs} ms`} isDark={isDark} />
          )}
          {data.hydration.requests > 0 && (
            <Metric label="Hydration error rate" value={`${((data.hydration.failures / data.hydration.requests) * 100).toFixed(1)}%`} detail={`${data.hydration.failures} failed requests`} isDark={isDark} tone={data.hydration.failures > 0 ? "warning" : "success"} />
          )}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className={panelCardClass(isDark, "p-5")} aria-labelledby="migration-heading">
          <h2 id="migration-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Migration reconciliation</h2>
          <div className={`mt-2 text-2xl font-semibold ${data.migration.reconciled ? "text-emerald-400" : data.migration.failed > 0 ? "text-rose-400" : isDark ? "text-zinc-100" : "text-zinc-950"}`}>
            {data.migration.total === 0 ? "Not started" : data.migration.reconciled ? "Reconciled" : "In progress"}
          </div>
          <p className={`mt-2 text-xs leading-relaxed ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>
            {data.migration.migrated} migrated · {data.migration.pending} pending · {data.migration.failed} failed · {data.migration.skipped} skipped
          </p>
        </section>
        <section className={panelCardClass(isDark, "p-5")} aria-labelledby="anchors-heading">
          <h2 id="anchors-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Image anchors</h2>
          <div className={`mt-2 text-2xl font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>{compact(data.imageAnchors.active)} active</div>
          <p className={`mt-2 text-xs leading-relaxed ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>
            {data.imageAnchors.pending} pending · {data.imageAnchors.released} released · {data.imageAnchors.total} total
          </p>
        </section>
      </div>

      <section className={panelCardClass(isDark, "grid gap-0 overflow-hidden sm:grid-cols-4")} aria-label="Application usage summary">
        <Usage label="Messages" value={compact(data.messages)} isDark={isDark} />
        <Usage label="Running agents" value={compact(data.agents.running)} isDark={isDark} />
        <Usage label="Tokens" value={compact(totalTokens)} isDark={isDark} />
        <Usage label="Estimated cost" value={`$${data.cost.total.toFixed(2)}`} isDark={isDark} />
      </section>
    </PanelPage>
  );
}

function Metric({ label, value, detail, isDark, tone = "normal" }: { label: string; value: string; detail: string; isDark: boolean; tone?: "normal" | "success" | "warning" | "danger" }) {
  const valueTone = tone === "success" ? "text-emerald-400" : tone === "warning" ? "text-amber-400" : tone === "danger" ? "text-rose-400" : isDark ? "text-zinc-100" : "text-zinc-950";
  return (
    <div className={panelCardClass(isDark, "min-w-0 p-4")}>
      <div className={`text-[11px] font-medium ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold capitalize ${valueTone}`} title={value}>{value}</div>
      <p className={`mt-2 break-words text-xs leading-relaxed ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>{detail}</p>
    </div>
  );
}

function Usage({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return <div className={`p-4 sm:border-s ${isDark ? "border-white/10" : "border-zinc-200"}`}><div className={`text-[11px] ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>{label}</div><div className={`mt-1 text-xl font-semibold mono ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{value}</div></div>;
}
