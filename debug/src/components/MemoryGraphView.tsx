export interface MemoryVersionSummary {
  id?: string;
  version?: number | string;
  content?: string;
  status?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface MemoryExplorerItem {
  id: string;
  title?: string;
  content?: string;
  status?: string;
  current?: boolean;
  forgotten?: boolean;
  similarity?: number;
  version?: number | string;
  providerDocumentId?: string;
  providerMemoryId?: string;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
  history?: MemoryVersionSummary[];
}

function displayMetadata(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && typeof value !== "object")
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${String(value)}`);
}

function formatDate(value: number | undefined): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)
    : "Time unavailable";
}

export default function MemorySourceExplorer({
  items,
  isDark,
  emptyMessage,
}: {
  items: MemoryExplorerItem[];
  isDark: boolean;
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return (
      <div className={`px-5 py-12 text-center text-sm ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <ul className={`divide-y ${isDark ? "divide-white/10" : "divide-zinc-200"}`}>
      {items.map((item) => {
        const metadata = displayMetadata(item.metadata);
        const state = item.forgotten
          ? "Forgotten"
          : item.current === true
            ? "Current"
            : item.current === false
              ? "Previous version"
              : item.status || "State unavailable";
        return (
          <li key={item.id} className="min-w-0 px-5 py-4">
            <article>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className={`min-w-0 flex-1 truncate text-sm font-medium ${isDark ? "text-zinc-100" : "text-zinc-950"}`}>
                  {item.title || (item.providerDocumentId ? "Source document" : "Memory result")}
                </h3>
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    item.forgotten
                      ? isDark
                        ? "border-rose-400/20 bg-rose-400/10 text-rose-300"
                        : "border-rose-200 bg-rose-50 text-rose-700"
                      : item.current === false
                        ? isDark
                          ? "border-amber-400/20 bg-amber-400/10 text-amber-300"
                          : "border-amber-200 bg-amber-50 text-amber-700"
                        : item.current === true
                          ? isDark
                            ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : isDark
                            ? "border-white/10 bg-white/5 text-zinc-300"
                            : "border-zinc-200 bg-zinc-50 text-zinc-700"
                  }`}
                >
                  {state}
                </span>
              </div>

              {item.content && (
                <p dir="auto" className={`mt-2 break-words text-sm leading-relaxed ${isDark ? "text-zinc-300" : "text-zinc-700"}`}>
                  {item.content}
                </p>
              )}

              <dl className={`mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] ${isDark ? "text-zinc-500" : "text-zinc-500"}`}>
                {item.similarity !== undefined && (
                  <div className="flex gap-1">
                    <dt>Similarity</dt>
                    <dd className="mono">{item.similarity.toFixed(3)}</dd>
                  </div>
                )}
                {item.version !== undefined && (
                  <div className="flex gap-1">
                    <dt>Version</dt>
                    <dd className="mono">{String(item.version)}</dd>
                  </div>
                )}
                {item.updatedAt !== undefined && (
                  <div className="flex gap-1">
                    <dt>Updated</dt>
                    <dd>
                      <time>{formatDate(item.updatedAt)}</time>
                    </dd>
                  </div>
                )}
                {item.providerDocumentId && (
                  <div className="flex min-w-0 gap-1">
                    <dt>Document</dt>
                    <dd className="max-w-[300px] truncate mono" title={item.providerDocumentId}>
                      {item.providerDocumentId}
                    </dd>
                  </div>
                )}
                {item.providerMemoryId && (
                  <div className="flex min-w-0 gap-1">
                    <dt>Memory</dt>
                    <dd className="max-w-[300px] truncate mono" title={item.providerMemoryId}>
                      {item.providerMemoryId}
                    </dd>
                  </div>
                )}
              </dl>

              {metadata.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Source metadata">
                  {metadata.map((entry) => (
                    <span
                      key={entry}
                      className={`max-w-full truncate rounded-lg px-2 py-1 text-[10px] mono ${
                        isDark ? "bg-white/5 text-zinc-400" : "bg-zinc-100 text-zinc-600"
                      }`}
                      title={entry}
                    >
                      {entry}
                    </span>
                  ))}
                </div>
              )}

              {item.history && item.history.length > 0 && (
                <details className="mt-3">
                  <summary
                    className={`min-h-8 cursor-pointer rounded-lg px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                      isDark ? "text-zinc-400 hover:bg-white/5" : "text-zinc-600 hover:bg-zinc-100"
                    }`}
                  >
                    Version history · {item.history.length}
                  </summary>
                  <ol className="mt-2 space-y-2 ps-2">
                    {item.history.map((version, index) => (
                      <li
                        key={version.id ?? `${item.id}:version:${index}`}
                        className={`rounded-xl border p-3 text-xs ${
                          isDark ? "border-white/10 bg-black/20 text-zinc-300" : "border-zinc-200 bg-zinc-50 text-zinc-700"
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium">
                            Version {version.version ?? item.history!.length - index}
                            {version.status ? ` · ${version.status}` : ""}
                          </span>
                          <time className={isDark ? "text-zinc-500" : "text-zinc-500"}>
                            {formatDate(version.updatedAt ?? version.createdAt)}
                          </time>
                        </div>
                        {version.content && <p dir="auto" className="mt-1 break-words leading-relaxed">{version.content}</p>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
