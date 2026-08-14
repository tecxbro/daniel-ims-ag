import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  AiBrain02Icon,
  ArrowShrink02Icon,
  CheckmarkCircle02Icon,
  DashboardSquare01Icon,
  InformationCircleIcon,
  MachineRobotIcon,
  WorkflowCircle03Icon,
} from "@hugeicons/core-free-icons";
import { api } from "../../../convex/_generated/api.js";
import { SegmentedControl, StatusBadge } from "./GlassPrimitives.js";
import {
  deriveDashboardMetrics,
  type DailyBucket,
  type TimeRange,
} from "../lib/dashboardMetrics.js";

type DashboardSurface = {
  page: string;
  panel: string;
  tile: string;
  label: string;
  value: string;
  sub: string;
  heading: string;
  border: string;
  divider: string;
  segment: string;
  segmentActive: string;
  segmentInactive: string;
  iconBox: string;
};

type DashboardMetrics = {
  messages: number;
  memories: {
    total: number;
    shortTerm: number;
    longTerm: number;
    permanent: number;
  };
  agents: {
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    running: number;
  };
  cost: {
    total: number;
  };
  tokens: {
    input: number;
    output: number;
  };
  dailyBuckets: DailyBucket[];
  truncated: boolean;
  scanLimit: number;
};

const RANGES: { id: TimeRange; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
];

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function plural(n: number, singular: string, pluralLabel = `${singular}s`) {
  return `${fmt(n)} ${n === 1 ? singular : pluralLabel}`;
}

