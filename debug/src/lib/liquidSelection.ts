import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

export type LiquidSelectionKind = "navigation" | "segment";

export interface LiquidSelectionRegistry {
  updateAnchor(
    id: string,
    kind: LiquidSelectionKind,
    element: HTMLElement,
    animate: boolean,
  ): void;
  removeAnchor(id: string): void;
  requestRecapture(delayMs?: number): void;
}

const inertRegistry: LiquidSelectionRegistry = {
  updateAnchor: () => undefined,
  removeAnchor: () => undefined,
  requestRecapture: () => undefined,
};

export const LiquidSelectionContext = createContext<LiquidSelectionRegistry>(inertRegistry);

export function useLiquidSelectionRegistry() {
  return useContext(LiquidSelectionContext);
}

export function useLiquidSelectionAnchor({
  id,
  kind,
  selectionKey,
  layoutKey,
  getElement,
}: {
  id: string;
  kind: LiquidSelectionKind;
  selectionKey: string | number;
  layoutKey?: string | number;
  getElement: () => HTMLElement | null;
}) {
  const registry = useLiquidSelectionRegistry();
  const mountedRef = useRef(false);
  const previousSelectionRef = useRef(selectionKey);

  useLayoutEffect(() => {
    const element = getElement();
    if (!element) return;

    const animate =
      mountedRef.current && previousSelectionRef.current !== selectionKey;
    registry.updateAnchor(id, kind, element, animate);

    if (!mountedRef.current) registry.requestRecapture(80);
    mountedRef.current = true;
    previousSelectionRef.current = selectionKey;
  }, [getElement, id, kind, registry, selectionKey]);

  useLayoutEffect(
    () => () => {
      registry.removeAnchor(id);
    },
    [id, registry],
  );

  useLayoutEffect(() => {
    if (layoutKey === undefined) return;
    const snap = () => {
      const element = getElement();
      if (element) registry.updateAnchor(id, kind, element, false);
    };
    const frame = requestAnimationFrame(snap);
    const settledTimer = window.setTimeout(() => {
      snap();
      registry.requestRecapture(0);
    }, 260);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settledTimer);
    };
  }, [getElement, id, kind, layoutKey, registry]);

  useLayoutEffect(() => {
    const element = getElement();
    if (!element) return;

    const snapToElement = () => registry.updateAnchor(id, kind, element, false);
    let resizeDelivered = false;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (!resizeDelivered) {
              resizeDelivered = true;
              return;
            }
            snapToElement();
          });
    resizeObserver?.observe(element);

    window.addEventListener("scroll", snapToElement, true);
    window.addEventListener("resize", snapToElement);
    window.visualViewport?.addEventListener("resize", snapToElement);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("scroll", snapToElement, true);
      window.removeEventListener("resize", snapToElement);
      window.visualViewport?.removeEventListener("resize", snapToElement);
    };
  }, [getElement, id, kind, registry, selectionKey]);
}

export type LiquidSelectionProviderProps = {
  value: LiquidSelectionRegistry;
  children: ReactNode;
};
