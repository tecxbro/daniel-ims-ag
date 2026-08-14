import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { LiquidGL } from "liquid-gl";
import {
  LiquidSelectionContext,
  type LiquidSelectionKind,
  type LiquidSelectionRegistry,
} from "../lib/liquidSelection.js";
import {
  BALANCED_SPRING,
  directionalSpringParameters,
  springEdgeSettled,
  stepSpringEdge,
  type SpringParameters,
} from "../lib/liquidSelectionMotion.js";

const MAX_REAL_LENSES = 16;
const SEGMENT_LENS_SLOTS = 2;
const OFFSCREEN_EDGE = -64;
const MAX_SPRING_DURATION_MS = 420;

interface DynamicLiquidGL extends LiquidGL {
  unregisterDynamic?: (elements: Element | Element[]) => void;
}

type EdgeName = "left" | "right" | "top" | "bottom";
type EdgeMotion = { value: number; velocity: number; target: number };

interface LensMotion {
  element: HTMLElement | null;
  visible: boolean;
  rafId: number | null;
  startedAt: number;
  lastFrameAt: number;
  edges: Record<EdgeName, EdgeMotion>;
  parameters: Record<EdgeName, SpringParameters>;
}

interface AnchorRegistration {
  kind: LiquidSelectionKind;
  slot: number;
}

function media(query: string) {
  return window.matchMedia(query);
}

function createEdge(): EdgeMotion {
  return { value: OFFSCREEN_EDGE, velocity: 0, target: OFFSCREEN_EDGE };
}

function createLensMotion(): LensMotion {
  return {
    element: null,
    visible: false,
    rafId: null,
    startedAt: 0,
    lastFrameAt: 0,
    edges: {
      left: createEdge(),
      right: { value: OFFSCREEN_EDGE + 1, velocity: 0, target: OFFSCREEN_EDGE + 1 },
      top: createEdge(),
      bottom: { value: OFFSCREEN_EDGE + 1, velocity: 0, target: OFFSCREEN_EDGE + 1 },
    },
    parameters: {
      left: BALANCED_SPRING,
      right: BALANCED_SPRING,
      top: BALANCED_SPRING,
      bottom: BALANCED_SPRING,
    },
  };
}

function cancelMotion(motion: LensMotion) {
  if (motion.rafId !== null) cancelAnimationFrame(motion.rafId);
  motion.rafId = null;
}

function applyMotionRect(motion: LensMotion) {
  if (!motion.element) return;
  const { left, right, top, bottom } = motion.edges;
  motion.element.style.left = `${left.value.toFixed(3)}px`;
  motion.element.style.top = `${top.value.toFixed(3)}px`;
  motion.element.style.width = `${Math.max(1, right.value - left.value).toFixed(3)}px`;
  motion.element.style.height = `${Math.max(1, bottom.value - top.value).toFixed(3)}px`;
}

function snapMotion(motion: LensMotion, rect?: DOMRect) {
  cancelMotion(motion);
  const values = rect
    ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    : {
        left: OFFSCREEN_EDGE,
        right: OFFSCREEN_EDGE + 1,
        top: OFFSCREEN_EDGE,
        bottom: OFFSCREEN_EDGE + 1,
      };
  (Object.keys(values) as EdgeName[]).forEach((name) => {
    motion.edges[name].value = values[name];
    motion.edges[name].target = values[name];
    motion.edges[name].velocity = 0;
  });
  motion.visible = Boolean(rect);
  applyMotionRect(motion);
}

