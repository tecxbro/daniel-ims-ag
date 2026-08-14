import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const mocks = vi.hoisted(() => ({
  dashboardValue: {} as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: (query: unknown) => {
    const name = (query as Record<symbol, string>)[Symbol.for("functionName")];
    if (name === "dashboard:metrics") return mocks.dashboardValue;
    if (name === "agents:list") return [];
    return null;
  },
}));

vi.mock("./lib/useSocket.js", () => ({
  useSocket: () => ({ connected: false }),
}));

vi.mock("./lib/memoryProfile.js", () => ({
  useMemoryProfileState: () => "unavailable",
}));

vi.mock("./components/DashboardPanel.js", () => ({
  DashboardPanel: () => <div>Dashboard panel fixture</div>,
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("App dashboard compatibility", () => {
  it("keeps the application shell usable when an older response omits memory sections", async () => {
    mocks.dashboardValue = {};
    render(<App />);

    expect(await screen.findByText("Dashboard panel fixture")).toBeTruthy();
    const summary = screen.getByLabelText("Supermemory operational summary");
    expect(within(summary).getAllByText("Unavailable")).toHaveLength(2);
    expect(within(summary).getByText("unavailable")).toBeTruthy();
    expect(screen.queryByText("Dashboard crashed")).toBeNull();
  });

  it("distinguishes a still-loading query from an unavailable response", async () => {
    mocks.dashboardValue = undefined;
    render(<App />);

    expect(await screen.findByText("Dashboard panel fixture")).toBeTruthy();
    const summary = screen.getByLabelText("Supermemory operational summary");
    expect(within(summary).getAllByText("—")).toHaveLength(2);
    expect(within(summary).getByText("unavailable")).toBeTruthy();
  });
});
