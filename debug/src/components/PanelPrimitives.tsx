import type { ReactNode } from "react";

export function panelCardClass(isDark: boolean, extra = "") {
  void isDark;
  return `panel-card-motion rounded-[14px] ${extra}`;
}

export function subtlePanelClass(isDark: boolean, extra = "") {
  void isDark;
  return `subtle-panel rounded-xl border ${extra}`;
}

export function mutedTextClass(isDark: boolean) {
  return isDark ? "text-zinc-500" : "text-zinc-400";
}

export function bodyTextClass(isDark: boolean) {
  return isDark ? "text-zinc-300" : "text-zinc-700";
}

export function PanelPage({
  eyebrow,
  title,
  description,
  stat,
  action,
  children,
  maxWidth = "max-w-[1040px]",
}: {
  eyebrow: string;
  title: string;
  description: string;
  stat?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  maxWidth?: string;
}) {
  return (
    <section
      className={`panel-page mx-auto ${maxWidth} space-y-4 pb-10`}
      aria-label={`${eyebrow}: ${title}. ${description}`}
    >
      {(stat || action) && (
        <div className="panel-page-actions flex items-center justify-end gap-2">
          {stat}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function HeaderPill({
  children,
  isDark,
  className = "",
}: {
  children: ReactNode;
  isDark: boolean;
  className?: string;
}) {
  return (
    <span
      className={`status-badge inline-flex w-fit items-center whitespace-nowrap mono ${className}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  children,
  isDark,
}: {
  children: ReactNode;
  isDark: boolean;
}) {
  return (
    <div className={subtlePanelClass(isDark, "px-4 py-10 text-center text-sm text-zinc-500")}>
      {children}
    </div>
  );
}
