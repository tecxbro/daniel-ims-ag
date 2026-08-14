import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { normalizeDashboardSnapshot } from "../lib/dashboardSnapshot.js";
import { useMemoryProfileState } from "../lib/memoryProfile.js";
import { SupermemoryStatusBanner } from "./SupermemoryStatusBanner.js";
import { PanelPage, panelCardClass } from "./PanelPrimitives.js";

function compact(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Unavailable"
    : new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
}

function time(value: number | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Not reported";
}

export function DashboardPanel({ isDark }: { isDark: boolean }) {
  const rawData = useQuery(api.dashboard.metrics, {}) as unknown;
  const data = rawData === undefined ? undefined : normalizeDashboardSnapshot(rawData);
  const profileState = useMemoryProfileState();

  if (data === undefined) {
    return <div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading dashboard…</div>;
  }

  const provider = data.memoryProvider;
  const sync = data.sync;
  const hydration = data.hydration;
  const anchors = data.imageAnchors;
  const completion =
    !sync || sync.captureCompletionRate === null
      ? "Unavailable"
      : `${(sync.captureCompletionRate * 100).toFixed(1)}%`;
  const totalTokens = data.tokens
    ? data.tokens.input + data.tokens.output
    : null;
  const providerHealth = provider?.healthStatus ?? "Unavailable";
  const providerTone =
    provider?.healthStatus === "healthy"
      ? "success"
      : provider?.healthStatus === "degraded" ||
          provider?.healthStatus === "unconfigured" ||
          provider?.healthStatus === "recovery_required"
        ? "warning"
        : "danger";

  return (
    <PanelPage
      eyebrow="Operations"
      title="Debug dashboard"
      description="Provider state, profile availability, synchronization health, and application usage."
      maxWidth="max-w-[1440px]"
    >
      <SupermemoryStatusBanner isDark={isDark} />

      <section aria-labelledby="provider-overview-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="provider-overview-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Memory provider</h2>
            <p className="mt-1 text-xs text-zinc-500">Live operational state is stored in Convex; profile and document content remain provider-side.</p>
          </div>
          {data.truncated && <span className="text-xs text-amber-400">Bounded operational snapshot</span>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Provider health"
            value={providerHealth}
            detail={provider ? "Current provider state" : "Provider state unavailable"}
            isDark={isDark}
            tone={providerTone}
          />
          <Metric
            label="Configuration"
            value={provider ? (provider.configured ? "Configured" : "Unconfigured") : "Unavailable"}
            detail="Supermemory connection state"
            isDark={isDark}
          />
          <Metric label="Profile state" value={profileState} detail="Live provider profile response" isDark={isDark} />
          <Metric
            label="Last provider success"
            value={provider ? time(provider.lastSuccessfulSubmissionAt) : "Unavailable"}
            detail={provider?.hasError ? "Provider reported a recent error" : "No stored provider error"}
            isDark={isDark}
          />
        </div>
      </section>

      <section aria-labelledby="sync-health-heading">
        <div className="mb-3">
          <h2 id="sync-health-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Synchronization health</h2>
          <p className="mt-1 text-xs text-zinc-500">Durable conversation capture, backlog, and failure state.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Capture completion"
            value={completion}
            detail={sync ? `${sync.completed} completed · ${sync.failed} failed` : "Synchronization data unavailable"}
            isDark={isDark}
            tone={sync?.captureCompletionRate !== null && sync?.captureCompletionRate !== undefined && sync.captureCompletionRate >= 0.995 ? "success" : "normal"}
          />
          <Metric
            label="Outbox backlog"
            value={compact(sync?.active)}
            detail={sync ? `${sync.pending} pending · ${sync.processing} processing · ${sync.submitted} submitted` : "Synchronization data unavailable"}
            isDark={isDark}
          />
          <Metric
            label="Dead letters"
            value={compact(sync?.deadLetter)}
            detail={sync ? "Visible and retriable in Memory sync" : "Synchronization data unavailable"}
            isDark={isDark}
            tone={!sync ? "normal" : sync.deadLetter > 0 ? "danger" : "success"}
          />
          <Metric
            label="Worker activity"
            value={provider ? time(provider.lastWorkerActivityAt) : "Unavailable"}
            detail={sync ? `${sync.total} jobs in bounded snapshot` : "Synchronization data unavailable"}
            isDark={isDark}
          />
        </div>
      </section>

      <section aria-labelledby="provider-telemetry-heading">
        <div className="mb-3">
          <h2 id="provider-telemetry-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Provider telemetry</h2>
          <p className="mt-1 text-xs text-zinc-500">Unavailable values are shown explicitly; the dashboard does not infer provider analytics.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Hydration requests"
            value={compact(hydration?.requests)}
            detail={hydration ? `${hydration.observedBuckets} bounded hourly buckets` : "Provider telemetry unavailable"}
            isDark={isDark}
          />
          {hydration?.averageLatencyMs !== null && hydration?.averageLatencyMs !== undefined && (
            <Metric
              label="Average hydration latency"
              value={`${Math.round(hydration.averageLatencyMs)} ms`}
              detail={hydration.p95UpperBoundMs === null ? "P95 exceeds the highest bounded bucket" : `P95 ≤ ${hydration.p95UpperBoundMs} ms`}
              isDark={isDark}
            />
          )}
          {hydration && hydration.requests > 0 && (
            <Metric
              label="Hydration error rate"
              value={`${((hydration.failures / hydration.requests) * 100).toFixed(1)}%`}
              detail={`${hydration.failures} failed requests`}
              isDark={isDark}
              tone={hydration.failures > 0 ? "warning" : "success"}
            />
          )}
        </div>
      </section>

      <section className={panelCardClass(isDark, "p-5")} aria-labelledby="anchors-heading">
        <h2 id="anchors-heading" className={`text-sm font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>Image anchors</h2>
        <div className={`mt-2 text-2xl font-semibold ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>
          {anchors ? `${compact(anchors.active)} active` : "Unavailable"}
        </div>
        <p className={`mt-2 text-xs leading-relaxed ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>
          {anchors
            ? `${anchors.pending} pending · ${anchors.released} released · ${anchors.total} total`
            : "Image anchor state is unavailable."}
        </p>
      </section>

      <section className={panelCardClass(isDark, "grid gap-0 overflow-hidden sm:grid-cols-4")} aria-label="Application usage summary">
        <Usage label="Messages" value={compact(data.messages)} isDark={isDark} />
        <Usage label="Running agents" value={compact(data.agents?.running)} isDark={isDark} />
        <Usage label="Tokens" value={compact(totalTokens)} isDark={isDark} />
        <Usage label="Estimated cost" value={data.cost ? `$${data.cost.total.toFixed(2)}` : "Unavailable"} isDark={isDark} />
      </section>
    </PanelPage>
  );
}

function Metric({
  label,
  value,
  detail,
  isDark,
  tone = "normal",
}: {
  label: string;
  value: string;
  detail: string;
  isDark: boolean;
  tone?: "normal" | "success" | "warning" | "danger";
}) {
  const valueTone =
    tone === "success"
      ? "text-emerald-400"
      : tone === "warning"
        ? "text-amber-400"
        : tone === "danger"
          ? "text-rose-400"
          : isDark
            ? "text-zinc-100"
            : "text-zinc-950";
  return (
    <div className={panelCardClass(isDark, "min-w-0 p-4")}>
      <div className="text-[11px] font-medium text-zinc-500">{label}</div>
      <div className={`mt-1 truncate text-lg font-semibold capitalize ${valueTone}`} title={value}>{value}</div>
      <p className={`mt-2 break-words text-xs leading-relaxed ${isDark ? "text-zinc-400" : "text-zinc-600"}`}>{detail}</p>
    </div>
  );
}

function Usage({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <div className={`p-4 sm:border-s ${isDark ? "border-white/10" : "border-zinc-200"}`}>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold mono ${isDark ? "text-zinc-200" : "text-zinc-800"}`}>{value}</div>
    </div>
  );
}
