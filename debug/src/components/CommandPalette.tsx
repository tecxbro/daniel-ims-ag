import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { VIEW_DEFINITIONS, type ViewId } from "../lib/navigation.js";

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const normalized = query.trim().toLowerCase();
  const matches = VIEW_DEFINITIONS.filter((view) =>
    `${view.label} ${view.description} ${view.group}`.toLowerCase().includes(normalized),
  );

  return (
    <div className="command-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette glass-surface"
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="command-search">
          <HugeiconsIcon icon={Search01Icon} size={17} aria-hidden="true" />
          <span className="sr-only">Search commands</span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Go to a dashboard view…"
            autoComplete="off"
          />
          <kbd>esc</kbd>
        </label>
        <div className="command-results" role="listbox" aria-label="Dashboard views">
          {matches.map((view, index) => (
            <button
              key={view.id}
              type="button"
              role="option"
              aria-selected={index === 0}
              onClick={() => {
                onNavigate(view.id);
                onClose();
              }}
            >
              <span className="command-result-icon">
                <HugeiconsIcon icon={view.icon} size={17} aria-hidden="true" />
              </span>
              <span>
                <strong>{view.label}</strong>
                <small>{view.description}</small>
              </span>
              <kbd>{view.shortcut}</kbd>
            </button>
          ))}
          {matches.length === 0 && <p className="command-empty">No matching commands</p>}
        </div>
      </div>
    </div>
  );
}
