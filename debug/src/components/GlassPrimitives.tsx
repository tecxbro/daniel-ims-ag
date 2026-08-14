import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useLiquidSelectionAnchor } from "../lib/liquidSelection.js";

export function GlassSurface({
  children,
  className = "",
  refractive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { refractive?: boolean }) {
  return (
    <div
      className={`glass-surface ${refractive ? "liquid-gl-host liquid-gl-target" : ""} ${className}`}
      data-liquid-ignore={refractive ? "" : undefined}
      {...props}
    >
      <div className="liquid-content">{children}</div>
    </div>
  );
}

export function GlassButton({
  children,
  className = "",
  refractive = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { refractive?: boolean }) {
  return (
    <button
      type="button"
      className={`glass-button ${refractive ? "liquid-gl-host liquid-gl-target" : ""} ${className}`}
      data-liquid-ignore={refractive ? "" : undefined}
      {...props}
    >
      <span className="liquid-content">{children}</span>
    </button>
  );
}

export function ToolbarButton({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <GlassButton refractive className={`toolbar-button ${className}`} {...props}>
      {children}
    </GlassButton>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function SegmentedControl<T extends string>({
  lensId,
  label,
  value,
  options,
  onChange,
  className = "",
  disabled = false,
  fill = false,
  role = "tablist",
}: {
  lensId: string;
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void | Promise<void>;
  className?: string;
  disabled?: boolean;
  fill?: boolean;
  role?: "tablist" | "radiogroup";
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const getActiveElement = useCallback(
    () => buttonRefs.current[activeIndex],
    [activeIndex],
  );
  useLiquidSelectionAnchor({
    id: lensId,
    kind: "segment",
    selectionKey: value,
    getElement: getActiveElement,
  });

  function isDisabled(index: number) {
    return disabled || Boolean(options[index]?.disabled);
  }

  function move(current: number, direction: number) {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const next = (current + direction * offset + options.length) % options.length;
      if (isDisabled(next) || options[next].value === value) continue;
      buttonRefs.current[next]?.focus();
      void onChange(options[next].value);
      return;
    }
  }

  return (
    <div
      className={`segmented-control glass-control ${fill ? "is-fill" : ""} ${className}`}
      role={role}
      aria-label={label}
      data-liquid-ignore=""
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttonRefs.current[index] = element;
          }}
          type="button"
          role={role === "tablist" ? "tab" : "radio"}
          aria-selected={role === "tablist" ? value === option.value : undefined}
          aria-checked={role === "radiogroup" ? value === option.value : undefined}
          tabIndex={value === option.value ? 0 : -1}
          className="segmented-button"
          data-active={value === option.value ? "true" : "false"}
          disabled={disabled || option.disabled}
          onClick={() => {
            if (value !== option.value) void onChange(option.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(-1, 1);
            } else if (event.key === "End") {
              event.preventDefault();
              move(0, -1);
            }
          }}
        >
          {option.icon && <span className="segmented-icon" aria-hidden="true">{option.icon}</span>}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StatusBadge({
  children,
  tone = "neutral",
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <span className={`status-badge status-${tone} ${className}`} {...props}>
      {children}
    </span>
  );
}

export function Popover({
  open,
  onClose,
  label,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      ref.current
        ?.querySelector<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        ?.focus();
    });
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div ref={ref} className={`glass-popover ${className}`} role="dialog" aria-label={label}>
      {children}
    </div>
  );
}

export function Inspector({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const titleId = useId();
  if (!open) return null;
  return (
    <aside className="glass-inspector" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="inspector-heading">
        <h2 id={titleId}>{title}</h2>
        <GlassButton onClick={onClose} aria-label={`Close ${title}`}>
          Close
        </GlassButton>
      </div>
      {children}
    </aside>
  );
}
