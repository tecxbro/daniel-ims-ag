import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkCircle02Icon,
  CommandIcon,
  ComputerIcon,
  Moon02Icon,
  SidebarLeftIcon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { api } from "../../convex/_generated/api.js";
import { useSocket } from "./lib/useSocket.js";
import { DashboardPanel } from "./components/DashboardPanel.js";
import { ChangelogDrawer } from "./components/ChangelogDrawer.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { GlassButton, GlassSurface, ToolbarButton } from "./components/GlassPrimitives.js";
import { RuntimeProviderLogo, type RuntimeProvider } from "./lib/branding.js";
import {
  VIEW_DEFINITIONS,
  VIEW_GROUPS,
  viewFromLocation,
  viewUrl,
  type ViewId,
} from "./lib/navigation.js";
import {
  THEME_STORAGE_KEY,
  applyTheme,
  readStoredTheme,
  resolveTheme,
  type ThemeMode,
} from "./lib/theme.js";
import { useLiquidSelectionAnchor } from "./lib/liquidSelection.js";
import { useMemoryProfileState } from "./lib/memoryProfile.js";
import { normalizeDashboardSnapshot } from "./lib/dashboardSnapshot.js";
import metadata from "../../project-metadata.json";

const AgentsPanel = lazy(() =>
  import("./components/AgentsPanel.js").then((module) => ({ default: module.AgentsPanel })),
);
const AutomationsPanel = lazy(() =>
  import("./components/AutomationsPanel.js").then((module) => ({
    default: module.AutomationsPanel,
  })),
);
const MemoryPanel = lazy(() =>
  import("./components/MemoryPanel.js").then((module) => ({ default: module.MemoryPanel })),
);
const EventsPanel = lazy(() =>
  import("./components/EventsPanel.js").then((module) => ({ default: module.EventsPanel })),
);
const ConnectionsPanel = lazy(() =>
  import("./components/ConnectionsPanel.js").then((module) => ({
    default: module.ConnectionsPanel,
  })),
);
const MemorySyncPanel = lazy(() =>
  import("./components/MemorySyncPanel.js").then((module) => ({
    default: module.MemorySyncPanel,
  })),
);
const SettingsPanel = lazy(() =>
  import("./components/SettingsPanel.js").then((module) => ({ default: module.SettingsPanel })),
);

interface RuntimeConfigSnapshot {
  runtime: RuntimeProvider;
  model: string;
}

interface AgentSummary {
  status: string;
}

const VIEW_SHORTCUTS: Record<string, ViewId> = {
  "1": "dashboard",
  "2": "agents",
  "3": "automations",
  "4": "memory",
  "5": "events",
  "6": "sync",
  "7": "connections",
  "8": "settings",
};

const SIDEBAR_STORAGE_KEY = "daniel-debug-sidebar-collapsed";