function animateMotionTo(motion: LensMotion, rect: DOMRect, animate: boolean) {
  if (rect.width <= 0 || rect.height <= 0) {
    snapMotion(motion);
    return;
  }

  if (!motion.visible || !animate || media("(prefers-reduced-motion: reduce)").matches) {
    snapMotion(motion, rect);
    return;
  }

  const currentHorizontalCenter = (motion.edges.left.value + motion.edges.right.value) / 2;
  const currentVerticalCenter = (motion.edges.top.value + motion.edges.bottom.value) / 2;
  const horizontal = directionalSpringParameters(
    currentHorizontalCenter,
    rect.left + rect.width / 2,
  );
  const vertical = directionalSpringParameters(
    currentVerticalCenter,
    rect.top + rect.height / 2,
  );
  motion.parameters = {
    left: horizontal.low,
    right: horizontal.high,
    top: vertical.low,
    bottom: vertical.high,
  };
  motion.edges.left.target = rect.left;
  motion.edges.right.target = rect.right;
  motion.edges.top.target = rect.top;
  motion.edges.bottom.target = rect.bottom;
  motion.startedAt = performance.now();
  motion.lastFrameAt = motion.startedAt;

  if (motion.rafId !== null) return;

  const tick = (timestamp: number) => {
    const elapsed = timestamp - motion.startedAt;
    const deltaSeconds = Math.min(
      1 / 30,
      Math.max(1 / 240, (timestamp - motion.lastFrameAt) / 1000),
    );
    motion.lastFrameAt = timestamp;

    (Object.keys(motion.edges) as EdgeName[]).forEach((name) => {
      motion.edges[name] = stepSpringEdge(
        motion.edges[name],
        motion.parameters[name],
        deltaSeconds,
      );
    });
    applyMotionRect(motion);

    const settled = (Object.keys(motion.edges) as EdgeName[]).every((name) =>
      springEdgeSettled(motion.edges[name]),
    );
    if (settled || elapsed >= MAX_SPRING_DURATION_MS) {
      const targetRect = new DOMRect(
        motion.edges.left.target,
        motion.edges.top.target,
        motion.edges.right.target - motion.edges.left.target,
        motion.edges.bottom.target - motion.edges.top.target,
      );
      snapMotion(motion, targetRect);
      return;
    }
    motion.rafId = requestAnimationFrame(tick);
  };

  motion.rafId = requestAnimationFrame(tick);
}

export class LiquidGlassController {
  private appearanceObserver: MutationObserver | null = null;
  private shellObserver: MutationObserver | null = null;
  private api: DynamicLiquidGL | null = null;
  private initialization: Promise<void> | null = null;
  private recaptureTimer: number | null = null;
  private recaptureFrame: number | null = null;
  private initializationFrame: number | null = null;
  private resolveInitializationFrame: (() => void) | null = null;
  private dynamicElements = new Set<Element>();
  private disposed = false;

  get isDisposed() {
    return this.disposed;
  }

  requestSnapshotRecapture = (delayMs = 0) => {
    if (this.disposed || !this.api) return;
    if (this.recaptureTimer !== null) window.clearTimeout(this.recaptureTimer);
    this.recaptureTimer = window.setTimeout(() => {
      this.recaptureTimer = null;
      if (this.disposed) return;
      this.recaptureFrame = requestAnimationFrame(() => {
        this.recaptureFrame = null;
        if (this.disposed || !this.api) return;
        const sentinel = document.querySelector("[data-liquid-refresh-sentinel]");
        if (sentinel) this.registerDynamic(sentinel);
        // liquidGL's resize hook is its reliable full-texture refresh path.
        window.dispatchEvent(new Event("resize"));
      });
    }, Math.max(0, delayMs));
  };

  private registerDynamic(element: Element) {
    if (this.disposed || !this.api) return;
    this.api.registerDynamic(element);
    this.dynamicElements.add(element);
  }

  private observeSnapshotChanges() {
    if (this.disposed) return;
    this.appearanceObserver?.disconnect();
    this.appearanceObserver = new MutationObserver(() => this.requestSnapshotRecapture(32));
    this.appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    this.shellObserver?.disconnect();
    const shell = document.querySelector(".app-shell");
    if (shell) {
      this.shellObserver = new MutationObserver(() => this.requestSnapshotRecapture(260));
      this.shellObserver.observe(shell, {
        attributes: true,
        attributeFilter: [
          "data-view",
          "data-sidebar-collapsed",
          "data-mobile-nav-open",
        ],
      });
    }
  }

  private nextAnimationFrame() {
    return new Promise<void>((resolve) => {
      this.resolveInitializationFrame = resolve;
      this.initializationFrame = requestAnimationFrame(() => {
        this.initializationFrame = null;
        this.resolveInitializationFrame = null;
        resolve();
      });
    });
  }

  initialize() {
    if (this.disposed || media("(prefers-reduced-transparency: reduce)").matches) {
      return Promise.resolve();
    }
    if (this.initialization) return this.initialization;

    this.initialization = this.initializeOnce().catch((error) => {
      if (this.disposed) return;
      this.api = null;
      this.initialization = null;
      document.documentElement.classList.add("liquid-gl-unavailable");
      console.warn("liquidGL failed to initialize; using CSS materials instead.", error);
    });
    return this.initialization;
  }