export function DashboardPanel({ isDark }: { isDark: boolean }) {
  const data = useQuery(api.dashboard.metrics, {}) as DashboardMetrics | undefined;
  const [range, setRange] = useState<TimeRange>("all");

  const filtered = useMemo(() => {
    if (!data) return null;
    return deriveDashboardMetrics(data.dailyBuckets, range);
  }, [data, range]);

  if (!data || !filtered) {
    return (
      <div
        className={`flex items-center justify-center h-full ${
          isDark ? "text-slate-500" : "text-slate-400"
        }`}
      >
        Loading dashboard...
      </div>
    );
  }

  const c: DashboardSurface = {
    page: "",
    panel: "dashboard-panel",
    tile: "dashboard-panel",
    label: "dashboard-label",
    value: "dashboard-value",
    sub: "dashboard-secondary",
    heading: "dashboard-heading",
    border: "dashboard-border",
    divider: "dashboard-divider",
    segment: "",
    segmentActive: "",
    segmentInactive: "",
    iconBox: "dashboard-icon-box",
  };

  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "All time";
  const failPctNumber = filtered.agents.failureRate * 100;
  const failPct = failPctNumber.toFixed(1);
  const completionRate =
    filtered.agents.total > 0 ? filtered.agents.completed / filtered.agents.total : 0;
  return (
    <section className="dashboard-workspace" aria-label="Operations overview">
      <div className="dashboard-context-bar">
        <div>
          <span className="dashboard-context-label">Reporting window</span>
          <strong>{rangeLabel}</strong>
        </div>
        <div className="dashboard-context-controls">
          {data.truncated && (
            <StatusBadge tone="warning">Latest {fmt(data.scanLimit)} rows</StatusBadge>
          )}
          <RangePicker value={range} onChange={setRange} />
        </div>
      </div>

      <section className="dashboard-summary" aria-label="Key metrics">
        <SummaryCell label="Estimated cost" value={`$${filtered.cost.total.toFixed(2)}`} c={c} />
        <SummaryCell label="Total tokens" value={fmtTokens(filtered.tokens.total)} c={c} />
        <SummaryCell label="Active days" value={fmt(filtered.days.length)} c={c} />
        <SummaryCell label="Messages" value={fmt(data.messages)} c={c} />
        <SummaryCell label="Memories" value={fmt(data.memories.total)} c={c} />
        <SummaryCell label="Automation runs" value={fmt(filtered.automationRuns)} c={c} />
      </section>

      <div className="dashboard-primary-grid">
          <section className={`dashboard-usage overflow-hidden ${c.panel}`}>
            <PanelHeader
              icon={Activity01Icon}
              title="Usage trend"
              meta="API-equivalent LLM spend"
              c={c}
            />
            <div className="dashboard-chart-wrap">
              {filtered.days.length > 1 ? (
                <StackedAreaChart
                  data={filtered.days}
                  keys={["agentCost"]}
                  colors={isDark ? ["#38bdf8"] : ["#0284c7"]}
                  labels={["LLM usage"]}
                  format={(v) => `$${v.toFixed(2)}`}
                  isDark={isDark}
                />
              ) : (
                <EmptyTrend c={c} label="Cost trend appears after two active days." />
              )}
            </div>
          </section>

          <section className={`dashboard-health overflow-hidden ${c.panel}`}>
            <PanelHeader
              icon={MachineRobotIcon}
              title="Agent health"
              meta={`${fmt(data.agents.running)} running`}
              c={c}
            />
            <div className="dashboard-panel-body">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className={`text-[11px] font-medium uppercase ${c.label}`}>
                    Failure rate
                  </div>
                  <div
                    className={`mt-1 mono text-4xl font-semibold ${
                      failPctNumber > 20
                        ? isDark
                          ? "text-rose-400"
                          : "text-rose-600"
                        : c.value
                    }`}
                  >
                    {failPct}%
                  </div>
                </div>
                <div className={`text-right text-xs ${c.sub}`}>
                  <div>{plural(filtered.agents.total, "agent")} spawned</div>
                  <div>{fmt(data.agents.running)} running now</div>
                </div>
              </div>

              <div className={`mt-5 border-t pt-4 ${c.border}`}>
                <div className="space-y-2.5">
                  <BarRow
                    label="completed"
                    value={filtered.agents.completed}
                    total={filtered.agents.total}
                    color={isDark ? "bg-emerald-500" : "bg-emerald-600"}
                    isDark={isDark}
                    format={String}
                  />
                  <BarRow
                    label="failed"
                    value={filtered.agents.failed}
                    total={filtered.agents.total}
                    color={isDark ? "bg-rose-500" : "bg-rose-600"}
                    isDark={isDark}
                    format={String}
                  />
                  <BarRow
                    label="cancelled"
                    value={filtered.agents.cancelled}
                    total={filtered.agents.total}
                    color={isDark ? "bg-slate-500" : "bg-slate-400"}
                    isDark={isDark}
                    format={String}
                  />
                </div>
              </div>

              <div className={`mt-4 border-t pt-4 ${c.border}`}>
                <div className="flex items-center justify-between text-xs">
                  <span className={c.sub}>Completion rate</span>
                  <span className={`mono font-semibold ${c.value}`}>
                    {(completionRate * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          </section>
      </div>

      <div className="dashboard-secondary-grid">
          <section className={`overflow-hidden ${c.panel}`}>
            <PanelHeader
              icon={ArrowShrink02Icon}
              title="Token usage"
              meta={`${fmtTokens(filtered.tokens.input)} input / ${fmtTokens(
                filtered.tokens.output,
              )} output`}
              c={c}
            />
            <div className="dashboard-chart-wrap">
              {filtered.days.length > 1 ? (
                <StackedAreaChart
                  data={filtered.days}
                  keys={["inputTokens", "outputTokens"]}
                  colors={isDark ? ["#38bdf8", "#34d399"] : ["#0284c7", "#059669"]}
                  labels={["Input", "Output"]}
                  format={fmtTokens}
                  isDark={isDark}
                />
              ) : (
                <EmptyTrend c={c} label="Token trend appears after two active days." />
              )}
            </div>
          </section>

          <section className={`overflow-hidden ${c.panel}`}>
            <PanelHeader icon={AiBrain02Icon} title="Operational breakdown" meta="Current range" c={c} />
            <div className="dashboard-panel-body space-y-4">
              <div className="space-y-2.5">
                <BarRow
                  label="Input"
                  value={filtered.tokens.input}
                  total={filtered.tokens.total}
                  color={isDark ? "bg-sky-500" : "bg-sky-600"}
                  isDark={isDark}
                  format={fmtTokens}
                />
                <BarRow
                  label="Output"
                  value={filtered.tokens.output}
                  total={filtered.tokens.total}
                  color={isDark ? "bg-emerald-500" : "bg-emerald-600"}
                  isDark={isDark}
                  format={fmtTokens}
                />
              </div>

              <div className={`grid grid-cols-2 gap-3 border-t pt-4 ${c.border}`}>
                <MiniFact label="Completed" value={fmt(filtered.agents.completed)} c={c} />
                <MiniFact label="Failed" value={fmt(filtered.agents.failed)} c={c} />
                <MiniFact label="Short memory" value={fmt(data.memories.shortTerm)} c={c} />
                <MiniFact label="Long + permanent" value={fmt(data.memories.longTerm + data.memories.permanent)} c={c} />
              </div>
            </div>
          </section>
      </div>
    </section>
  );
}

function RangePicker({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
}) {
  return (
    <SegmentedControl
      lensId="dashboard-range"
      label="Dashboard reporting window"
      value={value}
      onChange={onChange}
      options={RANGES.map((range) => ({ value: range.id, label: range.label }))}
    />
  );
}

function PanelHeader({
  icon,
  title,
  meta,
  c,
}: {
  icon: any;
  title: string;
  meta: string;
  c: DashboardSurface;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 border-b px-4 py-3 ${c.border}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${c.iconBox}`}
        >
          <HugeiconsIcon icon={icon} size={17} />
        </div>
        <div className="min-w-0">
          <h3 className={`truncate text-sm font-semibold ${c.heading}`}>{title}</h3>
          <div className={`truncate text-xs ${c.sub}`}>{meta}</div>
        </div>
      </div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  c,
}: {
  label: string;
  value: string;
  c: DashboardSurface;
}) {
  return (
    <div className="px-4 py-3">
      <div className={`text-[11px] font-medium uppercase ${c.label}`}>
        {label}
      </div>
      <div className={`mt-1 mono text-2xl font-semibold ${c.value}`}>{value}</div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  sub,
  icon,
  color,
  info,
  c,
  isDark,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: any;
  color?: string;
  info?: { title: string; body: ReactNode };
  c: DashboardSurface;
  isDark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className={`relative min-h-[118px] rounded-2xl border p-4 ${c.tile}`}>
      <div className="flex items-start justify-between gap-3">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${c.iconBox}`}
        >
          <HugeiconsIcon icon={icon} size={17} />
        </div>
        {info && (
          <div className="relative" ref={popRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={`What does ${label} mean?`}
              aria-expanded={open}
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                isDark
                  ? "border-slate-700 text-slate-500 hover:border-sky-400 hover:text-sky-400"
                  : "border-slate-300 text-slate-500 hover:border-sky-500 hover:text-sky-600"
              }`}
            >
              <HugeiconsIcon icon={InformationCircleIcon} size={13} />
            </button>
            {open && (
              <div
                role="dialog"
                aria-label={info.title}
                className={`pop-in absolute right-0 z-30 mt-1.5 w-64 rounded-2xl border px-3 py-2.5 text-[11px] leading-snug shadow-lg ${
                  isDark
                    ? "border-slate-700 bg-slate-900 text-slate-200"
                    : "border-slate-200 bg-white text-slate-700"
                }`}
              >
                <div className={`mb-1 font-semibold ${isDark ? "text-slate-100" : "text-slate-900"}`}>
                  {info.title}
                </div>
                <div className="font-normal">{info.body}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className={`mt-4 text-[11px] font-medium uppercase ${c.label}`}>
        {label}
      </div>
      <div className={`mt-1 mono text-2xl font-semibold ${color ?? c.value}`}>{value}</div>
      {sub && <div className={`mt-1 truncate text-xs ${c.sub}`}>{sub}</div>}
    </div>
  );
}

function MiniFact({ label, value, c }: { label: string; value: string; c: DashboardSurface }) {
  return (
    <div>
      <div className={`text-[11px] font-medium uppercase ${c.label}`}>
        {label}
      </div>
      <div className={`mt-1 mono text-lg font-semibold ${c.value}`}>{value}</div>
    </div>
  );
}

function EmptyTrend({ label, c }: { label: string; c: DashboardSurface }) {
  return (
    <div className={`flex h-[220px] items-center justify-center text-xs ${c.sub}`}>
      {label}
    </div>
  );
}

function BarRow({
  label,
  value,
  total,
  color,
  isDark,
  format,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  isDark: boolean;
  format?: (v: number) => string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const display = format ? format(value) : `$${value.toFixed(2)}`;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`w-24 truncate capitalize ${
          isDark ? "text-slate-400" : "text-slate-600"
        }`}
      >
        {label}
      </span>
      <div
        className={`flex-1 h-2 rounded-full overflow-hidden ${
          isDark ? "bg-slate-800" : "bg-slate-100"
        }`}
      >
        <div
          className={`metric-bar-fill h-full rounded-full ${color}`}
          style={{ width: value > 0 ? `${Math.max(pct, 1)}%` : "0%" }}
        />
      </div>
      <span
        className={`w-16 text-right mono font-medium ${
          isDark ? "text-slate-300" : "text-slate-700"
        }`}
      >
        {display}
      </span>
    </div>
  );
}

function StackedAreaChart({
  data,
  keys,
  colors,
  labels,
  format,
  isDark,
}: {
  data: Record<string, any>[];
  keys: string[];
  colors: string[];
  labels: string[];
  format: (v: number) => string;
  isDark: boolean;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (data.length < 2) return null;

  const W = 800;
  const H = 180;
  const PL = 55;
  const PR = 16;
  const PT = 8;
  const PB = 28;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;

  const stacked = data.map((d) => {
    let cum = 0;
    const layers: number[] = [];
    const raw: number[] = [];
    for (const k of keys) {
      const v = d[k] ?? 0;
      raw.push(v);
      cum += v;
      layers.push(cum);
    }
    return { day: d.day as string, layers, raw, total: cum };
  });

  const maxVal = Math.max(...stacked.map((d) => d.total), 0.01);
  const x = (i: number) => PL + (i / (data.length - 1)) * chartW;
  const y = (v: number) => PT + chartH - (v / maxVal) * chartH;
  const yTicks = [0, maxVal * 0.5, maxVal];

  const areaPaths: string[] = [];
  for (let k = keys.length - 1; k >= 0; k--) {
    const topPoints = stacked.map((d, i) => `${x(i)},${y(d.layers[k])}`).join(" L");
    const bottomLayer =
      k > 0
        ? stacked
            .map((d, i) => `${x(i)},${y(d.layers[k - 1])}`)
            .reverse()
            .join(" L")
        : stacked
            .map((_, i) => `${x(i)},${y(0)}`)
            .reverse()
            .join(" L");
    areaPaths.push(`M${topPoints} L${bottomLayer} Z`);
  }

  const step = Math.max(1, Math.floor(data.length / 6));
  const xLabels: { i: number; label: string }[] = [];
  for (let i = 0; i < data.length; i += step)
    xLabels.push({ i, label: (data[i].day as string).slice(5) });
  if (xLabels[xLabels.length - 1]?.i !== data.length - 1) {
    xLabels.push({
      i: data.length - 1,
      label: (data[data.length - 1].day as string).slice(5),
    });
  }

  const gridColor = isDark ? "#1e293b" : "#e2e8f0";
  const textColor = isDark ? "#64748b" : "#94a3b8";
  const crosshair = isDark ? "#475569" : "#cbd5e1";

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = ((e.clientX - rect.left) / rect.width) * W;
      const chartX = mouseX - PL;
      if (chartX < 0 || chartX > chartW) {
        setHoverIdx(null);
        return;
      }
      const idx = Math.round((chartX / chartW) * (data.length - 1));
      setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
    },
    [data.length, chartW],
  );

  const hovered = hoverIdx !== null ? stacked[hoverIdx] : null;
  const tooltipLeft = hoverIdx !== null ? (x(hoverIdx) / W) * 100 : 0;
  const flipTooltip = hoverIdx !== null && tooltipLeft > 65;

  const accessibleSummary = `${labels.join(" and ")} from ${stacked[0].day} through ${stacked[stacked.length - 1].day}. Peak total ${format(maxVal)}.`;

  return (
    <figure ref={containerRef} className="relative">
      <figcaption className="sr-only">{accessibleSummary}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label={accessibleSummary}
        tabIndex={0}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        onFocus={() => setHoverIdx((index) => index ?? stacked.length - 1)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          setHoverIdx((index) => {
            const current = index ?? 0;
            return Math.max(0, Math.min(stacked.length - 1, current + direction));
          });
        }}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke={gridColor} strokeWidth={1} />
            <text
              x={PL - 6}
              y={y(v) + 3.5}
              textAnchor="end"
              fill={textColor}
              fontSize={10}
              fontFamily="'SF Mono', ui-monospace, Menlo, monospace"
            >
              {format(v)}
            </text>
          </g>
        ))}

        {areaPaths.map((path, i) => (
          <path key={i} d={path} fill={colors[i]} opacity={0.35} />
        ))}

        {keys.map((_, k) => {
          const linePoints = stacked
            .map((d, i) => `${x(i)},${y(d.layers[k])}`)
            .join(" L");
          return (
            <path
              key={k}
              d={`M${linePoints}`}
              fill="none"
              stroke={colors[k]}
              strokeWidth={1.5}
            />
          );
        })}

        {xLabels.map(({ i, label }) => (
          <text
            key={i}
            x={x(i)}
            y={H - 4}
            textAnchor="middle"
            fill={textColor}
            fontSize={10}
            fontFamily="'SF Mono', ui-monospace, Menlo, monospace"
          >
            {label}
          </text>
        ))}

        {hoverIdx !== null && hovered && (
          <>
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={PT}
              y2={PT + chartH}
              stroke={crosshair}
              strokeWidth={1}
              strokeDasharray="3,3"
            />
            {keys.map((_, k) => (
              <circle
                key={k}
                cx={x(hoverIdx)}
                cy={y(hovered.layers[k])}
                r={3.5}
                fill={colors[k]}
                stroke={isDark ? "#0f172a" : "#ffffff"}
                strokeWidth={1.5}
              />
            ))}
          </>
        )}
      </svg>

      {hoverIdx !== null && hovered && (
        <div
          className={`absolute pointer-events-none rounded-2xl border px-3 py-2 shadow-lg text-xs z-10 ${
            isDark
              ? "bg-slate-800 border-slate-700 text-slate-200"
              : "bg-white border-slate-200 text-slate-800"
          }`}
          style={{
            top: 4,
            left: flipTooltip ? undefined : `calc(${tooltipLeft}% + 12px)`,
            right: flipTooltip ? `calc(${100 - tooltipLeft}% + 12px)` : undefined,
          }}
        >
          <div
            className={`font-semibold mb-1.5 ${
              isDark ? "text-slate-300" : "text-slate-700"
            }`}
          >
            {hovered.day}
          </div>
          {keys.map((_, k) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: colors[k] }}
              />
              <span className={isDark ? "text-slate-400" : "text-slate-500"}>
                {labels[k]}
              </span>
              <span className="ml-auto mono font-medium pl-3">
                {format(hovered.raw[k])}
              </span>
            </div>
          ))}
          <div
            className={`border-t mt-1.5 pt-1.5 flex justify-between font-semibold ${
              isDark ? "border-slate-700" : "border-slate-200"
            }`}
          >
            <span>Total</span>
            <span className="mono">{format(hovered.total)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 mt-2 ml-14">
        {labels.map((l, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: colors[i] }}
            />
            <span className={isDark ? "text-slate-400" : "text-slate-600"}>
              {l}
            </span>
          </div>
        ))}
      </div>
      <details className="chart-data">
        <summary>View data table</summary>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th scope="col">Day</th>
                {labels.map((label) => (
                  <th key={label} scope="col">{label}</th>
                ))}
                {labels.length > 1 && <th scope="col">Total</th>}
              </tr>
            </thead>
            <tbody>
              {stacked.map((point) => (
                <tr key={point.day}>
                  <th scope="row">{point.day}</th>
                  {point.raw.map((value, index) => (
                    <td key={`${point.day}-${labels[index]}`}>{format(value)}</td>
                  ))}
                  {labels.length > 1 && <td>{format(point.total)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
