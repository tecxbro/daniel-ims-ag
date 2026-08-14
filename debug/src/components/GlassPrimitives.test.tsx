// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  LiquidGlassProvider,
  MAX_REAL_LENSES,
  SEGMENT_LENS_SLOTS,
} from "./LiquidGlassProvider.js";
import { GlassButton, Popover, SegmentedControl } from "./GlassPrimitives.js";
import { LiquidSelectionContext } from "../lib/liquidSelection.js";

const mocks = vi.hoisted(() => ({ initialize: vi.fn(), registerDynamic: vi.fn() }));

vi.mock("liquid-gl", () => ({
  default: Object.assign(mocks.initialize, { registerDynamic: mocks.registerDynamic }),
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
});

describe("glass primitives", () => {
  it("uses the interactive control itself as the liquidGL lens", () => {
    render(<GlassButton refractive>Run action</GlassButton>);
    const button = screen.getByRole("button", { name: "Run action" });
    expect(button.classList.contains("liquid-gl-target")).toBe(true);
    expect(button.hasAttribute("data-liquid-ignore")).toBe(true);
    expect(button.querySelectorAll(".liquid-gl-target")).toHaveLength(0);
  });

  it("supports arrow-key segmented navigation", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SegmentedControl
        lensId="test-range"
        label="Range"
        value="7d"
        onChange={onChange}
        options={[
          { value: "7d", label: "7 days" },
          { value: "30d", label: "30 days" },
        ]}
      />,
    );
    const active = screen.getByRole("tab", { name: "7 days" });
    expect(active.getAttribute("aria-selected")).toBe("true");
    await user.click(active);
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("30d");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "30 days" }));
  });

  it("keeps Home and End on the selected absolute endpoint", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SegmentedControl
        lensId="absolute-endpoints"
        label="Range"
        value="first"
        onChange={onChange}
        options={[
          { value: "first", label: "First" },
          { value: "middle", label: "Middle" },
          { value: "last", label: "Last" },
        ]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "First" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "First" }));
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <SegmentedControl
        lensId="absolute-endpoints"
        label="Range"
        value="last"
        onChange={onChange}
        options={[
          { value: "first", label: "First" },
          { value: "middle", label: "Middle" },
          { value: "last", label: "Last" },
        ]}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Last" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Last" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips disabled absolute endpoints", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SegmentedControl
        lensId="disabled-endpoints"
        label="Range"
        value="second"
        onChange={onChange}
        options={[
          { value: "first", label: "First", disabled: true },
          { value: "second", label: "Second" },
          { value: "third", label: "Third" },
          { value: "last", label: "Last", disabled: true },
        ]}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Second" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Second" }));
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Third" }));
    expect(onChange).toHaveBeenLastCalledWith("third");
  });

  it("moves focus into popovers and restores it on Escape", async () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open menu</button>
          <Popover open={open} onClose={() => setOpen(false)} label="Test menu">
            <button type="button">First action</button>
          </Popover>
        </>
      );
    }

    const user = userEvent.setup();
    render(<Fixture />);
    const trigger = screen.getByRole("button", { name: "Open menu" });
    await user.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "First action" })));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("supports icons, full-width layout, disabled options, and radio semantics", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <SegmentedControl
        lensId="provider"
        label="Provider"
        role="radiogroup"
        fill
        value="claude"
        onChange={onChange}
        options={[
          { value: "claude", label: "Claude", icon: <span>C</span> },
          { value: "codex", label: "Codex", disabled: true },
        ]}
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "Provider" });
    expect(group.classList.contains("is-fill")).toBe(true);
    expect(screen.getByRole("radio", { name: "Claude" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByRole("radio", { name: "Codex" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Claude" }));
    await user.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("registers the active segment immediately and releases its lens on unmount", () => {
    const registry = {
      updateAnchor: vi.fn(),
      removeAnchor: vi.fn(),
      requestRecapture: vi.fn(),
    };
    const { unmount } = render(
      <LiquidSelectionContext.Provider value={registry}>
        <SegmentedControl
          lensId="cleanup-control"
          label="Cleanup"
          value="one"
          onChange={() => undefined}
          options={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
          ]}
        />
      </LiquidSelectionContext.Provider>,
    );

    expect(registry.updateAnchor).toHaveBeenCalledWith(
      "cleanup-control",
      "segment",
      screen.getByRole("tab", { name: "One" }),
      false,
    );
    unmount();
    expect(registry.removeAnchor).toHaveBeenCalledWith("cleanup-control");
  });

  it("initializes once and enforces the persistent lens cap", async () => {
    render(
      <LiquidGlassProvider>
        <div className="app-shell">
          <span data-liquid-refresh-sentinel />
          {Array.from({ length: MAX_REAL_LENSES + 1 }, (_, index) => (
            <button key={index} className="liquid-gl-target">{index}</button>
          ))}
        </div>
      </LiquidGlassProvider>,
    );

    await waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll(".liquid-gl-target")).toHaveLength(MAX_REAL_LENSES);
    expect(document.querySelectorAll(".liquid-selection-lens")).toHaveLength(
      SEGMENT_LENS_SLOTS + 1,
    );
    document.querySelectorAll(".liquid-selection-lens").forEach((lens) => {
      expect(lens.classList.contains("liquid-gl-target")).toBe(true);
    });
    expect(mocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        target: ".liquid-gl-target",
        snapshot: ".app-shell",
        resolution: 2,
        refraction: 0.018,
        aberration: 0,
        bevelDepth: 0.07,
        bevelWidth: 0.12,
        frost: 0.15,
        magnify: 1.008,
        shadow: false,
        specular: false,
        reveal: "none",
        tilt: false,
      }),
    );
    expect(mocks.registerDynamic).toHaveBeenCalledWith(
      document.querySelector("[data-liquid-refresh-sentinel]"),
    );
  });

  it("disposes observers, timers, and frames across an HMR-equivalent remount", async () => {
    cleanup();
    mocks.initialize.mockClear();
    mocks.registerDynamic.mockClear();
    document.querySelectorAll("body > canvas[data-liquid-ignore]").forEach((node) => node.remove());

    const observerStates: Array<{
      callback: MutationCallback;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    class TestMutationObserver {
      private state: (typeof observerStates)[number];
      constructor(callback: MutationCallback) {
        this.state = { callback, disconnect: vi.fn() };
        observerStates.push(this.state);
      }
      observe() {}
      disconnect() {
        this.state.disconnect();
      }
      takeRecords() {
        return [];
      }
    }

    const originalMutationObserver = globalThis.MutationObserver;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    const frameCallbacks = new Map<number, FrameRequestCallback>();
    const cancelledFrames: number[] = [];
    let nextFrameId = 1;
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      cancelledFrames.push(id);
      frameCallbacks.delete(id);
    });
    mocks.initialize.mockImplementation(() => {
      if (!document.querySelector("body > canvas[data-liquid-ignore]")) {
        const canvas = document.createElement("canvas");
        canvas.setAttribute("data-liquid-ignore", "");
        document.body.appendChild(canvas);
      }
    });

    const renderProvider = () =>
      render(
        <LiquidGlassProvider>
          <div className="app-shell">
            <span data-liquid-refresh-sentinel />
            <button className="liquid-gl-target">Glass target</button>
          </div>
        </LiquidGlassProvider>,
      );

    const first = renderProvider();
    for (const [id, callback] of [...frameCallbacks]) {
      frameCallbacks.delete(id);
      callback(performance.now());
    }
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(observerStates).toHaveLength(2));

    observerStates[0].callback([], observerStates[0] as unknown as MutationObserver);
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    const pendingRecaptureFrames = [...frameCallbacks.keys()];
    expect(pendingRecaptureFrames).not.toHaveLength(0);
    first.unmount();
    expect(observerStates.slice(0, 2).every((state) => state.disconnect.mock.calls.length === 1)).toBe(true);
    expect(pendingRecaptureFrames.every((id) => cancelledFrames.includes(id))).toBe(true);

    const second = renderProvider();
    for (const [id, callback] of [...frameCallbacks]) {
      frameCallbacks.delete(id);
      callback(performance.now());
    }
    await vi.waitFor(() => expect(observerStates).toHaveLength(4));
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(observerStates.every((state) => state.disconnect.mock.calls.length === 1)).toBe(true);

    vi.stubGlobal("MutationObserver", originalMutationObserver);
    vi.stubGlobal("requestAnimationFrame", originalRequestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", originalCancelAnimationFrame);
    mocks.initialize.mockReset();
    document.querySelectorAll("body > canvas[data-liquid-ignore]").forEach((node) => node.remove());
  });
});
