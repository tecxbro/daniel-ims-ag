import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPanel } from "./DashboardPanel.js";
import { EventsPanel } from "./EventsPanel.js";
import { MemorySyncPanel } from "./MemorySyncPanel.js";
import { SupermemoryStatusBanner } from "./SupermemoryStatusBanner.js";

const mocks = vi.hoisted(() => ({
  queryValue: undefined as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: () => mocks.queryValue,
}));

vi.mock("../lib/memoryProfile.js", () => ({
  useMemoryProfileState: () => "unavailable",
}));

vi.mock("../lib/useSocket.js", () => ({
  useSocket: () => ({ connected: false }),
}));

function emptyOperationalSnapshot() {
  return {
    messages: 0,
    memoryProvider: {
      configured: false,
      healthStatus: "unconfigured",
      hasError: false,
    },
    hydration: {
      requests: 0,
      failures: 0,
      averageLatencyMs: null,
      p95UpperBoundMs: null,
      observedBuckets: 0,
    },
    sync: {
      pending: 0,
      processing: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      active: 0,
      total: 0,
      captureCompletionRate: null,
      recentJobs: [],
    },
    providerEvents: [],
    imageAnchors: { pending: 0, active: 0, released: 0, total: 0 },
    agents: { total: 0, completed: 0, failed: 0, cancelled: 0, running: 0 },
    cost: { total: 0 },
    tokens: { input: 0, output: 0 },
    truncated: false,
  };
}

beforeEach(() => {
  mocks.queryValue = undefined;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    configured: false,
    health: { status: "unconfigured" },
    backlog: {
      pending: 0,
      processing: 0,
      submitted: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      active: 0,
      total: 0,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("operational dashboard panels", () => {
  it("renders loading only while the Convex query is undefined", () => {
    render(<DashboardPanel isDark={false} />);
    expect(screen.getByText("Loading dashboard…")).toBeTruthy();
  });

  it("renders unavailable states instead of crashing on an old partial response", () => {
    mocks.queryValue = {};
    render(<DashboardPanel isDark={false} />);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText("Provider state unavailable")).toBeTruthy();
    expect(screen.getAllByText("Synchronization data unavailable")).toHaveLength(4);
  });

  it("treats explicit zero counts and empty operation arrays as successful states", () => {
    mocks.queryValue = emptyOperationalSnapshot();
    const events = render(<EventsPanel isDark={false} />);
    expect(screen.getByText(/No persisted provider operations yet/)).toBeTruthy();
    events.unmount();

    render(<MemorySyncPanel isDark={false} />);
    expect(screen.getByText(/No synchronization jobs yet/)).toBeTruthy();
    expect(screen.getByText("0 active")).toBeTruthy();
  });

  it("renders unavailable operation panels for missing sync and event sections", () => {
    mocks.queryValue = {};
    const events = render(<EventsPanel isDark />);
    expect(screen.getByText(/Memory operation data is unavailable/)).toBeTruthy();
    events.unmount();

    render(<MemorySyncPanel isDark />);
    expect(screen.getByText(/Synchronization data is unavailable/)).toBeTruthy();
  });
});

describe("Supermemory provider banner", () => {
  it("renders a truthful unconfigured state without routing-mode copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      configured: false,
      health: { status: "unconfigured" },
      backlog: {
        pending: 0,
        processing: 0,
        submitted: 0,
        completed: 0,
        failed: 0,
        deadLetter: 0,
        active: 0,
        total: 0,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    render(<SupermemoryStatusBanner isDark={false} />);
    expect(await screen.findByText(/Not configured · unconfigured/i)).toBeTruthy();
    expect(screen.getByText("0 active · 0 failed · 0 dead letters")).toBeTruthy();
    expect(screen.queryByText(/read|write/i)).toBeNull();
  });
});