function readSidebarPreference() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function App() {
  const [view, setView] = useState<ViewId>(() => viewFromLocation(window.location));
  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredTheme);
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarPreference);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigSnapshot | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const navigationItemRefs = useRef(new Map<ViewId, HTMLButtonElement>());
  const { connected } = useSocket();
  const memoryProfileState = useMemoryProfileState();

  const rawMemorySummary = useQuery(api.dashboard.metrics, {}) as unknown;
  const memorySummary =
    rawMemorySummary === undefined
      ? undefined
      : normalizeDashboardSnapshot(rawMemorySummary);
  const agents = useQuery(api.agents.list, {}) as AgentSummary[] | undefined;
  const storedRuntime = useQuery(api.settings.get, { key: "runtime" }) as
    | string
    | null
    | undefined;
  const storedClaudeModel = useQuery(api.settings.get, { key: "model" }) as
    | string
    | null
    | undefined;
  const storedHostedModel = useQuery(api.settings.get, { key: "codex_model" }) as
    | string
    | null
    | undefined;

  const activeAgentCount = (agents ?? []).filter(
    (agent) => agent.status === "running" || agent.status === "spawned",
  ).length;
  const resolvedTheme = resolveTheme(themeMode, systemDark);
  const isDark = resolvedTheme === "dark";
  const currentView =
    VIEW_DEFINITIONS.find((definition) => definition.id === view) ?? VIEW_DEFINITIONS[0];
  const getActiveNavigationElement = useCallback(
    () => navigationItemRefs.current.get(view) ?? null,
    [view],
  );
  useLiquidSelectionAnchor({
    id: "sidebar-navigation",
    kind: "navigation",
    selectionKey: view,
    layoutKey: `${sidebarCollapsed}:${mobileNavOpen}`,
    getElement: getActiveNavigationElement,
  });

  const storedProvider: RuntimeProvider | null =
    storedRuntime === "claude" || storedRuntime === "codex" ? storedRuntime : null;
  const activeRuntime = runtimeConfig?.runtime ?? storedProvider ?? "claude";
  const providerLabel = activeRuntime === "codex" ? "Codex" : "Claude";
  const modelLabel =
    runtimeConfig?.model ??
    (activeRuntime === "codex" ? storedHostedModel : storedClaudeModel) ??
    "Model unavailable";

  const navigate = useCallback((nextView: ViewId, replace = false) => {
    setView(nextView);
    setMobileNavOpen(false);
    const url = viewUrl(nextView, window.location);
    if (replace) window.history.replaceState({ view: nextView }, "", url);
    else window.history.pushState({ view: nextView }, "", url);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(max-width: 799px)").matches) {
      setMobileNavOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(preference.matches);
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    applyTheme(themeMode, resolvedTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Theme still applies for this session.
    }
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    const onPopState = () => setView(viewFromLocation(window.location));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
        setThemeMenuOpen(false);
        return;
      }
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (VIEW_SHORTCUTS[key]) {
        event.preventDefault();
        navigate(VIEW_SHORTCUTS[key]);
      } else if (key === ",") {
        event.preventDefault();
        navigate("settings");
      } else if (key === "b" && !isEditableTarget(event.target)) {
        event.preventDefault();
        toggleSidebar();
      } else if (key === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, toggleSidebar]);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(event.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [themeMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/runtime-config")
      .then((response) => {
        if (!response.ok) throw new Error(`Runtime config fetch failed (${response.status})`);
        return response.json() as Promise<RuntimeConfigSnapshot>;
      })
      .then((config) => {
        if (!cancelled) setRuntimeConfig(config);
      })
      .catch(() => {
        if (!cancelled) setRuntimeConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [storedRuntime, storedClaudeModel, storedHostedModel]);

  const themeIcon = useMemo(
    () => (themeMode === "system" ? ComputerIcon : themeMode === "dark" ? Moon02Icon : Sun03Icon),
    [themeMode],
  );

  return (
    <div
      className="app-shell"
      data-view={view}
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      data-mobile-nav-open={mobileNavOpen ? "true" : "false"}
    >
      <span className="liquid-refresh-sentinel" data-liquid-refresh-sentinel aria-hidden="true" />

      <a href="#main-content" className="skip-link">
        Skip to dashboard content
      </a>

      {mobileNavOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <nav className="app-sidebar" aria-label="Dashboard views">
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            D
          </div>
          <div className="sidebar-copy">
            <h1>Daniel</h1>
            <div className={connected ? "connection-copy is-connected" : "connection-copy is-offline"}>
              <span className="status-dot" aria-hidden="true" />
              {connected ? "Connection healthy" : "Disconnected"}
            </div>
          </div>
        </div>

        <div className="source-list" data-liquid-ignore="">
          {VIEW_GROUPS.map((group) => (
            <section key={group} className="source-section" aria-labelledby={`nav-${group}`}>
              <h2 id={`nav-${group}`}>{group}</h2>
              <div className="source-items">
                {VIEW_DEFINITIONS.filter((definition) => definition.group === group).map(
                  (definition) => {
                    const active = definition.id === view;
                    const count = definition.id === "agents" ? activeAgentCount : 0;
                    return (
                      <button
                        key={definition.id}
                        ref={(element) => {
                          if (element) navigationItemRefs.current.set(definition.id, element);
                          else navigationItemRefs.current.delete(definition.id);
                        }}
                        type="button"
                        className="source-item"
                        data-active={active ? "true" : "false"}
                        aria-current={active ? "page" : undefined}
                        aria-label={`${definition.label}, ${definition.shortcut}`}
                        title={`${definition.label} (${definition.shortcut})`}
                        onClick={() => navigate(definition.id)}
                      >
                        <span className="source-item-content">
                          <HugeiconsIcon icon={definition.icon} size={16} aria-hidden="true" />
                          <span className="source-label">{definition.label}</span>
                          {count > 0 && <span className="source-badge">{count}</span>}
                        </span>
                      </button>
                    );
                  },
                )}
              </div>
            </section>
          ))}
        </div>

        <GlassSurface className="sidebar-summary">
          <div className="sidebar-summary-heading">
            <span>Supermemory</span>
            <button type="button" onClick={() => navigate("memory")}>
              Open
            </button>
          </div>
          <div className="memory-counts" aria-label="Supermemory operational summary">
            <MetricPill
              label="Provider"
              value={
                memorySummary === undefined
                  ? "—"
                  : memorySummary.memoryProvider?.healthStatus ?? "Unavailable"
              }
              tone={memorySummary?.memoryProvider?.healthStatus === "healthy" ? "success" : "warm"}
            />
            <MetricPill label="Profile" value={memoryProfileState} />
            <MetricPill
              label="Backlog"
              value={
                memorySummary === undefined
                  ? undefined
                  : memorySummary.sync?.active ?? "Unavailable"
              }
              tone={(memorySummary?.sync?.failed ?? 0) + (memorySummary?.sync?.deadLetter ?? 0) > 0 ? "danger" : undefined}
            />
          </div>
          <button type="button" className="version-button" onClick={() => setChangelogOpen(true)}>
            Daniel {metadata.version}
          </button>
        </GlassSurface>
      </nav>

      <div className="app-workspace">
        <header className="app-toolbar">
          <div className="toolbar-leading">
            <ToolbarButton onClick={toggleSidebar} aria-label="Toggle sidebar" title="Toggle sidebar (⌘B)">
              <HugeiconsIcon icon={SidebarLeftIcon} size={17} aria-hidden="true" />
            </ToolbarButton>
            <div className="page-identity">
              <span>{currentView.group}</span>
              <div>
                <h2>{currentView.label}</h2>
                <p>{currentView.description}</p>
              </div>
            </div>
          </div>

          <div className="toolbar-trailing">
            <GlassButton
              refractive
              className="connection-control"
              aria-live="polite"
              title={connected ? "The local dashboard connection is healthy" : "The local dashboard is disconnected"}
            >
              <span className={connected ? "status-dot" : "status-dot is-offline"} aria-hidden="true" />
              <span>{connected ? "Live" : "Offline"}</span>
            </GlassButton>

            <GlassButton
              refractive
              className="runtime-control"
              title={`Active model: ${providerLabel} ${modelLabel}`}
              onClick={() => navigate("settings")}
            >
              <RuntimeProviderLogo runtime={activeRuntime} size={17} className="shrink-0" />
              <span className="runtime-provider">{providerLabel}</span>
              <span className="runtime-model">{modelLabel}</span>
            </GlassButton>

            <ToolbarButton
              onClick={() => setCommandOpen(true)}
              aria-label="Open command menu"
              title="Command menu (⌘K)"
            >
              <HugeiconsIcon icon={CommandIcon} size={17} aria-hidden="true" />
            </ToolbarButton>

            <div className="theme-control-wrap" ref={themeMenuRef}>
              <ToolbarButton
                onClick={() => setThemeMenuOpen((open) => !open)}
                aria-label={`Appearance: ${themeMode}`}
                aria-expanded={themeMenuOpen}
                title="Appearance"
              >
                <HugeiconsIcon icon={themeIcon} size={17} aria-hidden="true" />
              </ToolbarButton>
              {themeMenuOpen && (
                <div className="theme-menu glass-popover" role="menu" aria-label="Appearance">
                  {(
                    [
                      ["system", ComputerIcon, "System"],
                      ["light", Sun03Icon, "Light"],
                      ["dark", Moon02Icon, "Dark"],
                    ] as const
                  ).map(([mode, icon, label]) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={themeMode === mode}
                      onClick={() => {
                        setThemeMode(mode);
                        setThemeMenuOpen(false);
                      }}
                    >
                      <HugeiconsIcon icon={icon} size={16} aria-hidden="true" />
                      <span>{label}</span>
                      {themeMode === mode && (
                        <HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} aria-hidden="true" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </header>

        <main id="main-content" className="app-main" tabIndex={-1}>
          <div key={view} className="view-scroll debug-scroll view-shell">
            <Suspense fallback={<ViewLoading label={currentView.label} />}>
              {view === "dashboard" && <DashboardPanel isDark={isDark} />}
              {view === "agents" && <AgentsPanel isDark={isDark} />}
              {view === "automations" && <AutomationsPanel isDark={isDark} />}
              {view === "memory" && <MemoryPanel isDark={isDark} />}
              {view === "events" && <EventsPanel isDark={isDark} />}
              {view === "sync" && (
                <section aria-label="Memory sync" className="contents">
                  <MemorySyncPanel isDark={isDark} />
                </section>
              )}
              {view === "connections" && <ConnectionsPanel isDark={isDark} />}
              {view === "settings" && <SettingsPanel isDark={isDark} />}
            </Suspense>
          </div>
        </main>

        <ChangelogDrawer
          open={changelogOpen}
          onClose={() => setChangelogOpen(false)}
          isDark={isDark}
        />
      </div>

      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} onNavigate={navigate} />
    </div>
  );
}

function MetricPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string | undefined;
  tone?: "warm" | "success" | "danger";
}) {
  return (
    <div className="memory-count">
      <span>{label}</span>
      <strong className={tone ? `is-${tone}` : undefined}>{value ?? "—"}</strong>
    </div>
  );
}

function ViewLoading({ label }: { label: string }) {
  return (
    <div className="view-loading" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      Loading {label.toLowerCase()}…
    </div>
  );
}