  private async initializeOnce() {
    const targets = Array.from(document.querySelectorAll(".liquid-gl-target"));
    if (targets.length === 0) return;
    if (targets.length > MAX_REAL_LENSES) {
      console.warn(
        `liquidGL: ${targets.length} targets found; only the first ${MAX_REAL_LENSES} are enabled.`,
      );
      const prioritizedTargets = [...targets].sort((left, right) => {
        const leftPersistent = left.hasAttribute("data-liquid-lens") ? 1 : 0;
        const rightPersistent = right.hasAttribute("data-liquid-lens") ? 1 : 0;
        return rightPersistent - leftPersistent;
      });
      const enabledTargets = new Set(prioritizedTargets.slice(0, MAX_REAL_LENSES));
      targets.forEach((node) => {
        if (!enabledTargets.has(node)) node.classList.remove("liquid-gl-target");
      });
    }

    if ("fonts" in document) await document.fonts.ready;
    if (this.disposed) return;
    await this.nextAnimationFrame();
    if (this.disposed) return;

    const { default: liquidGL } = await import("liquid-gl");
    if (this.disposed) return;
    this.api = liquidGL as DynamicLiquidGL;

    if (document.querySelector("body > canvas[data-liquid-ignore]")) {
      document.documentElement.classList.add("liquid-gl-ready");
      this.observeSnapshotChanges();
      this.requestSnapshotRecapture(0);
      return;
    }

    liquidGL({
      snapshot: ".app-shell",
      target: ".liquid-gl-target",
      resolution: 2,
      refraction: 0.018,
      aberration: 0,
      bevelDepth: 0.07,
      bevelWidth: 0.12,
      frost: 0.15,
      shadow: false,
      specular: false,
      reveal: "none",
      tilt: false,
      magnify: 1.008,
      on: {
        init: () => {
          if (this.disposed) return;
          document.documentElement.classList.remove(
            "liquid-gl-fallback",
            "liquid-gl-unavailable",
          );
          document.documentElement.classList.add("liquid-gl-ready");
        },
      },
    });

    if (this.disposed) return;
    if (!document.querySelector("body > canvas[data-liquid-ignore]")) {
      document.documentElement.classList.add("liquid-gl-fallback");
    }

    const sentinel = document.querySelector("[data-liquid-refresh-sentinel]");
    if (sentinel) this.registerDynamic(sentinel);
    this.observeSnapshotChanges();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.appearanceObserver?.disconnect();
    this.shellObserver?.disconnect();
    this.appearanceObserver = null;
    this.shellObserver = null;
    if (this.recaptureTimer !== null) window.clearTimeout(this.recaptureTimer);
    if (this.recaptureFrame !== null) cancelAnimationFrame(this.recaptureFrame);
    if (this.initializationFrame !== null) cancelAnimationFrame(this.initializationFrame);
    this.resolveInitializationFrame?.();
    this.recaptureTimer = null;
    this.recaptureFrame = null;
    this.initializationFrame = null;
    this.resolveInitializationFrame = null;
    if (this.api?.unregisterDynamic) {
      this.api.unregisterDynamic([...this.dynamicElements]);
    }
    this.dynamicElements.clear();
    this.api = null;
    this.initialization = null;
  }
}

export function LiquidGlassProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<LiquidGlassController | null>(null);
  const navigationMotionRef = useRef<LensMotion>(createLensMotion());
  const segmentMotionsRef = useRef<LensMotion[]>(
    Array.from({ length: SEGMENT_LENS_SLOTS }, createLensMotion),
  );
  const registrationsRef = useRef(new Map<string, AnchorRegistration>());

  const getController = useCallback(() => {
    if (!controllerRef.current || controllerRef.current.isDisposed) {
      controllerRef.current = new LiquidGlassController();
    }
    return controllerRef.current;
  }, []);

  const requestRecapture = useCallback(
    (delayMs = 0) => getController().requestSnapshotRecapture(delayMs),
    [getController],
  );

  const setNavigationLens = useCallback((element: HTMLSpanElement | null) => {
    navigationMotionRef.current.element = element;
    applyMotionRect(navigationMotionRef.current);
  }, []);

  const setSegmentLens = useCallback((slot: number, element: HTMLSpanElement | null) => {
    const motion = segmentMotionsRef.current[slot];
    motion.element = element;
    applyMotionRect(motion);
  }, []);

  const removeAnchor = useCallback((id: string) => {
    const registration = registrationsRef.current.get(id);
    if (!registration) return;
    const motion =
      registration.kind === "navigation"
        ? navigationMotionRef.current
        : segmentMotionsRef.current[registration.slot];
    snapMotion(motion);
    registrationsRef.current.delete(id);
  }, []);

  const updateAnchor = useCallback(
    (id: string, kind: LiquidSelectionKind, element: HTMLElement, animate: boolean) => {
      let registration = registrationsRef.current.get(id);
      if (registration && registration.kind !== kind) {
        removeAnchor(id);
        registration = undefined;
      }

      if (!registration) {
        if (kind === "navigation") {
          const previousNavigation = [...registrationsRef.current.entries()].find(
            ([, value]) => value.kind === "navigation",
          );
          if (previousNavigation) removeAnchor(previousNavigation[0]);
          registration = { kind, slot: 0 };
        } else {
          const occupied = new Set(
            [...registrationsRef.current.values()]
              .filter((value) => value.kind === "segment")
              .map((value) => value.slot),
          );
          const slot = Array.from({ length: SEGMENT_LENS_SLOTS }, (_, index) => index).find(
            (index) => !occupied.has(index),
          );
          if (slot === undefined) {
            console.warn(
              `liquidGL: no persistent segmented-control lens is available for '${id}'.`,
            );
            return;
          }
          registration = { kind, slot };
        }
        registrationsRef.current.set(id, registration);
      }

      const motion =
        registration.kind === "navigation"
          ? navigationMotionRef.current
          : segmentMotionsRef.current[registration.slot];
      animateMotionTo(motion, element.getBoundingClientRect(), animate);
    },
    [removeAnchor],
  );

  const registry = useMemo<LiquidSelectionRegistry>(
    () => ({
      updateAnchor,
      removeAnchor,
      requestRecapture,
    }),
    [removeAnchor, requestRecapture, updateAnchor],
  );

  useEffect(() => {
    const controller = getController();
    const transparency = media("(prefers-reduced-transparency: reduce)");
    const motion = media("(prefers-reduced-motion: reduce)");

    const updatePreferences = () => {
      document.documentElement.classList.toggle("reduce-transparency", transparency.matches);
      document.documentElement.classList.toggle("reduce-motion", motion.matches);
      if (motion.matches) {
        const motions = [navigationMotionRef.current, ...segmentMotionsRef.current];
        motions.forEach((lensMotion) => {
          if (!lensMotion.visible) return;
          const { left, right, top, bottom } = lensMotion.edges;
          snapMotion(
            lensMotion,
            new DOMRect(
              left.target,
              top.target,
              right.target - left.target,
              bottom.target - top.target,
            ),
          );
        });
      }
      if (!transparency.matches) void controller.initialize();
    };

    updatePreferences();
    transparency.addEventListener("change", updatePreferences);
    motion.addEventListener("change", updatePreferences);
    return () => {
      transparency.removeEventListener("change", updatePreferences);
      motion.removeEventListener("change", updatePreferences);
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      cancelMotion(navigationMotionRef.current);
      segmentMotionsRef.current.forEach(cancelMotion);
      registrationsRef.current.clear();
      document.documentElement.classList.remove("reduce-transparency", "reduce-motion");
    };
  }, [getController]);

  const lensLayer =
    typeof document === "undefined"
      ? null
      : createPortal(
          <div className="liquid-selection-layer" aria-hidden="true" data-liquid-ignore="">
            <span
              ref={setNavigationLens}
              className="liquid-selection-lens liquid-navigation-lens liquid-gl-target"
              data-liquid-lens="navigation"
              data-liquid-ignore=""
            />
            {Array.from({ length: SEGMENT_LENS_SLOTS }, (_, slot) => (
              <span
                key={slot}
                ref={(element) => setSegmentLens(slot, element)}
                className="liquid-selection-lens liquid-segment-lens liquid-gl-target"
                data-liquid-lens={`segment-${slot}`}
                data-liquid-ignore=""
              />
            ))}
          </div>,
          document.body,
        );

  return (
    <LiquidSelectionContext.Provider value={registry}>
      {children}
      {lensLayer}
    </LiquidSelectionContext.Provider>
  );
}

export { MAX_REAL_LENSES, SEGMENT_LENS_SLOTS };
